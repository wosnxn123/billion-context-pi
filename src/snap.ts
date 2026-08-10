// Snap channel: cold-archive compressed-block summaries as bitmap frames
// (official-snapcompact-aligned rebuild) or, for text-only models, fall back
// to tier-2 distillation directives. The adapter owns all I/O; the kernel
// stays pure.
import type { CompressionBlock, CompressionState, CoreMessage } from "acp-kernel";
import {
  archiveBlocks,
  buildSnapMessage,
  gcManifest,
  loadManifest,
  saveManifest,
  DEFAULT_MAX_FRAMES,
  MAX_FRAMES_HARD,
  isShapeVariantName,
  type BlockSnapshot,
  type ShapeVariantName,
  type ShapeTarget,
  type SnapManifest,
  type SnapUserMessage,
  serializeCore,
} from "./snapcompact.js";

/** Minimal shape: pi AgentSessionModel exposes `input: string[]`. */
export interface VisionModelLike {
  input?: string[];
}

export interface SnapSettings {
  mode: "auto" | "on" | "off";
  variant?: ShapeVariantName;
  maxFrames: number;
  /** Newest N active blocks stay hot text; older ones are snap candidates. */
  hotBlocks: number;
  /** Auto-snap fires when unsnapped cold summaries sum to >= this many tokens. */
  thresholdTokens: number;
  midTurnEnabled: boolean;
  idleEnabled: boolean;
  idleTimeoutSeconds: number;
  /** Idle snap only runs when last observed usage >= this many tokens. */
  idleThresholdTokens: number;
}

const DEFAULTS: Omit<SnapSettings, "mode"> = {
  maxFrames: DEFAULT_MAX_FRAMES,
  hotBlocks: 6,
  thresholdTokens: 8000,
  midTurnEnabled: true,
  idleEnabled: false,
  idleTimeoutSeconds: 300,
  idleThresholdTokens: 200000,
};

/** Env ACP_SNAPCOMPACT=off|force overrides the configured mode (matches the
 *  official escape hatch). */
export function resolveSnapSettings(
  adapterConfig: object,
  env: NodeJS.ProcessEnv = process.env,
): SnapSettings {
  const adapter = adapterConfig as Record<string, unknown>;
  const raw = adapter.snapcompact;
  let mode: SnapSettings["mode"] =
    raw === "on" || raw === "off" ? raw : "auto";
  const envMode = env.ACP_SNAPCOMPACT;
  if (envMode === "off") mode = "off";
  else if (envMode === "force") mode = "on";
  const maxFrames = Math.min(
    typeof adapter.snapcompactMaxFrames === "number" && adapter.snapcompactMaxFrames > 0
      ? adapter.snapcompactMaxFrames
      : DEFAULTS.maxFrames,
    MAX_FRAMES_HARD,
  );
  return {
    mode,
    variant: isShapeVariantName(adapter.snapcompactVariant) ? adapter.snapcompactVariant : undefined,
    maxFrames,
    hotBlocks:
      typeof adapter.snapHotBlocks === "number" && adapter.snapHotBlocks >= 0
        ? adapter.snapHotBlocks
        : DEFAULTS.hotBlocks,
    thresholdTokens:
      typeof adapter.snapThresholdTokens === "number" && adapter.snapThresholdTokens > 0
        ? adapter.snapThresholdTokens
        : DEFAULTS.thresholdTokens,
    midTurnEnabled:
      typeof adapter.snapMidTurnEnabled === "boolean"
        ? adapter.snapMidTurnEnabled
        : DEFAULTS.midTurnEnabled,
    idleEnabled:
      typeof adapter.snapIdleEnabled === "boolean"
        ? adapter.snapIdleEnabled
        : DEFAULTS.idleEnabled,
    idleTimeoutSeconds:
      typeof adapter.snapIdleTimeoutSeconds === "number" && adapter.snapIdleTimeoutSeconds > 0
        ? adapter.snapIdleTimeoutSeconds
        : DEFAULTS.idleTimeoutSeconds,
    idleThresholdTokens:
      typeof adapter.snapIdleThresholdTokens === "number" && adapter.snapIdleThresholdTokens > 0
        ? adapter.snapIdleThresholdTokens
        : DEFAULTS.idleThresholdTokens,
  };
}

export function hasVision(model?: VisionModelLike): boolean {
  return model?.input?.includes("image") ?? false;
}

/** Whether the PNG path may run at all. "on" without a vision model still
 *  returns true — callers dispatch to the text fallback when !hasVision. */
export function snapEnabled(settings: SnapSettings, model?: VisionModelLike): boolean {
  if (settings.mode === "off") return false;
  if (settings.mode === "on") return true;
  return hasVision(model);
}

export function summaryTokens(blocks: CompressionBlock[]): number {
  return blocks.reduce((sum, b) => sum + Math.ceil((b.summary || "").length / 4), 0);
}

