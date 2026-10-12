// OpenCode goal plugin: three agent tools, five operator commands, the
// context/compaction hooks, and the event subscription that drives
// continuation. The plugin id is fixed as "i-dedova.verified-goal" and never renamed
// (R-029); the default export is the V2 promise-plugin definition.

import type { Plugin } from "@opencode/plugin";
import { GoalError, GoalStore, PLUGIN_CONSTANTS, PLUGIN_ID } from "./state.ts";
import type { GoalRecord, ReasonCode, StoragePort } from "./state.ts";
import { sessionMutex } from "./mutex.ts";
import type { SessionMutex } from "./mutex.ts";
import { GoalEngine } from "./continuation.ts";
import { createReviewer, noteTextEnded, resolveVerifierModel } from "./verifier.ts";
import type { Reviewer } from "./verifier.ts";
import { fingerprintAssets, resolveEvidenceFile, resolveReviewAssets } from "./assets.ts";
import { pruneReviews, recordReview, reviewJournalPath } from "./journal.ts";
import { fenceInstruction, verifierInstructionBlock } from "./prompts.ts";
import { log, logWarn } from "./log.ts";

type Context = Parameters<Plugin["setup"]>[0];

const SET_GOAL_DESCRIPTION =
  "Start a session goal only on the operator's explicit instruction or an explicit " +
  "operator-addressed request; never infer a goal from ordinary task text. The goal keeps the " +
  "session working automatically across turns until it is reviewed complete or blocked. " +
  "`objective` is the operator's objective, verbatim: 4-4000 characters, and a task statement rather " +
  "than a short word. `max_turns` and " +
  "`max_tokens` are optional; omitting either means unlimited for that dimension, and with both " +
  "omitted the goal runs until it completes, blocks, or a failsafe fires. This tool is refused " +
  "while an unfinished goal exists (active, paused, or blocked); only the operator can clear or " +
  "pause a goal.";

const GET_GOAL_DESCRIPTION =
  "Read this session's live goal, including its goal_id, counters, and the number of earlier " +
  "goals (prior_goals). Read-only; emits no status line.";

const UPDATE_GOAL_DESCRIPTION =
  "Transition the session's live goal. `complete` and `active` (unblock) are reviewed by an " +
  "independent session and are refused when the payload does not prove them — get the evidence " +
  "right the first time. `blocked` applies immediately, without review.\n" +
  "`complete` requires BOTH `evidence` — a statement naming the artifact or command and its " +
  "observed result covering the FULL objective, not a restatement of the objective — and " +
  "`evidence_path` — the existing readable file under the allowed roots that proves it. A missing, " +
  "unreadable, or unrelated artifact is refused before review.\n" +
  "`blocked` requires `reason`: the specific operator decision needed AND the evidence that no " +
  "safe next action remains — what you tried, what you observed, and why those are exhausted. It " +
  "applies at once, stops the loop, and prints the reason for the operator; a bare assertion of " +
  "impasse, or being hard, slow, uncertain, or incomplete, is not acceptable to the operator even " +
  "though no reviewer checks it.\n" +
  "`active` re-arms a stopped goal; on a blocked goal it is reviewed and requires `reason` stating " +
  "how the operator resolved the accepted blocking condition. A tool call cannot unlock a paused " +
  "or operator-cleared goal.";

/**
 * Build-time snapshot of `opencode debug agents` primaries (R-013, recorded in
 * the I23/T1 implementation log). A session whose current agent is not in this
 * set never continues. Refresh by re-running `opencode debug agents` after an
 * agent change (operator step).
 */
const PRIMARY_AGENTS = new Set([
  "build",
  "compaction",
  "cwd",
  "homewide",
  "plan",
  "summary",
  "title",
]);

const REASON_GLOSS: Record<ReasonCode, string> = {
  "illegal-transition": "the requested transition is not allowed from the goal's current state",
  "evidence-required": "completion requires a non-empty evidence string",
  "evidence-unreadable": "the evidence_path is not a readable file",
  "evidence-outside-allowed-roots": "the evidence_path is outside the allowed roots",
  "objective-invalid":
    "the objective must be a task statement: 4-4000 characters after trimming, and not a single short word",
  "budget-invalid": "max_turns and max_tokens must be positive integers when set",
  "blocked-reason-required": "blocked requires a reason naming the specific operator decision required",
  "transition-in-flight": "another goal transition is being verified for this session",
  "foreign-writer": "the goal is owned by another live process",
  "state-locked": "the goal state is locked by another writer",
  "verifier-timeout": "the reviewer did not answer within the timeout",
  "verifier-unparseable": "the reviewer's answer did not match the verdict grammar",
  "verifier-rejected": "the reviewer rejected the transition",
  "evidence-vanished": "the evidence file disappeared during review",
  "verifier-error": "the reviewer session failed",
};

interface PluginEvent {
  type: string;
  durable?: unknown;
  data?: Record<string, unknown>;
}

export interface RuntimeDeps {
  ctx: Context;
  store: GoalStore;
  engine: GoalEngine;
  reviewer: Reviewer;
}

