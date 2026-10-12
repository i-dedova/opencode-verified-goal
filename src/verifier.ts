// Reviewer lane: session lifecycle and verdict capture (R-015, R-017, R-020,
// R-023, R-024, R-026). The plugin makes no runtime permission call (R-016):
// the lane's deny-all capability comes from its generated frontmatter.
//
// ponytail: ceiling: reviewer capabilities come from lane frontmatter because ctx.permission.rules is absent on 2.0.26; upgrade when: a runtime permission API exists
// ponytail: ceiling: a verifier approval is a reviewed judgement, not proof of objective quality; upgrade when: a machine-checkable verifier exists for the objective class

import type { Plugin } from "@opencode/plugin";
import { PLUGIN_CONSTANTS } from "./state.ts";
import type { VerifyProfile } from "./state.ts";
import type { VerifierTransition } from "./prompts.ts";
import { log, logWarn } from "./log.ts";

type Context = Parameters<Plugin["setup"]>[0];

export const VERIFIER_AGENT = "subagent_goal-verifier";

/** Throwaway turn that triggers the compaction boundary before the verdict. */
const PREPARATION_TURN = "Reply with the single word: ready";

/**
 * Bytes per admitted asset message when a payload is over the review budget.
 * Kept well inside the smallest supported reviewer window (256K tokens) so a
 * payload never arrives as one message the host cannot shrink: the host's
 * compaction drops whole user messages oldest-first, which only works when the
 * assets are multiple messages.
 */
const ASSET_CHUNK_BYTES = 100_000;

/** Split asset text into line-aligned, byte-bounded messages (never a cut in the middle of a line when avoidable). */
export function chunkForCompaction(text: string, chunkBytes: number = ASSET_CHUNK_BYTES): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
  };
  for (const line of text.split("\n")) {
    const lineText = `${line}\n`;
    const lineBytes = encoder.encode(lineText).byteLength;
    if (lineBytes > chunkBytes) {
      // A single oversized line (minified JSON, one long log record) is split by character.
      flush();
      let piece = "";
      let pieceBytes = 0;
      for (const char of lineText) {
        const charBytes = encoder.encode(char).byteLength;
        if (pieceBytes > 0 && pieceBytes + charBytes > chunkBytes) {
          chunks.push(piece);
          piece = "";
          pieceBytes = 0;
        }
        piece += char;
        pieceBytes += charBytes;
      }
      current = piece;
      currentBytes = pieceBytes;
      continue;
    }
    if (currentBytes > 0 && currentBytes + lineBytes > chunkBytes) flush();
    current += lineText;
    currentBytes += lineBytes;
  }
  flush();
  return chunks;
}

/**
 * Providers the reviewer lane may run on. The standing pin is `opencode-go`
 * (operator constraint, non-negotiable); `commandcode` is the operator-directed
 * temporary testing provider used while the opencode-go window is exhausted.
 * The console `opencode` provider is never allowed. Anything else fails closed.
 */
const VERIFIER_PROVIDERS = new Set(["opencode-go", "commandcode"]);

/** The aligned pin: a mismatch is logged (the lane manifest owns the value). */
const STANDING_VERIFIER_MODEL = { providerID: "opencode-go", id: "grok-4.7", variant: "xhigh" } as const;

/** session.text.ended capture, keyed by session; the only read-back path (R-020). */
const capturedText = new Map<string, string[]>();

/** Waiters resolved by the next text.ended for a session (event-driven, no race). */
const textWaiters = new Map<string, () => void>();

export function noteTextEnded(sessionID: string, text: string): void {
  const list = capturedText.get(sessionID);
  if (!list) return;
  list.push(text);
  if (capturedText.has(sessionID)) log(`reviewer text.ended session=${sessionID} chars=${text.length}`);
  const waiter = textWaiters.get(sessionID);
  if (waiter) {
    textWaiters.delete(sessionID);
    waiter();
  }
}

