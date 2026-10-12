// Single diagnostics sink for the plugin. Plugin console output does not reach
// the `opencode run` caller (Scope A finding 9); the server writes it to its own
// stderr with the [opencode-verified-goal] prefix. Never log objectives, evidence, or raw
// stored values (R-030): the helpers here are the only logging surface, and the
// call sites pass key names, codes, counts, and lengths only.

export type LogSink = (line: string) => void;

let sink: LogSink = (line) => {
  console.log(`[opencode-verified-goal] ${line}`);
};

/** Test seam; production keeps the default console sink. */
export function setLogSink(next: LogSink | undefined): void {
  sink = next ?? ((line) => console.log(`[opencode-verified-goal] ${line}`));
}

function write(level: string, message: string): void {
  try {
    sink(level.length > 0 ? `${level} ${message}` : message);
  } catch {
    // Logging must never break a transition.
  }
}

export function log(message: string): void {
  write("", message);
}

export function logWarn(message: string): void {
  write("[warn]", message);
}

/**
 * Debug-level diagnostics (R-018/Scope B: events ignored because their
 * sessionID resolves to no goal record are logged at debug level). Off unless
 * ESTATE_GOAL_DEBUG=1, so an ordinary server run stays quiet.
 */
export function logDebug(message: string): void {
  if (process.env.ESTATE_GOAL_DEBUG === "1") write("[debug]", message);
}