// In-memory per-session transition guard (R-014). Per process: module scope,
// shared by every plugin instance the process loads.
const transitionGuard = new Set<string>();

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join("")}…`;
}

/** R-036's title bound: plain truncation, no ellipsis. */
function truncatePlain(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max).join("");
}

export async function emitState(ctx: Context, sessionID: string, description: string): Promise<void> {
  try {
    // The client renders `description`; the model receives `text`
    // (to-llm-message.ts:287-288). A single-space text keeps every state line
    // operator-visible while carrying no model-visible content: the Anthropic
    // route trims it away entirely (anthropic-messages.ts:904-915), and the
    // OpenAI routes receive an invisible whitespace turn rather than an empty
    // message. Proven by provider request capture 2026-10-11 (D-064).
    await ctx.session.synthetic({ sessionID, text: " ", description, resume: false });
  } catch (error) {
    logWarn(`synthetic failed session=${sessionID}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function setSessionTitle(ctx: Context, sessionID: string, record: GoalRecord): Promise<void> {
  const suffix = ` — ${record.status}${record.stop_reason ? ` (${record.stop_reason})` : ""}`;
  const title = `${truncatePlain(record.objective, 80)}${suffix}`;
  try {
    await ctx.session.update({ sessionID, title });
  } catch (error) {
    logWarn(`title update failed session=${sessionID}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function refusalLine(code: ReasonCode, detail?: string): string {
  return `goal refused — ${code}: ${detail && detail.length > 0 ? detail : REASON_GLOSS[code]}`;
}

/**
 * An objective must be a task statement, not a stray word: 4-4000 characters
 * after trimming, and either at least 8 characters or containing whitespace, so
 * `fix bug` is a goal while `/goal cleanup` is refused as invalid.
 */
function objectiveValid(objective: unknown): objective is string {
  if (typeof objective !== "string") return false;
  const trimmed = objective.trim();
  if (trimmed.length < PLUGIN_CONSTANTS.objective_min_chars || trimmed.length > 4000) return false;
  return trimmed.length >= 8 || /\s/.test(trimmed);
}

function budgetValid(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function goalView(record: GoalRecord, priorGoals: number): Record<string, unknown> {
  // writer_pid is never surfaced to the model (Target State, "Record").
  const { writer_pid: _writer_pid, ...rest } = record;
  return { ...rest, prior_goals: priorGoals };
}

async function priorGoalCount(deps: RuntimeDeps, sessionID: string, liveGoalId: string | null): Promise<number> {
  const goals = await deps.store.listGoals(sessionID);
  return liveGoalId === null ? goals.length : goals.filter((goal) => goal.goal_id !== liveGoalId).length;
}

// ---------------------------------------------------------------- transitions

interface CreateInput {
  sessionID: string;
  objective: string;
  maxTurns: number | null;
  maxTokens: number | null;
  actor: "operator" | "agent";
}

export async function createGoal(deps: RuntimeDeps, input: CreateInput): Promise<GoalRecord> {
  const { store, engine, ctx } = deps;
  return engine.withSessionLock(input.sessionID, async () => {
    const { record: live } = await store.current(input.sessionID);
    if (live) {
      // R-007: never alter an unfinished goal; the agent cannot escape it.
      if (store.isForeign(live)) throw new GoalError("foreign-writer", `writer_pid ${live.writer_pid}`);
      throw new GoalError("illegal-transition", `an unfinished goal (${live.status}) already exists`);
    }
    const goalId = await store.allocateGoalId(input.sessionID);
    const now = Date.now();
    const record: GoalRecord = {
      record_version: 1,
      goal_id: goalId,
      writer_pid: store.writerPid,
      objective: input.objective,
      status: "active",
      active: true,
      continuing: true,
      stop_reason: null,
      verify_profile: null,
      blocked_reason: null,
      max_turns: input.maxTurns,
      max_tokens: input.maxTokens,
      tokens_baseline: engine.currentTokens(input.sessionID),
      tokens_used: 0,
      time_used_seconds: 0,
      turns_used: 0,
      no_progress_turns: 0,
      blocked_count: 0,
      refusal_count: 0,
      refusal_reason: null,
      created_at: now,
      updated_at: now,
    };
    await store.writeRecord(input.sessionID, record);
    await store.writeCurrent(input.sessionID, goalId);
    // A superseded goal's reviewer reference is stale now; release it so the
    // session is not leaked by the next review writing over the reference.
    const supersededReviewer = await store.readReviewer(input.sessionID).catch(() => null);
    if (supersededReviewer && supersededReviewer.goal_id !== goalId) {
      await releaseGoalReviewer(ctx, store, input.sessionID);
    }
    const state = engine.noteGoalStarted(input.sessionID);
    log(
      `goal set session=${input.sessionID} goal=${goalId} actor=${input.actor} ` +
        `max_turns=${record.max_turns ?? "none"} max_tokens=${record.max_tokens ?? "none"}`,
    );
    await emitState(ctx, input.sessionID, `goal set — ${truncate(record.objective, 200)}`);
    await setSessionTitle(ctx, input.sessionID, record);
    engine.armLocked(input.sessionID, record, state);
    return record;
  });
}

export async function pauseGoal(deps: RuntimeDeps, sessionID: string): Promise<void> {
  const { store, engine, ctx } = deps;
  let applied = false;
  await engine.withSessionLock(sessionID, async () => {
    const { record } = await store.current(sessionID);
    if (!record) {
      log(`pause ignored session=${sessionID}: no live goal`);
      return;
    }
    if (record.status !== "active") {
      log(`pause ignored session=${sessionID}: status ${record.status} is not active`);
      return;
    }
    store.assertWritable(record);
    store.claim(record);
    record.status = "paused";
    record.continuing = false;
    record.stop_reason = null;
    engine.syncCounters(sessionID, record);
    engine.clearTimeMark(sessionID, record);
    await store.writeRecord(sessionID, record);
    engine.discardPending(sessionID);
    applied = true;
    log(`goal paused session=${sessionID} goal=${record.goal_id}`);
    await emitState(ctx, sessionID, `goal paused — ${truncate(record.objective, 200)}`);
    await setSessionTitle(ctx, sessionID, record);
  });
  // Stop the agent now, not at the end of its current turn: a pause that leaves
  // the in-flight turn running reads as "the goal did not stop". Only when the
  // pause actually applied — an ignored pause must not stop an unrelated turn.
  if (applied) await interruptSession(ctx, sessionID);
}

export async function resumeGoal(deps: RuntimeDeps, sessionID: string): Promise<void> {
  const { store, engine, ctx } = deps;
  await engine.withSessionLock(sessionID, async () => {
    const { record } = await store.current(sessionID);
    if (!record) {
      await emitState(ctx, sessionID, "no available goal to resume");
      return;
    }
    if (store.isForeign(record)) {
      await emitState(ctx, sessionID, refusalLine("foreign-writer", `writer_pid ${record.writer_pid}`));
      return;
    }
    const resumable =
      record.status === "paused" ||
      record.status === "blocked" ||
      (record.status === "active" && !record.continuing);
    if (!resumable) {
      await emitState(ctx, sessionID, "no available goal to resume");
      return;
    }
    store.claim(record);
    record.status = "active";
    record.continuing = true;
    record.stop_reason = null;
    record.refusal_count = 0;
    record.refusal_reason = null;
    record.no_progress_turns = 0;
    if (record.blocked_reason !== null) record.blocked_reason = null;
    engine.syncCounters(sessionID, record);
    const state = engine.noteGoalStarted(sessionID);
    await store.writeRecord(sessionID, record);
    engine.discardPending(sessionID);
    log(`goal resumed session=${sessionID} goal=${record.goal_id}`);
    await emitState(ctx, sessionID, `goal resumed — ${truncate(record.objective, 200)}`);
    await setSessionTitle(ctx, sessionID, record);
    engine.armLocked(sessionID, record, state, { immediate: true });
  });
}

export async function clearGoal(deps: RuntimeDeps, sessionID: string): Promise<void> {
  const { store, engine, ctx } = deps;
  let applied = false;
  await engine.withSessionLock(sessionID, async () => {
    const { record, goalId } = await store.current(sessionID);
    if (!record || !goalId) {
      log(`clear ignored session=${sessionID}: no live goal`);
      return;
    }
    if (store.isForeign(record)) {
      // R-043: a foreign record is never mutated - and the operator is told why.
      log(`clear refused session=${sessionID}: record owned by live pid ${record.writer_pid}`);
      await emitState(ctx, sessionID, refusalLine("foreign-writer", `writer_pid ${record.writer_pid}`));
      return;
    }
    engine.discardPending(sessionID);
    await store.removeRecord(sessionID, goalId);
    await store.clearCurrent(sessionID);
    // The cleared goal's reviewer session goes with it.
    await releaseGoalReviewer(ctx, store, sessionID, goalId);
    // The :seq high-water mark deliberately survives /goal clear (R-029).
    log(`goal cleared session=${sessionID} goal=${goalId}`);
    // The title is deliberately left unchanged (R-036).
    await emitState(ctx, sessionID, "goal cleared");
    applied = true;
  });
  // Clearing is the operator's escape hatch: stop the running turn with it. Only
  // when the clear actually applied — a refused (foreign) clear must not touch a
  // session another live process owns.
  if (applied) await interruptSession(ctx, sessionID);
}

/**
 * Interrupt the session's active execution without resuming pending steering
 * (best-effort: an idle session is a no-op and a host without the API at this
 * version must not fail the operator's action).
 */
async function interruptSession(ctx: Context, sessionID: string): Promise<void> {
  const interrupt = (ctx.session as { interrupt?: (input: { sessionID: string; resume?: boolean }) => Promise<unknown> })
    .interrupt;
  if (typeof interrupt !== "function") return;
  try {
    await interrupt.call(ctx.session, { sessionID, resume: false });
    log(`session interrupted session=${sessionID}`);
  } catch (error) {
    logWarn(`session interrupt failed session=${sessionID}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type GatedTarget = "complete" | "unblock";

interface GatedInput {
  sessionID: string;
  target: GatedTarget;
  reason?: string | null;
  evidence?: string | null;
  evidencePath?: string | null;
}

export async function gatedTransition(deps: RuntimeDeps, input: GatedInput): Promise<GoalRecord> {
  const { store, engine, ctx, reviewer } = deps;
  const sessionID = input.sessionID;

  if (transitionGuard.has(sessionID)) {
    throw new GoalError("transition-in-flight", REASON_GLOSS["transition-in-flight"]);
  }
  transitionGuard.add(sessionID);
  try {
    const { record: recordAtStart } = await store.current(sessionID);
    if (!recordAtStart) throw new GoalError("illegal-transition", "no live goal");
    if (store.isForeign(recordAtStart)) {
      throw new GoalError("foreign-writer", `writer_pid ${recordAtStart.writer_pid}`);
    }
    const from = recordAtStart.status;
    const transition = input.target === "unblock" ? "blocked-active" : (`${from}-complete` as const);
    if (transition !== "blocked-active" && !transition.endsWith("-complete")) {
      throw new GoalError("illegal-transition", `complete from ${from}`);
    }
    if (input.target === "unblock" && from !== "blocked") {
      throw new GoalError("illegal-transition", `unblock from ${from}`);
    }

    let evidenceText: string | null = null;
    let evidenceResolved: string | null = null;
    if (input.target === "complete") {
      if (typeof input.evidence !== "string" || input.evidence.trim().length === 0) {
        throw new GoalError("evidence-required", REASON_GLOSS["evidence-required"]);
      }
      const resolved = await resolveEvidenceFile(input.evidencePath ?? null);
      evidenceResolved = resolved.path;
      evidenceText = resolved.text;
    }

    const assets = await resolveReviewAssets({
      evidencePath: evidenceResolved,
      sessionDirectory: ctx.location?.directory ?? null,
    });
    const instruction = verifierInstructionBlock({
      transition,
      profile: assets.profile,
      goalId: recordAtStart.goal_id,
      objective: recordAtStart.objective,
      status: recordAtStart.status,
      blockedReason: recordAtStart.blocked_reason,
      reason: input.reason ?? null,
    });
    const { writer_pid: _reviewWriterPid, ...reviewRecord } = recordAtStart;
    const recordSerialized = JSON.stringify(reviewRecord, null, 2);
    // Assets travel as one payload; the instruction block plus the record are
    // the tail that must survive verbatim. When payload + tail exceeds the
    // review budget, the reviewer receives the assets through the host's own
    // compaction pipeline (verifier.ts), not a cut.
    //
    // Reviewer reuse: while the goal lives and the spec/log are byte-identical,
    // the same reviewer session is resumed and the unchanged assets are omitted
    // from the payload (they are already in its earlier turns). That is the bulk
    // of the review cost, so a repeat review is a fraction of the first.
    const assetFingerprint = fingerprintAssets([assets.spec?.text ?? null, assets.log?.text ?? null, assets.profile]);
    // Reuse is durable: the reference survives a restart, and only counts when
    // it belongs to this goal and the assets it saw are byte-identical.
    const storedReviewer = await store.readReviewer(sessionID).catch(() => null);
    const reuseSessionID =
      storedReviewer &&
      storedReviewer.goal_id === recordAtStart.goal_id &&
      storedReviewer.fingerprint === assetFingerprint
        ? storedReviewer.session_id
        : null;
    // The assets are omitted only when this process has already delivered them
    // to that reviewer session: after a restart (or a host compaction we cannot
    // detect) the first reuse re-sends them, so a delta review never judges
    // against assets the reviewer no longer holds.
    const omitAssets = reuseSessionID !== null && trustedReviewers.has(reuseSessionID);
    const payloadParts: string[] = [];
    if (typeof input.reason === "string" && input.reason.trim().length > 0) {
      payloadParts.push(`Submitted reason:\n${input.reason.trim()}`);
    }
    if (typeof input.evidence === "string" && input.evidence.trim().length > 0) {
      payloadParts.push(`Submitted evidence string:\n${input.evidence.trim()}`);
    }
    if (evidenceText && evidenceResolved) {
      payloadParts.push(`----- evidence file: ${evidenceResolved} -----\n${evidenceText}`);
    }
    if (omitAssets) {
      if (assets.spec || assets.log) {
        payloadParts.push(
          "The owning spec and implementation-decisions log are unchanged since your previous review of this " +
            "goal; their text is in your earlier turns. The goal record and any submitted reason or evidence below " +
            "are current.",
        );
      }
    } else {
      if (assets.spec) {
        payloadParts.push(`----- ${assets.spec.label}: ${assets.spec.path} -----\n${assets.spec.text}`);
      }
      if (assets.log) {
        payloadParts.push(`----- ${assets.log.label}: ${assets.log.path} -----\n${assets.log.text}`);
      }
    }
    const tail = `${instruction}\n\nGoal record:\n${recordSerialized}`;
    const reviewStartedAt = Date.now();
    const review = await reviewer.review({
      sessionID,
      transition,
      profile: assets.profile,
      goalId: recordAtStart.goal_id,
      assetFingerprint,
      reuseSessionID,
      payload: payloadParts.join("\n\n"),
      tail,
    });
    // The journal is the debug trail (the record keeps no history): one line per
    // review, with the reviewer's raw answer, the model, and the timings.
    await recordReview({
      at: new Date().toISOString(),
      session_id: sessionID,
      goal_id: recordAtStart.goal_id,
      transition,
      profile: review.profile,
      reviewer_session_id: review.reviewerSessionID ?? "",
      reviewer_model: await resolveVerifierModel(ctx)
        .then((model) => (model ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}` : null))
        .catch(() => null),
      reused_reviewer: typeof reuseSessionID === "string" && reuseSessionID.length > 0,
      payload_bytes: new TextEncoder().encode(payloadParts.join("\n\n")).byteLength,
      status: review.status,
      verdict: review.status === "verdict" ? (review.approved ? "approved" : "rejected") : null,
      reason: review.reason,
      unmet: /^unmet: (.*)$/m.exec(review.raw)?.[1] ?? "",
      raw: review.raw.slice(0, 4000),
      duration_ms: Date.now() - reviewStartedAt,
    });

    // The reviewer answered (approved, rejected, or off-grammar): remember the
    // session so this goal's next review resumes it. A timeout or error removed
    // the session, so its stale reference goes with it.
    if ((review.reviewerSessionID ?? "").length > 0) {
      trustedReviewers.add(review.reviewerSessionID);
      try {
        if (review.status === "timeout" || review.status === "error") {
          await store.removeReviewer(sessionID);
          trustedReviewers.delete(review.reviewerSessionID);
        } else {
          await store.writeReviewer(sessionID, {
            goal_id: recordAtStart.goal_id,
            session_id: review.reviewerSessionID,
            fingerprint: assetFingerprint,
          });
        }
      } catch (error) {
        logWarn(`reviewer reference write failed session=${sessionID}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // The goal may have been cleared, paused, or replaced while the reviewer was
    // thinking: a stale verdict must not surface as a refusal for a goal that no
    // longer exists (the operator cleared it, and a `goal refused` line right
    // after `goal cleared` is noise at best).
    const { record: liveNow } = await store.current(sessionID).catch(() => ({ record: recordAtStart }));
    if (!liveNow || liveNow.goal_id !== recordAtStart.goal_id) {
      throw new GoalError("illegal-transition", "stale review: the goal was cleared or replaced during verification");
    }

    if (review.status === "timeout") throw new GoalError("verifier-timeout", review.reason);
    if (review.status === "error") throw new GoalError("verifier-error", review.reason);
    if (review.status === "unparseable") {
      const raw = review.raw.length > 0 ? review.raw.slice(0, 200) : "(empty)";
      throw new GoalError("verifier-unparseable", raw);
    }
    if (!review.approved) throw new GoalError("verifier-rejected", review.reason);
    // Apply under the mutex with R-046 re-validation.
    const applied = await engine.withSessionLock(sessionID, async () => {
      const { record: current } = await store.current(sessionID);
      if (!current || current.goal_id !== recordAtStart.goal_id) {
        throw new GoalError("illegal-transition", "stale review: the live goal changed during verification");
      }
      if (store.isForeign(current)) {
        throw new GoalError("foreign-writer", `writer_pid ${current.writer_pid}`);
      }
      if (input.target === "unblock" && current.status !== "blocked") {
        throw new GoalError("illegal-transition", "stale review: the goal is no longer blocked");
      }
      if (input.target === "complete") {
        // R-025: the evidence file is re-validated after the verdict.
        const recheck = await resolveEvidenceFile(input.evidencePath ?? null).catch(() => null);
        if (!recheck) throw new GoalError("evidence-vanished", REASON_GLOSS["evidence-vanished"]);
        evidenceResolved = recheck.path;
      }
      store.claim(current);
      // An approved transition clears the refusal streak (loop policy).
      current.refusal_count = 0;
      current.refusal_reason = null;
      current.verify_profile = review.profile;

      if (input.target === "unblock") {
        current.status = "active";
        current.continuing = true;
        current.stop_reason = null;
        current.no_progress_turns = 0;
        current.blocked_reason = null;
        engine.syncCounters(sessionID, current);
        const state = engine.noteGoalStarted(sessionID);
        await store.writeRecord(sessionID, current);
        log(`goal unblocked session=${sessionID} goal=${current.goal_id} profile=${review.profile}`);
        await emitState(ctx, sessionID, `goal unblocked — ${truncate(current.objective, 200)}`);
        await setSessionTitle(ctx, sessionID, current);
        engine.armLocked(sessionID, current, state);
        return current;
      }
      // complete
      current.status = "complete";
      current.active = false;
      current.continuing = false;
      engine.syncCounters(sessionID, current);
      engine.clearTimeMark(sessionID, current);
      await store.writeRecord(sessionID, current);
      await store.clearCurrent(sessionID);
      engine.discardPending(sessionID);
      log(`goal complete session=${sessionID} goal=${current.goal_id} profile=${review.profile}`);
      await emitState(ctx, sessionID, `goal complete — ${truncate(current.objective, 200)}`);
      await setSessionTitle(ctx, sessionID, current);
      return current;
    });
    // Completion removes the goal record, so its reviewer goes too. A blocked,
    // stopped, or paused goal keeps the reviewer: resume/unblock reuse the same
    // goal id.
    if (applied.status === "complete") await releaseGoalReviewer(ctx, store, sessionID, applied.goal_id);
    return applied;
  } finally {
    transitionGuard.delete(sessionID);
  }
}

/**
 * `active -> blocked` is agent-authoritative (operator direction): the operator
 * asked for blocking to skip the verifier entirely, so it applies immediately -
 * a structural `reason` is still required, the state change is durable, the
 * reason is printed for the operator, and the running turn is stopped. There is
 * no reviewer, no verdict, and no refusal loop.
 */
export async function transitionBlocked(deps: RuntimeDeps, sessionID: string, reason: string | null): Promise<GoalRecord> {
  const { store, engine, ctx } = deps;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new GoalError("blocked-reason-required", REASON_GLOSS["blocked-reason-required"]);
  }
  if (transitionGuard.has(sessionID)) {
    // One agent transition at a time per session, reviewed or not.
    throw new GoalError("transition-in-flight", REASON_GLOSS["transition-in-flight"]);
  }
  transitionGuard.add(sessionID);
  try {
    const applied = await engine.withSessionLock(sessionID, async () => {
    const { record } = await store.current(sessionID);
    if (!record) throw new GoalError("illegal-transition", "no live goal");
    if (store.isForeign(record)) throw new GoalError("foreign-writer", `writer_pid ${record.writer_pid}`);
    if (record.status !== "active") {
      throw new GoalError("illegal-transition", `blocked from ${record.status}`);
    }
    store.claim(record);
    record.status = "blocked";
    record.continuing = false;
    record.stop_reason = null;
    record.blocked_reason = reason.trim();
    record.blocked_count += 1;
    engine.syncCounters(sessionID, record);
    engine.clearTimeMark(sessionID, record);
    await store.writeRecord(sessionID, record);
    engine.discardPending(sessionID);
    log(`goal blocked session=${sessionID} goal=${record.goal_id} agent-authoritative`);
    await emitState(ctx, sessionID, `goal blocked — ${record.blocked_reason}`);
    await setSessionTitle(ctx, sessionID, record);
    return record;
  });
  // Blocking ends autonomous driving, not the agent's current turn: the record
  // is already non-continuing, so no continuation is dispatched. The turn that
  // submitted the block finishes and receives its tool result - interrupting it
  // here surfaced as "Tool execution interrupted" in the desktop and hid the
  // block reason from the agent (operator report, 2026-10-12).
  return applied;
  } finally {
    transitionGuard.delete(sessionID);
  }
}

export async function transitionActive(deps: RuntimeDeps, sessionID: string): Promise<GoalRecord> {
  const { store, engine, ctx } = deps;
  return engine.withSessionLock(sessionID, async () => {
    const { record } = await store.current(sessionID);
    if (!record) throw new GoalError("illegal-transition", "no live goal");
    if (store.isForeign(record)) throw new GoalError("foreign-writer", `writer_pid ${record.writer_pid}`);
    if (record.status !== "active") {
      throw new GoalError("illegal-transition", `cannot re-arm a ${record.status} goal`);
    }
    store.claim(record);
    record.continuing = true;
    record.stop_reason = null;
    record.no_progress_turns = 0;
    record.refusal_count = 0;
    record.refusal_reason = null;
    engine.syncCounters(sessionID, record);
    const state = engine.noteGoalStarted(sessionID);
    await store.writeRecord(sessionID, record);
    engine.discardPending(sessionID);
    log(`goal re-armed session=${sessionID} goal=${record.goal_id}`);
    await setSessionTitle(ctx, sessionID, record);
    engine.armLocked(sessionID, record, state);
    return record;
  });
}

// --------------------------------------------------------------------- tools

export async function registerTools(ctx: Context, deps: RuntimeDeps): Promise<void> {
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "set_goal",
      description: SET_GOAL_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          objective: {
            type: "string",
            description:
              "The operator's objective, verbatim: 4-4000 characters and a task statement, not a short word.",
          },
          max_turns: { type: "integer", description: "Optional positive turn ceiling." },
          max_tokens: { type: "integer", description: "Optional positive token ceiling." },
        },
        required: ["objective"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input: { objective?: unknown; max_turns?: unknown; max_tokens?: unknown }, context) => {
        const sessionID = String(context.sessionID);
        try {
          if (!objectiveValid(input.objective)) {
            throw new GoalError("objective-invalid", REASON_GLOSS["objective-invalid"]);
          }
          if (!budgetValid(input.max_turns) || !budgetValid(input.max_tokens)) {
            throw new GoalError("budget-invalid", REASON_GLOSS["budget-invalid"]);
          }
          const record = await createGoal(deps, {
            sessionID,
            objective: input.objective.trim(),
            maxTurns: typeof input.max_turns === "number" ? input.max_turns : null,
            maxTokens: typeof input.max_tokens === "number" ? input.max_tokens : null,
            actor: "agent",
          });
          return { content: JSON.stringify(goalView(record, await priorGoalCount(deps, sessionID, record.goal_id))) };
        } catch (error) {
          return await refusalResult(deps, sessionID, error);
        }
      },
    });

    editor.add({
      name: "get_goal",
      description: GET_GOAL_DESCRIPTION,
      input: { type: "object", properties: {}, required: [], additionalProperties: false },
      options: { codemode: false },
      execute: async (_input: unknown, context) => {
        const sessionID = String(context.sessionID);
        const { record, goalId } = await deps.store.current(sessionID);
        const prior = await priorGoalCount(deps, sessionID, goalId);
        const journal = reviewJournalPath(sessionID);
        if (!record) {
          return { content: JSON.stringify({ goal: null, prior_goals: prior, review_journal: journal }) };
        }
        return { content: JSON.stringify({ ...goalView(record, prior), review_journal: journal }) };
      },
    });

    editor.add({
      name: "update_goal",
      description: UPDATE_GOAL_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["active", "paused", "blocked", "complete"] },
          reason: {
            type: "string",
            description:
              "Required for blocked: the specific operator decision required, plus what you tried and observed and why no safe next action remains. For blocked→active: how the operator resolved the blocking condition.",
          },
          evidence: {
            type: "string",
            description:
              "Required for complete: a statement naming the artifact or command and its observed result that covers the full objective.",
          },
          evidence_path: {
            type: "string",
            description:
              "Required for complete: an existing readable file under the allowed roots that proves the objective; refused before review when missing, unreadable, or unrelated.",
          },
        },
        required: ["status"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (
        input: { status?: unknown; reason?: unknown; evidence?: unknown; evidence_path?: unknown },
        context,
      ) => {
        const sessionID = String(context.sessionID);
        try {
          if (transitionGuard.has(sessionID)) {
            throw new GoalError("transition-in-flight", REASON_GLOSS["transition-in-flight"]);
          }
          const status = input.status;
          if (status !== "active" && status !== "paused" && status !== "blocked" && status !== "complete") {
            throw new GoalError("illegal-transition", "status must be active, paused, blocked, or complete");
          }
          if (status === "paused") {
            // R-005: no agent tool may set paused.
            throw new GoalError("illegal-transition", "paused is operator-only; use /goal pause");
          }
          if (status === "active") {
            const { record } = await deps.store.current(sessionID);
            if (!record) throw new GoalError("illegal-transition", "no live goal");
            if (record.status === "blocked") {
              const applied = await gatedTransition(deps, {
                sessionID,
                target: "unblock",
                reason: typeof input.reason === "string" ? input.reason : null,
              });
              return { content: JSON.stringify(goalView(applied, await priorGoalCount(deps, sessionID, applied.goal_id))) };
            }
            const applied = await transitionActive(deps, sessionID);
            return { content: JSON.stringify(goalView(applied, await priorGoalCount(deps, sessionID, applied.goal_id))) };
          }
          if (status === "blocked") {
            const applied = await transitionBlocked(
              deps,
              sessionID,
              typeof input.reason === "string" ? input.reason : null,
            );
            return { content: JSON.stringify(goalView(applied, await priorGoalCount(deps, sessionID, applied.goal_id))) };
          }
          const applied = await gatedTransition(deps, {
            sessionID,
            target: "complete",
            evidence: typeof input.evidence === "string" ? input.evidence : null,
            evidencePath: typeof input.evidence_path === "string" ? input.evidence_path : null,
          });
          return { content: JSON.stringify(goalView(applied, await priorGoalCount(deps, sessionID, applied.goal_id))) };
        } catch (error) {
          return await refusalResult(deps, sessionID, error);
        }
      },
    });
  });
  log("tools registered: set_goal, get_goal, update_goal");
}