/** Active blocks oldest-first. */
export function activeByAge(state: CompressionState): CompressionBlock[] {
  return state.blocks
    .filter((b) => b.active)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Cold = active blocks outside the hot window (newest hotBlocks stay text). */
export function coldBlocks(state: CompressionState, settings: SnapSettings): CompressionBlock[] {
  const active = activeByAge(state);
  if (active.length <= settings.hotBlocks) return [];
  return active.slice(0, active.length - settings.hotBlocks);
}

/** Cold blocks not yet rendered into frames. */
export function unsnappedCold(state: CompressionState, manifest: SnapManifest, settings: SnapSettings): CompressionBlock[] {
  return coldBlocks(state, settings).filter((b) => !manifest.archivedIds.includes(b.blockId));
}

/** Quality gate: auto-snap only when pending cold summaries are worth a
 *  render pass. Returns the blocks to snap, or null when under threshold. */
export function autoSnapCandidates(
  state: CompressionState,
  manifest: SnapManifest,
  settings: SnapSettings,
): CompressionBlock[] | null {
  const pending = unsnappedCold(state, manifest, settings);
  if (pending.length === 0) return null;
  if (summaryTokens(pending) < settings.thresholdTokens) return null;
  return pending;
}

/** Blocks whose summaries are already imaged AND still active — their anchor
 *  compress tool-calls must be hidden so the summary text is not duplicated
 *  beside its frame. */
export function snappedView(state: CompressionState, manifest: SnapManifest): {
  blockIds: Set<string>;
  callIds: Set<string>;
} {
  const blockIds = new Set<string>();
  const callIds = new Set<string>();
  for (const b of state.blocks) {
    if (!b.active) continue;
    if (!manifest.archivedIds.includes(b.blockId)) continue;
    blockIds.add(b.blockId);
    if (b.compressCallId) callIds.add(b.compressCallId);
  }
  return { blockIds, callIds };
}

/** Load, GC (drop batches whose blocks were consumed/deactivated), and cap.
 *  Cheap enough to run on every context event; only writes when changed. */
export function pruneManifest(
  sessionFile: string,
  state: CompressionState,
  settings: SnapSettings,
): SnapManifest {
  const loaded = loadManifest(sessionFile);
  if (!loaded.batches || loaded.batches.length === 0) return loaded;
  const activeIds = new Set(state.blocks.filter((b) => b.active).map((b) => b.blockId));
  const pruned = gcManifest(loaded, activeIds, settings.maxFrames);
  const changed =
    pruned.frames.length !== loaded.frames.length ||
    (pruned.batches?.length ?? 0) !== (loaded.batches?.length ?? 0);
  if (changed) saveManifest(sessionFile, pruned);
  return pruned;
}

export interface SnapRunResult {
  manifest: SnapManifest;
  added: number;
  blocks: BlockSnapshot[];
}

/** Build renderable snapshots: official-style scoped serialization of each
 *  block's original messages when available (frames then read like official
 *  archives), plain summary otherwise (idle maintenance has no messages). */
export function snapshotBlocks(
  blocks: CompressionBlock[],
  coreMessages: CoreMessage[] | null,
): BlockSnapshot[] {
  if (!coreMessages || coreMessages.length === 0) {
    return blocks.map((b) => ({ blockId: b.blockId, tier: b.tier, topic: b.topic, summary: b.summary }));
  }
  return blocks.map((b) => {
    const ids = new Set(b.effectiveMessageIds);
    const msgs = coreMessages.filter((m) => ids.has(m.id));
    return {
      blockId: b.blockId,
      tier: b.tier,
      topic: b.topic,
      summary: b.summary,
      source: msgs.length > 0 ? serializeCore(msgs) : undefined,
    };
  });
}

/** Render the given snapshots into frames (vision path). */
export async function runSnap(options: {
  sessionFile: string;
  manifest: SnapManifest;
  blocks: BlockSnapshot[];
  settings: SnapSettings;
  model?: ShapeTarget;
}): Promise<SnapRunResult> {
  const { sessionFile, manifest, blocks, settings, model } = options;
  const result = await archiveBlocks({
    sessionFile,
    blocks,
    manifest,
    model,
    variant: settings.variant,
    maxFrames: settings.maxFrames,
  });
  return { manifest: result.manifest, added: result.added, blocks };
}

export function snapAttachment(manifest: SnapManifest): SnapUserMessage | undefined {
  return buildSnapMessage(manifest);
}

/** Text-model fallback (/acp-snap on a non-vision model): direct the model to
 *  run tier-2 distillation over the cold blocks right now. */
export function distillDirective(blocks: CompressionBlock[]): string {
  const ids = blocks.map((b) => b.blockId);
  const first = ids[0];
  const last = ids[ids.length - 1];
  return [
    "[ACP SNAP — TEXT FALLBACK] This model has no vision, so cold blocks cannot be imaged.",
    `Distill the ${blocks.length} oldest compressed blocks into ONE tier-2 block RIGHT NOW:`,
    `compress({ content: [{ startId: "${first}", endId: "${last}", summary: "<dense tier-2 distillation per the TIER 2 rules>" }] })`,
    "Blocks to distill (oldest first): " + ids.join(", "),
    "Keep decisions, exact paths/values, and lessons; drop process. Do not do anything else first.",
  ].join("\n");
}

/** Manual /compact restoration: force the model to compress everything
 *  compressible immediately (plugin compression stays model-driven). */
export function compactDirective(): string {
  return [
    "[ACP MANUAL COMPACT] The user invoked manual compaction.",
    "Compress ALL compressible ranges NOW in one compress call (multiple content entries for unrelated ranges, each with its own topic).",
    "Follow the standard compression rules; do not do anything else first.",
  ].join("\n");
}
