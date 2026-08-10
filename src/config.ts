import { defaultConfig, type Config } from "acp-kernel";

/**
 * Adapter configuration. Maps onto acp-kernel's `Config` plus Pi-specific knobs
 * (live model context window, protected tools, state persistence).
 */
export interface AdapterConfig {
  /** When omitted, the adapter reads `ctx.model.contextWindow` live each turn.
   *  Set explicitly for tests/headless runs. */
  modelContextLimit?: number;
  protectedTools?: string[];
  preserveRecentMessages?: number;
  /** Check npm for a newer billion-context-pi on startup and auto-install it. Default: true.
   *  Disable via `autoUpdate: false` or env `ACP_AUTO_UPDATE=0` to avoid all
   *  network calls on startup. */
  autoUpdate?: boolean;
  /** Enable debug-level events in the ACP log file (default ~/.pi/acp.log).
   *  Always-on events (session/turn/compress/delegate lifecycle, all errors and
   *  warnings) are written regardless; `debug` only adds verbose diagnostics.
   *  Default: false (or env ACP_DEBUG=1/true). */
  debug?: boolean;
  /** Enable acp_delegate tools (delegate/wait/cancel) and their system-prompt
   *  section. Default: true. Set `delegate: false` (adapter config or
   *  ~/.pi/acp.json) to skip registering them. */
  delegate?: boolean;
  /** Default timeout in seconds injected into the bash tool when the model
   *  omits `timeout`. Pi has NO built-in default, so without this a command
   *  that the model forgets to time out can hang for thousands of seconds.
   *  Default: 60 (catches hangs quickly). On timeout the model is guided to
   *  re-run with a larger `timeout`. Set to 0 to disable (restore Pi's
   *  unbounded behavior). */
  toolBashDefaultTimeout?: number;
  /** Hard byte cap applied to tool result text via the `tool_result` hook.
   *  Default: 200000 (~200KB, roughly 5000 lines at ~40 bytes/line) — a
   *  generous ceiling that stops runaway output. Pi already caps bash/read/grep
   *  at 50KB/2000 lines (bash full output is saved to a temp file), so this
   *  default mainly caps tools Pi doesn't cap. Set lower (e.g. 8192) for a
   *  tighter context budget, or 0 to disable. When capped, oversized text is
   *  head-truncated with a notice telling the model how to see the full output
   *  (bash: read BashToolDetails.fullOutputPath). */
  toolOutputMaxBytes?: number;
  /** Snap channel (cold-archive compressed-block summaries as bitmap frames,
   *  official-snapcompact-aligned rebuild). "auto" (default) = PNG path on
   *  vision models only; "on" = force; "off" = disabled. Env
   *  ACP_SNAPCOMPACT=off|force overrides. */
  snapcompact?: "auto" | "on" | "off";
  /** Frame shape variant override (e.g. "silver16-bw"); default auto-detect. */
  snapcompactVariant?: string;
  /** Max frames kept per session (FIFO cap, official-style upper limit). Default 16. */
  snapcompactMaxFrames?: number;
  /** Newest N active blocks stay hot text; older are snap candidates. Default 6. */
  snapHotBlocks?: number;
  /** Auto-snap fires when unsnapped cold summaries sum >= this many tokens. Default 8000. */
  snapThresholdTokens?: number;
  /** Reserved (pi fires one context event shape; auto-snap runs on all of them). Default true. */
  snapMidTurnEnabled?: boolean;
  /** Idle snap maintenance (official-style reason "idle"). Default false. */
  snapIdleEnabled?: boolean;
  /** Idle snap requires >= this many seconds without a context event. Default 300. */
  snapIdleTimeoutSeconds?: number;
  /** Idle snap requires last observed usage >= this many tokens. Default 200000. */
  snapIdleThresholdTokens?: number;
  coreOverrides?: Partial<Config>;
}

export const DEFAULT_TOOL_BASH_TIMEOUT = 60;
export const DEFAULT_TOOL_OUTPUT_MAX_BYTES = 200_000;

export function resolveConfig(adapter: AdapterConfig, liveContextLimit: number): Config {
  const envLimit = process.env.ACP_MODEL_CONTEXT_LIMIT;
  const envLimitNum = envLimit ? Number(envLimit) : NaN;
  const FALLBACK_LIMIT = 150_000;
  const limit =
    !Number.isNaN(envLimitNum) && envLimitNum > 0
      ? envLimitNum
      : adapter.modelContextLimit && adapter.modelContextLimit > 0
        ? adapter.modelContextLimit
        : liveContextLimit > 0
          ? liveContextLimit
          : FALLBACK_LIMIT;
  return defaultConfig(limit, {
    protectedTools: adapter.protectedTools ?? [],
    preserveRecentMessages: adapter.preserveRecentMessages ?? 5,
    ...adapter.coreOverrides,
  });
}