/**
 * Refusals that count toward the streak: only the verifier's own refusals.
 * Operator decision: a pre-flight evidence refusal (`evidence-required`,
 * `evidence-unreadable`, `evidence-outside-allowed-roots`, `evidence-vanished`)
 * is a cheap, immediately fixable mistake, not a failed review, so it must not
 * advance the streak or stop the loop. Structural tool misuse
 * (`illegal-transition`, `transition-in-flight`, `foreign-writer`,
 * objective/budget validation) does not count either.
 */
const VERIFIER_REFUSAL_CODES: ReadonlySet<ReasonCode> = new Set([
  "verifier-rejected",
  "verifier-timeout",
  "verifier-unparseable",
  "verifier-error",
]);

/** Reviewer sessions whose inlined assets this process has already delivered. */
const trustedReviewers = new Set<string>();

/**
 * Release a goal's reviewer: forget the reference and remove the session. Called
 * only when the goal ceases to exist (cleared, completed and auto-cleared,
 * superseded) or its session disappears — never on pause/stop/blocked, which
 * resume the same goal id and so keep the warm reviewer.
 */
async function releaseGoalReviewer(ctx: Context, store: GoalStore, sessionID: string, goalId?: string | null): Promise<void> {
  const reference = await store.readReviewer(sessionID).catch(() => null);
  if (!reference) return;
  if (goalId && reference.goal_id !== goalId) return;
  await store.removeReviewer(sessionID).catch(() => undefined);
  // The trust set is process-local bookkeeping: evict the id with the reference
  // so it cannot grow for the life of the process (or collide with a recycled
  // id in tests).
  trustedReviewers.delete(reference.session_id);
  try {
    await ctx.session.remove({ sessionID: reference.session_id });
    log(`reviewer released session=${sessionID} reviewer=${reference.session_id}`);
  } catch (error) {
    logWarn(
      `reviewer release failed session=${reference.session_id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Loop policy (operator direction): verifier refusals are counted per goal, and
 * at the limit the loop stops with `verifier-refused`. The last refusal stays on
 * the record (`refusal_reason`) and in the stop line, so the operator can act
 * without archaeology; `/goal resume` clears the streak and re-arms.
 */
async function countVerifierRefusal(
  deps: RuntimeDeps,
  sessionID: string,
  code: ReasonCode,
  detail: string,
): Promise<void> {
  const { store, engine, ctx } = deps;
  let stopped = false;
  try {
    await engine.withSessionLock(sessionID, async () => {
      const { record } = await store.current(sessionID);
      if (!record || store.isForeign(record)) return;
      // Only an actively looping goal accumulates a streak: a paused, blocked,
      // or completed goal cannot loop, so a refusal there is not a runaway.
      if (record.status !== "active" || !record.continuing) return;
      store.claim(record);
      record.refusal_count += 1;
      record.refusal_reason = `${code}: ${detail}`;
      if (record.refusal_count < PLUGIN_CONSTANTS.verifier_refusal_limit) {
        await store.writeRecord(sessionID, record);
        log(`verifier refusal counted session=${sessionID} count=${record.refusal_count}`);
        return;
      }
      record.continuing = false;
      record.stop_reason = "verifier-refused";
      engine.clearTimeMark(sessionID, record);
      await store.writeRecord(sessionID, record);
      engine.discardPending(sessionID);
      stopped = true;
      log(`goal stopped session=${sessionID} reason=verifier-refused refusals=${record.refusal_count}`);
      await emitState(
        ctx,
        sessionID,
        `goal stopped — verifier-refused after ${record.refusal_count} refusals. Last refusal: ${detail} — ` +
          "fix the evidence and `/goal resume`, or abandon it with `/goal clear`.",
      );
      await setSessionTitle(ctx, sessionID, record);
    });
  } catch (error) {
    // Accounting is best-effort: the refusal still reached the model and the
    // operator. A missing lock must not turn a refusal into an error.
    logWarn(`refusal accounting failed session=${sessionID}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The stop already makes the record non-continuing, so no continuation is
  // dispatched. The agent's current turn is deliberately left to finish: its
  // tool result is the only way it learns the goal stopped, and interrupting it
  // mid-call rendered the transition as a failed tool execution instead.
  if (stopped) log(`goal stopped session=${sessionID} (turn left to finish)`);
}

async function refusalResult(deps: RuntimeDeps, sessionID: string, error: unknown): Promise<{ content: string }> {
  const ctx = deps.ctx;
  const code: ReasonCode = error instanceof GoalError ? error.code : "verifier-error";
  const detail = error instanceof GoalError ? error.detail : error instanceof Error ? error.message : String(error);
  const line = refusalLine(code, detail);
  if (code === "illegal-transition" && detail.startsWith("stale review")) {
    // A verdict that arrived after the operator changed the goal: log it, tell
    // the model, but do not print a refusal line over the operator's own action.
    log(`goal refused (quiet) session=${sessionID} code=${code} detail=${detail}`);
    return { content: line };
  }
  await emitState(ctx, sessionID, line);
  log(`goal refused session=${sessionID} code=${code}`);
  if (VERIFIER_REFUSAL_CODES.has(code)) await countVerifierRefusal(deps, sessionID, code, detail);
  return { content: line };
}

// ------------------------------------------------------------------ commands

/**
 * Command words operators reach for that this plugin does not implement. They are
 * named as unknown subcommands instead of being treated as an objective, so
 * `/goal stop` cannot silently create a goal called "stop". Any other text is an
 * objective.
 */
const GOAL_UNKNOWN_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "stop",
  "halt",
  "cancel",
  "abort",
  "terminate",
  "kill",
  "quit",
  "exit",
  "end",
  "finish",
  "done",
  "start",
  "restart",
  "run",
  "set",
  "delete",
  "remove",
  "show",
  "info",
  "block",
  "unblock",
  "complete",
  "enable",
  "disable",
]);

