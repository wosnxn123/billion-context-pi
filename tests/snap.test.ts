import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInitialState, type CompressionBlock, type CompressionState } from "acp-kernel";
import {
  archiveBlocks,
  buildSnapMessage,
  gcManifest,
  loadManifest,
  rebuildFramesFromBatches,
  saveManifest,
  serializeBlocks,
  emptyManifest,
  DEFAULT_MAX_FRAMES,
  type BlockSnapshot,
  type SnapManifest,
} from "../src/snapcompact.js";
import {
  autoSnapCandidates,
  coldBlocks,
  distillDirective,
  hasVision,
  resolveSnapSettings,
  snapEnabled,
  snappedView,
  summaryTokens,
  unsnappedCold,
} from "../src/snap.js";
import { coreOutToAgentMessages } from "../src/messages.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpSnapDir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpSnapDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-test-"));
  prevEnv = process.env.ACP_SNAP_DIR;
  process.env.ACP_SNAP_DIR = tmpSnapDir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.ACP_SNAP_DIR;
  else process.env.ACP_SNAP_DIR = prevEnv;
  fs.rmSync(tmpSnapDir, { recursive: true, force: true });
});

function block(id: string, overrides: Partial<CompressionBlock> = {}): CompressionBlock {
  return {
    blockId: id,
    runId: `run-${id}`,
    tier: 1,
    topic: `topic ${id}`,
    summary: `Summary of ${id}. `.repeat(40),
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    compressedTokens: 1000,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: 1,
    active: true,
    ...overrides,
  } as CompressionBlock;
}

function stateWith(blocks: CompressionBlock[]): CompressionState {
  const state = createInitialState();
  state.blocks = blocks;
  return state;
}

const settings = resolveSnapSettings({});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test("resolveSnapSettings defaults", () => {
  const s = resolveSnapSettings({});
  assert.equal(s.mode, "auto");
  assert.equal(s.maxFrames, DEFAULT_MAX_FRAMES);
  assert.equal(s.hotBlocks, 6);
  assert.equal(s.thresholdTokens, 8000);
  assert.equal(s.idleEnabled, false);
  assert.equal(s.idleThresholdTokens, 200000);
});

test("resolveSnapSettings reads adapter keys", () => {
  const s = resolveSnapSettings({
    snapcompact: "on",
    snapcompactMaxFrames: 5,
    snapHotBlocks: 2,
    snapThresholdTokens: 100,
    snapIdleEnabled: true,
  });
  assert.equal(s.mode, "on");
  assert.equal(s.maxFrames, 5);
  assert.equal(s.hotBlocks, 2);
  assert.equal(s.thresholdTokens, 100);
  assert.equal(s.idleEnabled, true);
});

test("resolveSnapSettings env override wins", () => {
  assert.equal(resolveSnapSettings({ snapcompact: "on" }, { ACP_SNAPCOMPACT: "off" }).mode, "off");
  assert.equal(resolveSnapSettings({ snapcompact: "off" }, { ACP_SNAPCOMPACT: "force" }).mode, "on");
});

test("snapEnabled gating", () => {
  const vision = { input: ["text", "image"] };
  const text = { input: ["text"] };
  assert.equal(snapEnabled({ ...settings, mode: "auto" }, vision), true);
  assert.equal(snapEnabled({ ...settings, mode: "auto" }, text), false);
  assert.equal(snapEnabled({ ...settings, mode: "on" }, text), true);
  assert.equal(snapEnabled({ ...settings, mode: "off" }, vision), false);
  assert.equal(hasVision(vision), true);
  assert.equal(hasVision(text), false);
  assert.equal(hasVision(undefined), false);
});

// ---------------------------------------------------------------------------
// Hot/cold selection + quality gate
// ---------------------------------------------------------------------------