export interface ParsedVerdict {
  approved: boolean;
  reason: string;
  unmet: string;
}

const VERDICTS = new Set(["approved", "rejected"]);
const TRANSITIONS = new Set([
  "blocked-active",
  "active-complete",
  "paused-complete",
  "blocked-complete",
]);
const PROFILES = new Set(["spec-backed", "ad-hoc"]);

/**
 * The verdict grammar (R-023): exactly five lines in order, no blank lines, no
 * trailing whitespace. Any deviation is unparseable. One trailing newline is
 * tolerated (text responses conventionally end with it); nothing else is.
 * `transition` and `profile` must carry the exact values the reviewer was told.
 */
export function parseVerdict(
  raw: string,
  expectedTransition: VerifierTransition,
  expectedProfile: VerifyProfile,
): { ok: true; verdict: ParsedVerdict } | { ok: false; empty: boolean } {
  if (raw.trim().length === 0) return { ok: false, empty: true };
  let text = raw;
  if (text.endsWith("\r\n")) text = text.slice(0, -2);
  else if (text.endsWith("\n")) text = text.slice(0, -1);
  const lines = text.split(/\r?\n/);
  if (lines.length !== 5) return { ok: false, empty: false };
  const [verdictLine, transitionLine, profileLine, reasonLine, unmetLine] = lines;
  const verdictValue = /^verdict: (\S+)$/.exec(verdictLine)?.[1] ?? "";
  const transitionValue = /^transition: (\S+)$/.exec(transitionLine)?.[1] ?? "";
  const profileValue = /^profile: (\S+)$/.exec(profileLine)?.[1] ?? "";
  const reasonValue = /^reason: (\S(?:.*\S)?)$/.exec(reasonLine)?.[1] ?? "";
  const unmetValue = /^unmet: (\S(?:.*\S)?)$/.exec(unmetLine)?.[1] ?? "";
  if (!VERDICTS.has(verdictValue)) return { ok: false, empty: false };
  if (!TRANSITIONS.has(transitionValue) || transitionValue !== expectedTransition) return { ok: false, empty: false };
  if (!PROFILES.has(profileValue) || profileValue !== expectedProfile) return { ok: false, empty: false };
  if (reasonValue.length === 0 || unmetValue.length === 0) return { ok: false, empty: false };
  return {
    ok: true,
    verdict: {
      approved: verdictValue === "approved",
      reason: reasonValue,
      unmet: unmetValue,
    },
  };
}

export interface ReviewOutcome {
  status: "verdict" | "timeout" | "unparseable" | "error";
  approved: boolean;
  reason: string;
  raw: string;
  profile: VerifyProfile;
  transition: VerifierTransition;
  /** The reviewer session, empty when none was created; the caller records reuse. */
  reviewerSessionID: string;
}

export interface ReviewInput {
  sessionID: string;
  transition: VerifierTransition;
  profile: VerifyProfile;
  /** The live goal's id: the reuse key for this goal's reviewer session. */
  goalId: string;
  /** Fingerprint of the inlined assets; a reuse is only valid when it matches. */
  assetFingerprint: string;
  /** A live reviewer session to resume for this goal, when the assets are unchanged. */
  reuseSessionID?: string | null;
  /**
   * The inlined asset payload (evidence, spec, log, reason, evidence string).
   * Delivered directly when it fits max_asset_bytes.
   */
  payload: string;
  /**
   * The instruction block plus the goal record — the message that must survive
   * compaction verbatim because it carries the verdict grammar. When
   * `payload + tail` exceeds max_asset_bytes the reviewer receives the payload
   * through the host's own compaction pipeline (admit, `/compact`, then the
   * tail), never a cut.
   */
  tail: string;
}

export interface Reviewer {
  review(input: ReviewInput): Promise<ReviewOutcome>;
}

export interface ReviewerOptions {
  /** Test seam; production uses the fixed verifier_timeout_ms constant. */
  timeoutMs?: number;
}