export async function registerCommands(ctx: Context, deps: RuntimeDeps): Promise<void> {
  await ctx.command.transform((editor) => {
    editor.add({
      name: "goal",
      description:
        "Manage this session's goal: /goal <objective>, /goal pause, /goal resume, /goal clear, or /goal (list).",
      execute: async (input) => {
        const sessionID = String(input.sessionID);
        const text = typeof input.prompt?.text === "string" ? input.prompt.text.trim() : "";
        const lower = text.toLowerCase();
        try {
          if (text.length === 0 || lower === "list" || lower === "status") {
            await listGoals(ctx, deps, sessionID);
            return;
          }
          if (lower === "pause") {
            await pauseGoal(deps, sessionID);
            return;
          }
          if (lower === "resume") {
            await resumeGoal(deps, sessionID);
            return;
          }
          if (lower === "clear") {
            await clearGoal(deps, sessionID);
            return;
          }
          // Command-shaped words this plugin does not implement must be named,
          // never mistaken for an objective: `/goal stop` used to try to create
          // a goal called "stop" (and failed with a goal-exists refusal).
          if (GOAL_UNKNOWN_SUBCOMMANDS.has(lower) || lower === "help") {
            log(`command unknown subcommand session=${sessionID} text=${lower}`);
            await emitState(
              ctx,
              sessionID,
              `goal: unknown subcommand '${text}' — use /goal <objective>, /goal pause, /goal resume, ` +
                "/goal clear, or /goal to list.",
            );
            return;
          }
          if (!objectiveValid(text)) {
            await emitState(ctx, sessionID, refusalLine("objective-invalid"));
            return;
          }
          await createGoal(deps, {
            sessionID,
            objective: text,
            maxTurns: null,
            maxTokens: null,
            actor: "operator",
          });
        } catch (error) {
          const code: ReasonCode = error instanceof GoalError ? error.code : "verifier-error";
          await emitState(ctx, sessionID, refusalLine(code, error instanceof GoalError ? error.detail : undefined));
          log(`command refused session=${sessionID} code=${code}`);
        }
      },
    });
  });
  log("command registered: /goal");
}