test("coldBlocks keeps the newest hotBlocks as hot text", () => {
  const blocks = [block("b1"), block("b2"), block("b3"), block("b4")];
  blocks.forEach((b, i) => (b.createdAt = i));
  const state = stateWith(blocks);
  const cold = coldBlocks(state, { ...settings, hotBlocks: 2 });
  assert.deepEqual(cold.map((b) => b.blockId), ["b1", "b2"]);
});

test("coldBlocks empty when everything fits the hot window", () => {
  const state = stateWith([block("b1"), block("b2")]);
  assert.deepEqual(coldBlocks(state, { ...settings, hotBlocks: 6 }), []);
});

test("autoSnapCandidates enforces the quality threshold", () => {
  const blocks = [block("b1"), block("b2"), block("b3")];
  blocks.forEach((b, i) => (b.createdAt = i));
  const state = stateWith(blocks);
  const manifest = emptyManifest();
  const s = { ...settings, hotBlocks: 1, thresholdTokens: 10_000_000 };
  assert.equal(autoSnapCandidates(state, manifest, s), null, "under threshold → null");
  const s2 = { ...settings, hotBlocks: 1, thresholdTokens: 1 };
  const picked = autoSnapCandidates(state, manifest, s2);
  assert.ok(picked, "over threshold → candidates");
  assert.deepEqual(picked!.map((b) => b.blockId), ["b1", "b2"]);
});

test("unsnappedCold skips already-archived blocks", () => {
  const blocks = [block("b1"), block("b2"), block("b3")];
  blocks.forEach((b, i) => (b.createdAt = i));
  const state = stateWith(blocks);
  const manifest: SnapManifest = { frames: [], archivedIds: ["b1"], batches: [] };
  const pending = unsnappedCold(state, manifest, { ...settings, hotBlocks: 1 });
  assert.deepEqual(pending.map((b) => b.blockId), ["b2"]);
});

test("summaryTokens estimates chars/4", () => {
  const t = summaryTokens([block("b1")]);
  assert.ok(t > 0);
  assert.equal(t, Math.ceil("Summary of b1. ".repeat(40).length / 4));
});

// ---------------------------------------------------------------------------
// Archive + manifest lifecycle (real PNG render via pi-natives)
// ---------------------------------------------------------------------------

test("archiveBlocks renders frames, dedupes, and GC consumes dead batches", async () => {
  const sessionFile = path.join(tmpSnapDir, "session.jsonl");
  const b1 = block("b1");
  const b2 = block("b2");
  const toSnap = (b: CompressionBlock): BlockSnapshot => ({
    blockId: b.blockId,
    tier: b.tier,
    topic: b.topic,
    summary: b.summary,
  });

  const r1 = await archiveBlocks({
    sessionFile,
    blocks: [toSnap(b1), toSnap(b2)],
    manifest: emptyManifest(),
    maxFrames: 8,
  });
  assert.ok(r1.added > 0, "frames rendered");
  assert.deepEqual(r1.manifest.archivedIds, ["b1", "b2"]);
  assert.equal(r1.manifest.batches?.length, 1);
  const persisted = loadManifest(sessionFile);
  assert.deepEqual(persisted.archivedIds, ["b1", "b2"]);
  assert.equal(persisted.frames.length, r1.manifest.frames.length);

  // Re-archiving the same blocks is a no-op.
  const r2 = await archiveBlocks({
    sessionFile,
    blocks: [toSnap(b1), toSnap(b2)],
    manifest: r1.manifest,
    maxFrames: 8,
  });
  assert.equal(r2.added, 0);

  // Attachment carries image parts with base64 payloads.
  const msg = buildSnapMessage(r1.manifest);
  assert.ok(msg, "attachment built");
  assert.ok(msg!.content.some((p) => p.type === "image"));

  // Consuming b1+b2 (tier-2 distillation deactivates them) drops the batch.
  const gced = gcManifest(r1.manifest, new Set<string>(), 8);
  assert.equal(gced.frames.length, 0, "frames evicted with their batch");
  assert.equal(gced.batches?.length, 0);

  // Keeping b1 alive keeps the whole batch (frames hold both blocks).
  const kept = gcManifest(r1.manifest, new Set(["b1"]), 8);
  assert.equal(kept.frames.length, r1.manifest.frames.length);
});