/**
 * The reviewer's model, resolved from the lane's own frontmatter. The lane pin
 * is the only source: `switchAgent` changes the agent but a plugin-created
 * session otherwise runs on the service default model (`session.ts` switchAgent
 * publishes AgentSelected only; the runner resolves `session.model` or the
 * catalog default, `runner/model.ts:75-91`), so the plugin applies it
 * explicitly. Operator constraint, non-negotiable: the reviewer runs on an
 * `opencode-go` model (`opencode-go/grok-4.7#xhigh`) — never the console
 * `opencode` provider — and the assembled payload is bounded by
 * max_asset_bytes to stay inside grok's 200K-token window with headroom for
 * the verdict (R-022). Returns null (fail closed) when the lane has no model
 * or the provider is not on VERIFIER_PROVIDERS.
 */
export async function resolveVerifierModel(
  ctx: Context,
): Promise<{ providerID: string; id: string; variant?: string } | null> {
  try {
    const raw = (await ctx.agent.get({ agentID: VERIFIER_AGENT })) as
      | { data?: { model?: { providerID?: unknown; id?: unknown; variant?: unknown } }; model?: unknown }
      | undefined;
    // agent.get returns the {location, data} envelope on 2.0.26 (unlike
    // session.get, which is unwrapped), so accept both shapes.
    const info = (raw?.data ?? raw) as { model?: { providerID?: unknown; id?: unknown; variant?: unknown } } | undefined;
    const model = info?.model;
    if (!model || typeof model.providerID !== "string" || typeof model.id !== "string") return null;
    if (!VERIFIER_PROVIDERS.has(model.providerID)) {
      logWarn(`verifier lane model provider '${model.providerID}' is not allowed; refusing to run the reviewer`);
      return null;
    }
    if (model.providerID !== "opencode-go") {
      logWarn(
        `verifier lane model provider '${model.providerID}' is a temporary testing pin; the standing pin is opencode-go/grok-4.7`,
      );
    } else if (model.id !== STANDING_VERIFIER_MODEL.id || model.variant !== STANDING_VERIFIER_MODEL.variant) {
      // The lane manifest owns the pin; a drifted opencode-go model would
      // otherwise run silently on a model the operator never chose.
      logWarn(
        `verifier lane model '${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}' differs from the ` +
          `standing pin ${STANDING_VERIFIER_MODEL.providerID}/${STANDING_VERIFIER_MODEL.id}#${STANDING_VERIFIER_MODEL.variant}`,
      );
    }
    return {
      providerID: model.providerID,
      id: model.id,
      ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
    };
  } catch (error) {
    logWarn(`verifier lane model lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function createReviewer(ctx: Context, options: ReviewerOptions = {}): Reviewer {
  const timeoutMs = options.timeoutMs ?? PLUGIN_CONSTANTS.verifier_timeout_ms;

  /** Wait for the reviewer session to go idle, bounded by the timeout (R-024). */
  const settled = (sessionID: string, ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(false);
      }, ms);
      ctx.session.wait({ sessionID }).then(
        () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(true);
        },
        () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(true); // an un-waitable session is not running for us
        },
      );
    });

  /**
   * Wait for the next text.ended on the reviewer session, then for the turn to
   * settle so the last captured text is that turn's answer. `session.wait`
   * alone is not enough: it can resolve on a still-idle session before the
   * prompt's execution has been scheduled, which reads as an empty verdict.
   * `before` is the capture count recorded just before the prompt for this turn,
   * and `ms` is one shared deadline for both waits, so a turn never costs more
   * than the budget it was given.
   */
  const awaitTurn = async (sessionID: string, ms: number, before: number): Promise<boolean> => {
    const startedAt = Date.now();
    const arrived = await new Promise<boolean>((resolve) => {
      // The answer may already have landed between the prompt and this call.
      if ((capturedText.get(sessionID) ?? []).length > before) {
        resolve(true);
        return;
      }
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        textWaiters.delete(sessionID);
        resolve(false);
      }, ms);
      textWaiters.set(sessionID, () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!arrived) return false;
    // Settle on the same deadline, never a second full budget.
    await settled(sessionID, Math.max(0, ms - (Date.now() - startedAt)));
    return true;
  };

  /** The refusal shared by both timeout points (R-024). */
  const timeoutOutcome = (profile: VerifyProfile, transition: VerifierTransition, reviewer: string): ReviewOutcome => ({
    status: "timeout",
    approved: false,
    reason: "the reviewer did not answer within the timeout",
    raw: "",
    profile,
    transition,
    reviewerSessionID: reviewer,
  });

  return {
    async review(input: ReviewInput): Promise<ReviewOutcome> {
      let reviewerSessionID: string | null = null;
      let keepSession = false;
      try {
        // Resolve the lane model BEFORE creating anything; without it the
        // reviewer would silently run on the wrong model (fail closed).
        const model = await resolveVerifierModel(ctx);
        if (!model) {
          return {
            status: "error",
            approved: false,
            reason: "verifier lane model unavailable (an allowed lane model pin is required)",
            raw: "",
            profile: input.profile,
            transition: input.transition,
            reviewerSessionID: "",
          };
        }
        // Resume this goal's reviewer when one is live and the inlined assets
        // are unchanged: its earlier turns already hold the spec and log, so
        // the payload carries only the delta.
        if (input.reuseSessionID) {
          try {
            const info = (await ctx.session.get({ sessionID: input.reuseSessionID })) as { id?: unknown } | undefined;
            if (info && typeof info.id === "string") reviewerSessionID = input.reuseSessionID;
          } catch (error) {
            logWarn(
              `reviewer reuse lookup failed session=${input.reuseSessionID}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (reviewerSessionID) {
          log(`reviewer resumed session=${reviewerSessionID} transition=${input.transition}`);
        } else {
          const created = (await ctx.session.create({ title: `goal-verifier ${input.transition}` })) as
            | { id?: string }
            | undefined;
          reviewerSessionID = typeof created?.id === "string" ? created.id : null;
        }
        if (!reviewerSessionID) {
          return {
            status: "error",
            approved: false,
            reason: "reviewer session could not be created",
            raw: "",
            profile: input.profile,
            transition: input.transition,
            reviewerSessionID: "",
          };
        }
        capturedText.set(reviewerSessionID, []);
        await ctx.session.switchAgent({ sessionID: reviewerSessionID, agent: VERIFIER_AGENT });
        await ctx.session.switchModel({ sessionID: reviewerSessionID, model });
        log(`reviewer model session=${reviewerSessionID} model=${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`);
        const encoder = new TextEncoder();
        const totalBytes = encoder.encode(`${input.payload}\n\n${input.tail}`).byteLength;
        const captureCount = (): number => (capturedText.get(reviewerSessionID as string) ?? []).length;
        if (totalBytes <= PLUGIN_CONSTANTS.max_asset_bytes) {
          const before = captureCount();
          await ctx.session.prompt({ sessionID: reviewerSessionID, text: `${input.payload}\n\n${input.tail}` });
          if (!(await awaitTurn(reviewerSessionID, timeoutMs, before))) {
            log(`reviewer timeout session=${input.sessionID} reviewer=${reviewerSessionID}`);
            return timeoutOutcome(input.profile, input.transition, reviewerSessionID ?? "");
          }
        } else {
          // Over the review budget: deliver the assets through the host's own
          // compaction pipeline instead of cutting them. The assets are admitted
          // without execution, a manual compaction request summarizes them at
          // the next step boundary, and a throwaway preparation turn triggers
          // that boundary. Preparation is bounded by the same reviewer timeout
          // but kept out of the verdict budget: the summarizer takes tens of
          // seconds on a 200K window, and the verdict turn must still answer
          // inside verifier_timeout_ms from the compacted context.
          const chunks = chunkForCompaction(input.payload);
          log(`review payload over budget bytes=${totalBytes}; preparing host compaction in ${chunks.length} message(s)`);
          for (const chunk of chunks) {
            await ctx.session.prompt({ sessionID: reviewerSessionID, text: chunk, resume: false });
          }
          try {
            await ctx.session.compact({ sessionID: reviewerSessionID });
          } catch (error) {
            // The runner's own overflow recovery compacts a context the
            // provider rejects as too long, so the trigger still proceeds.
            logWarn(
              `explicit compaction request failed (${error instanceof Error ? error.message : String(error)}); relying on the runner's overflow recovery`,
            );
          }
          const beforePrep = captureCount();
          await ctx.session.prompt({ sessionID: reviewerSessionID, text: PREPARATION_TURN });
          // Preparation gets its own budget: the summarizer runs on the model's
          // own (often slow) route and may take several shrink rounds on a
          // payload near the window. The verdict budget below is untouched.
          if (!(await awaitTurn(reviewerSessionID, timeoutMs * 2, beforePrep))) {
            log(`reviewer timeout (compaction preparation) session=${input.sessionID} reviewer=${reviewerSessionID}`);
            return timeoutOutcome(input.profile, input.transition, reviewerSessionID ?? "");
          }
          // Only the verdict turn must parse; drop the preparation reply.
          capturedText.set(reviewerSessionID, []);
          await ctx.session.prompt({ sessionID: reviewerSessionID, text: input.tail });
          if (!(await awaitTurn(reviewerSessionID, timeoutMs, 0))) {
            log(`reviewer timeout session=${input.sessionID} reviewer=${reviewerSessionID}`);
            return timeoutOutcome(input.profile, input.transition, reviewerSessionID ?? "");
          }
        }
        const texts = capturedText.get(reviewerSessionID) ?? [];
        const raw = texts.length > 0 ? texts[texts.length - 1] : "";
        const parsed = parseVerdict(raw, input.transition, input.profile);
        // The reviewer answered: keep its session so this goal's next review can
        // resume it; the caller records the durable reference.
        keepSession = true;
        if (!parsed.ok) {
          log(
            `reviewer unparseable session=${input.sessionID} reviewer=${reviewerSessionID} ` +
              `empty=${parsed.empty} captured=${texts.length}`,
          );
          return {
            status: "unparseable",
            approved: false,
            reason: parsed.empty ? "the reviewer returned no text" : "the verdict did not match the grammar",
            raw,
            profile: input.profile,
            transition: input.transition,
            reviewerSessionID,
          };
        }
        log(
          `review verdict session=${input.sessionID} reviewer=${reviewerSessionID} ` +
            `transition=${input.transition} profile=${input.profile} verdict=${parsed.verdict.approved ? "approved" : "rejected"}`,
        );
        return {
          status: "verdict",
          approved: parsed.verdict.approved,
          reason: parsed.verdict.reason,
          raw,
          profile: input.profile,
          transition: input.transition,
          reviewerSessionID,
        };
      } catch (error) {
        logWarn(
          `reviewer error session=${input.sessionID}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          status: "error",
          approved: false,
          reason: error instanceof Error ? error.message : String(error),
          raw: "",
          profile: input.profile,
          transition: input.transition,
          reviewerSessionID: reviewerSessionID ?? "",
        };
      } finally {
        if (reviewerSessionID) {
          capturedText.delete(reviewerSessionID);
          textWaiters.delete(reviewerSessionID);
          if (!keepSession) {
            try {
              await ctx.session.remove({ sessionID: reviewerSessionID });
            } catch (error) {
              // Teardown treats an already-absent reviewer session as removed.
              logWarn(
                `reviewer remove failed session=${reviewerSessionID}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }
      }
    },
  };
}