export async function listGoals(ctx: Context, deps: RuntimeDeps, sessionID: string): Promise<void> {
  const goals = await deps.store.listGoals(sessionID);
  if (goals.length === 0) {
    await emitState(ctx, sessionID, "no goals");
    return;
  }
  const { goalId } = await deps.store.current(sessionID);
  for (const goal of goals) {
    const live = goalId !== null && goal.goal_id === goalId ? " — live" : "";
    await emitState(
      ctx,
      sessionID,
      `goal ${goal.goal_id} — ${goal.status} — ${goal.turns_used} turns — ${truncate(goal.objective, 120)}${live}`,
    );
  }
}

// --------------------------------------------------------------------- hooks

export function goalSnapshot(record: GoalRecord): string {
  const continuing = record.continuing ? "continuing" : `not continuing (${record.stop_reason ?? "stopped"})`;
  return (
    `Session goal (${record.goal_id}, status: ${record.status}, ${continuing}, ` +
    `${record.turns_used} turns used):\n\n${fenceInstruction()}\n\n<objective>\n${record.objective}\n</objective>`
  );
}

export async function registerHooks(ctx: Context, deps: RuntimeDeps): Promise<void> {
  const inject = async (event: { sessionID?: unknown; system?: Array<{ type: string; text: string }> }) => {
    const sessionID = typeof event.sessionID === "string" ? event.sessionID : undefined;
    if (!sessionID || !Array.isArray(event.system)) return;
    const { record } = await deps.store.current(sessionID); // pure read, no mutex
    if (!record) return;
    event.system.push({ type: "text", text: goalSnapshot(record) });
  };
  await ctx.session.hook("context", inject);
  await ctx.session.hook("compaction", inject);
  log("hooks registered: context, compaction");
}