test("rebuildFramesFromBatches applies the FIFO cap", async () => {
  const sessionFile = path.join(tmpSnapDir, "session2.jsonl");
  let manifest = emptyManifest();
  for (let i = 0; i < 4; i++) {
    const r = await archiveBlocks({
      sessionFile,
      blocks: [{ blockId: `b${i}`, tier: 1, summary: `Block ${i} content. `.repeat(60) }],
      manifest,
      maxFrames: 99,
    });
    manifest = r.manifest;
  }
  assert.equal(manifest.batches?.length, 4);
  const capped = rebuildFramesFromBatches(manifest, 2);
  assert.ok(capped.frames.length <= 2, "frame cap enforced");
  // Oldest batches lose all frames → dropped; newest survive.
  const lastBatch = capped.batches![capped.batches!.length - 1];
  assert.deepEqual(lastBatch.blockIds, ["b3"]);
});

test("serializeBlocks labels sections with block id and tier", () => {
  const text = serializeBlocks([
    { blockId: "b7", tier: 2, topic: "Auth", summary: "decided JWT" },
  ]);
  assert.ok(text.includes("[block b7 t2] Auth"));
  assert.ok(text.includes("decided JWT"));
});

// ---------------------------------------------------------------------------
// Snapped-view hiding in the context rebuild
// ---------------------------------------------------------------------------

test("coreOutToAgentMessages drops snapped anchor compress calls", () => {
  const coreOut = [
    { id: "m1", role: "user", text: "hello" },
    { id: "m2", role: "assistant", contentType: "tool-call", toolCallId: "call-keep", toolName: "read", toolArgs: "{}", text: "" },
    { id: "m3", role: "assistant", contentType: "tool-call", toolCallId: "call-snapped", toolName: "compress", toolArgs: "{}", text: "" },
  ];
  const originals = new Map<string, any>([
    ["m1", { role: "user", content: [{ type: "text", text: "hello" }] }],
    ["m2", { role: "assistant", content: [{ type: "toolCall", id: "call-keep", name: "read", arguments: {} }] }],
    ["m3", { role: "assistant", content: [{ type: "toolCall", id: "call-snapped", name: "compress", arguments: {} }] }],
  ]);
  const withSnap = coreOutToAgentMessages(coreOut as any, originals, new Set(["call-snapped"]));
  const ids = withSnap.flatMap((m: any) => (m.content ?? []).map((c: any) => c.id)).filter(Boolean);
  assert.ok(ids.includes("call-keep"));
  assert.ok(!ids.includes("call-snapped"), "snapped anchor hidden");
  const withoutSnap = coreOutToAgentMessages(coreOut as any, originals);
  assert.equal(withoutSnap.length, 3);
});

test("snappedView only hides active archived blocks", () => {
  const b1 = block("b1", { compressCallId: "call-a" });
  const b2 = block("b2", { compressCallId: "call-b", active: false });
  const b3 = block("b3", { compressCallId: "call-c" });
  const state = stateWith([b1, b2, b3]);
  const manifest: SnapManifest = { frames: [], archivedIds: ["b1", "b2", "b3"], batches: [] };
  const view = snappedView(state, manifest);
  assert.deepEqual([...view.callIds].sort(), ["call-a", "call-c"]);
  assert.deepEqual([...view.blockIds].sort(), ["b1", "b3"]);
});

test("distillDirective names the tier-2 compress range", () => {
  const text = distillDirective([block("b2"), block("b3"), block("b4")]);
  assert.ok(text.includes('startId: "b2"'));
  assert.ok(text.includes('endId: "b4"'));
});