// --------------------------------------------------------------------- events

function durableSeq(event: PluginEvent): number | undefined {
  const durable = event.durable as { seq?: unknown } | undefined;
  if (!durable || typeof durable !== "object") return undefined;
  return typeof durable.seq === "number" ? durable.seq : undefined;
}

export async function handleEvent(ctx: Context, deps: RuntimeDeps, event: PluginEvent): Promise<void> {
  const type = String(event.type);
  const data = event.data ?? {};
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
  switch (type) {
    case "session.execution.started": {
      if (sessionID) deps.engine.onExecutionStarted(sessionID);
      return;
    }
    case "session.execution.succeeded": {
      if (!sessionID || durableSeq(event) === undefined) return;
      await deps.engine.onTerminal("succeeded", sessionID, { seq: durableSeq(event) });
      return;
    }
    case "session.execution.failed": {
      if (!sessionID || durableSeq(event) === undefined) return;
      await deps.engine.onTerminal("failed", sessionID, { seq: durableSeq(event) });
      return;
    }
    case "session.execution.interrupted": {
      if (!sessionID || durableSeq(event) === undefined) return;
      await deps.engine.onTerminal("interrupted", sessionID, {
        seq: durableSeq(event),
        reason: typeof data.reason === "string" ? data.reason : undefined,
      });
      return;
    }
    case "session.usage.updated": {
      // Observability/accounting events are exempt from R-003's trigger ban.
      if (!sessionID) return;
      const tokens = data.tokens as { input?: unknown; output?: unknown } | undefined;
      if (tokens && typeof tokens.input === "number" && typeof tokens.output === "number") {
        deps.engine.onUsage(sessionID, { input: tokens.input, output: tokens.output });
      }
      return;
    }
    case "session.tool.called": {
      // A locally executed tool call is `executed !== true` (inverted name:
      // executed=true means the provider host ran it; see publish-llm-event.ts).
      if (sessionID && data.executed !== true) deps.engine.onDrainProgress(sessionID, "tool");
      return;
    }
    case "session.text.ended": {
      if (sessionID) {
        noteTextEnded(sessionID, String(data.text ?? ""));
        if (String(data.text ?? "").trim().length > 0) deps.engine.onDrainProgress(sessionID, "text");
      }
      return;
    }
    case "session.step.ended": {
      if (sessionID && String(data.finish ?? "") === "length") deps.engine.onDrainProgress(sessionID, "length");
      return;
    }
    case "session.compaction.ended": {
      // R-009a names the context-overflow (auto) compaction as progress; a
      // manual compaction is operator housekeeping and does not reset the
      // no-progress streak.
      if (sessionID && String(data.reason ?? "") === "auto") deps.engine.onDrainProgress(sessionID, "compaction");
      return;
    }
    case "session.deleted": {
      if (sessionID) {
        // Release host objects the swept keys reference (the reviewer session)
        // before the sweep drops the reference.
        await releaseGoalReviewer(ctx, deps.store, sessionID);
        await deps.engine.sweepSession(sessionID);
      }
      return;
    }
    default:
      return;
  }
}

async function consumeEvents(ctx: Context, deps: RuntimeDeps, signal: AbortSignal): Promise<void> {
  // The subscription is the loop's only driver (R-002/R-003). If the host's
  // stream ends unexpectedly — a plugin-generation rebuild has been observed
  // to silently detach it — reconcile (R-040, idempotent through the
  // one-pending guard) and resubscribe rather than leaving an active goal
  // with nothing driving it. Found by the Scope B live e2e (D-063).
  while (!signal.aborted) {
    try {
      for await (const raw of ctx.event.subscribe({ signal })) {
        const event = raw as unknown as PluginEvent;
        try {
          await handleEvent(ctx, deps, event);
        } catch (error) {
          logWarn(`event handling failed type=${event.type}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      logWarn(`event subscription failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (signal.aborted) return;
    logWarn("event subscription ended unexpectedly; reconciling and resubscribing");
    try {
      await deps.engine.reconcile();
    } catch (error) {
      logWarn(`resubscribe reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, PLUGIN_CONSTANTS.min_continue_interval_ms));
  }
}

// --------------------------------------------------------------------- setup
//
// ponytail: ceiling: no dedicated TUI or desktop widget; the session title carries goal state per R-036 and the synthetic line carries transitions per R-035; upgrade when: an operator asks for at-a-glance goal state in either surface

async function setup(ctx: Context): Promise<() => void> {
  const controller = new AbortController();
  const store = new GoalStore({ storage: ctx.storage as StoragePort, pid: process.pid });
  const mutex: SessionMutex = sessionMutex();
  // The engine releases a session's reviewer before its keys are swept; the
  // callback needs the deps object, which is built right after the engine.
  let releaseReviewerHook: ((sessionID: string) => Promise<void>) | null = null;
  const engine = new GoalEngine({
    store,
    mutex,
    session: {
      prompt: (input) => ctx.session.prompt(input as never),
      synthetic: (input) => ctx.session.synthetic(input as never),
      get: async (input) => ctx.session.get(input as never),
    },
    emit: (sessionID, description) => emitState(ctx, sessionID, description),
    setTitle: (sessionID, record) => setSessionTitle(ctx, sessionID, record),
    isPrimaryAgent: (agent) => typeof agent === "string" && PRIMARY_AGENTS.has(agent),
    releaseReviewer: (sessionID) => (releaseReviewerHook ? releaseReviewerHook(sessionID) : Promise.resolve()),
  });
  const deps: RuntimeDeps = { ctx, store, engine, reviewer: createReviewer(ctx) };
  releaseReviewerHook = (sessionID) => releaseGoalReviewer(ctx, store, sessionID);

  log(`setup pid=${process.pid} location=${ctx.location?.directory ?? "unknown"}`);
  void consumeEvents(ctx, deps, controller.signal);
  await registerTools(ctx, deps);
  await registerCommands(ctx, deps);
  await registerHooks(ctx, deps);

  void (async () => {
    try {
      const pruned = await pruneReviews();
      if (pruned > 0) log(`review journal pruned files=${pruned}`);
      await engine.reconcile();
      await engine.sweepMissingSessions();
    } catch (error) {
      logWarn(`startup reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

  return () => {
    controller.abort();
    engine.shutdown();
    log("cleanup");
  };
}

const definition: Plugin = { id: PLUGIN_ID, setup };
export default definition;

