// Continuation engine: the one-pending-submission guard, ceilings and the
// no-progress failsafe classification, the durable-first stop with its
// best-effort handoff (R-042), owner-gating, and restart reconciliation
// (R-037, R-037a, R-009a, R-040, R-043, R-044c, R-045).
//
// Per-process state lives here and is shared by every plugin instance in the
// process (R-014: the guard is per process). Nothing durable about a dispatch
// is kept: the binding is the armed goal_id and its kind, in memory, consulted
// when a turn ends (R-045).
//
// ponytail: ceiling: continuation may overlap a running subagent child session; a live gate is feasible (session.created carries parentID at packages/schema/src/session-event.ts:48-64, and child execution events are observable in-location) but post-restart child enumeration is not exposed on 2.0.26, since SessionDomain has no list or children method; upgrade when: the live gate is implemented or a child-session query exists
// ponytail: ceiling: continuation durability is verified only against a local server; upgrade when: a paired or remote stream is tested
// ponytail: ceiling: the host does not exclude two servers from one session and a plugin can neither detect nor exclude another server, so goal safety rests on our own owner-gating and an owned SQLite mutex; pid reuse can make a dead owner look alive, and an unavailable mutex degrades to detection, leaving the R-029b residual. upgrade when: ctx.storage exposes a conditional write or transaction, or the host exposes per-session writer ownership.

import { GoalError, GoalStore, PLUGIN_CONSTANTS, StorageWriteError } from "./state.ts";
import type { GoalRecord } from "./state.ts";
import type { SessionMutex } from "./mutex.ts";
import { continuationPrompt, handoffPrompt } from "./prompts.ts";
import { log, logDebug, logWarn } from "./log.ts";

export type TerminalKind = "succeeded" | "failed" | "interrupted";

interface PendingSubmission {
  goalId: string;
  timer: unknown;
  waitingForTerminal: boolean;
  submitFailures: number;
  mutexFailures: number;
}

interface SessionState {
  pending: PendingSubmission | null;
  binding: { goalId: string; kind: "continuation" | "handoff" } | null;
  lastSeq: number | null;
  drainProgress: boolean;
  timeMark: number | null;
  deferredStop: "state-write-failed" | null;
  terminalRetries: number;
}

export interface SessionOps {
  prompt(input: { sessionID: string; text: string; resume?: boolean; delivery?: "steer" | "queue" }): Promise<unknown>;
  /**
   * The continuation channel: the model receives `text`, the operator sees only
   * `description`. A synthetic keeps the automatic instruction out of the
   * operator's transcript instead of injecting a wall of prompt text.
   */
  synthetic(input: {
    sessionID: string;
    text: string;
    description: string;
    resume?: boolean;
    delivery?: "steer" | "queue";
  }): Promise<unknown>;
  get(input: { sessionID: string }): Promise<{ id?: string; agent?: string } | undefined>;
}

export interface EngineDeps {
  store: GoalStore;
  mutex: SessionMutex;
  session: SessionOps;
  emit: (sessionID: string, description: string) => Promise<void>;
  setTitle: (sessionID: string, record: GoalRecord) => Promise<void>;
  /** R-013: continuation runs only while the session's agent is a build-time primary. */
  isPrimaryAgent?: (agent: string | undefined) => boolean;
  /**
   * Called before a session's keys are swept, so state that owns a host object
   * (the reviewer session) can be released before its reference disappears.
   */
  releaseReviewer?: (sessionID: string) => Promise<void>;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface ArmOptions {
  /** Skip the min_continue_interval_ms wait (a released or resumed pending). */
  immediate?: boolean;
}

const NO_HANDOFF_REASONS = new Set(["execution-failed", "state-write-failed", "submit-failed"]);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class GoalEngine {
  private readonly deps: EngineDeps;
  private readonly store: GoalStore;
  private readonly mutex: SessionMutex;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly states = new Map<string, SessionState>();
  /** Sessions with an execution in flight, including ones with no goal yet. */
  private readonly executing = new Set<string>();
  /** Cumulative session token totals observed from session.usage.updated. */
  private readonly usage = new Map<string, { input: number; output: number }>();
  private closed = false;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.mutex = deps.mutex;
    this.now = deps.now ?? (() => Date.now());
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  // ---------------------------------------------------------------- registry

  private ensureState(sessionID: string): SessionState {
    let state = this.states.get(sessionID);
    if (!state) {
      state = {
        pending: null,
        binding: null,
        lastSeq: null,
        drainProgress: false,
        timeMark: null,
        deferredStop: null,
        terminalRetries: 0,
      };
      this.states.set(sessionID, state);
    }
    return state;
  }

  isExecuting(sessionID: string): boolean {
    return this.executing.has(sessionID);
  }

  currentTokens(sessionID: string): number {
    const usage = this.usage.get(sessionID);
    return usage ? usage.input + usage.output : 0;
  }

  // ------------------------------------------------------- counter flushing

  /** tokens_used = current cumulative (input+output) - baseline (Target State). */
  syncCounters(sessionID: string, record: GoalRecord): void {
    // ponytail: ceiling: tokens_used may undercount by the compacted prefix; upgrade when: token usage can be read after compaction
    const usage = this.usage.get(sessionID);
    if (usage) {
      record.tokens_used = Math.max(0, usage.input + usage.output - record.tokens_baseline);
    }
  }

  /** Monotonic wall clock accumulated only while continuing is true. */
  flushTime(sessionID: string, record: GoalRecord): void {
    const state = this.ensureState(sessionID);
    if (state.timeMark !== null) {
      record.time_used_seconds = Math.max(
        0,
        record.time_used_seconds + Math.max(0, (this.now() - state.timeMark) / 1000),
      );
    }
    state.timeMark = this.now();
  }

  clearTimeMark(sessionID: string, record: GoalRecord): void {
    this.flushTime(sessionID, record);
    this.ensureState(sessionID).timeMark = null;
  }

  /** Creation or resume: mark the clock and register the session. */
  noteGoalStarted(sessionID: string): SessionState {
    const state = this.ensureState(sessionID);
    state.timeMark = this.now();
    return state;
  }

  // ------------------------------------------------------------- drain state

  onUsage(sessionID: string, tokens: { input: number; output: number }): void {
    this.usage.set(sessionID, { input: tokens.input, output: tokens.output });
  }

  onExecutionStarted(sessionID: string): void {
    // Tracked for every session, not only ones with goal records: a goal can be
    // created mid-turn, and its first arm must know the turn is in flight.
    this.executing.add(sessionID);
  }

  onDrainProgress(sessionID: string, signal: "tool" | "text" | "length" | "compaction"): void {
    const state = this.states.get(sessionID);
    if (!state) return;
    state.drainProgress = true;
    logDebug(`drain progress session=${sessionID} signal=${signal}`);
  }

  // --------------------------------------------------------------- terminals

  async onTerminal(
    kind: TerminalKind,
    sessionID: string,
    options: { reason?: string; seq?: number; force?: boolean } = {},
  ): Promise<void> {
    if (this.closed) return;
    // Execution bookkeeping is independent of goal records. shutdown and
    // superseded preserve the in-flight state (the host resumes it / the
    // successor continues it); every other terminal ends it.
    if (
      kind !== "interrupted" ||
      (options.reason !== "shutdown" && options.reason !== "superseded")
    ) {
      this.executing.delete(sessionID);
    }
    const state = this.states.get(sessionID);
    if (!state) {
      logDebug(`ignoring terminal ${kind} for session with no goal record ${sessionID}`);
      return;
    }
    if (typeof options.seq === "number" && !options.force) {
      if (state.lastSeq === options.seq) {
        logDebug(`duplicate durable.seq ${options.seq} session=${sessionID}`);
        return;
      }
      state.lastSeq = options.seq;
    }

    if (kind === "interrupted") {
      const reason = options.reason;
      if (reason === "shutdown") {
        // The host preserves the claim and resumes the turn; neither stop nor
        // arm, and any held pending must not steer into the resumed turn.
        this.holdPendingForTerminal(state);
        log(`interrupted(shutdown) session=${sessionID}: leaving the goal untouched`);
        return;
      }
      if (reason === "superseded") {
        // The successor execution's terminal is authoritative.
        this.holdPendingForTerminal(state);
        log(`interrupted(superseded) session=${sessionID}: successor terminal governs`);
        return;
      }
      if (reason !== "user" && reason !== "inactivity") {
        logWarn(
          `interrupted(unknown reason=${String(reason)}) session=${sessionID}: stopping as execution-failed`,
        );
      }
    }

    try {
      await this.withSessionLock(sessionID, async () => {
        await this.processTerminalLocked(kind, sessionID, options.reason, state);
      });
    } catch (error) {
      if (error instanceof StorageWriteError) {
        // R-031: a ctx.storage write failure stops the goal; never continue blind.
        await this.stopForStorageFailure(sessionID, state);
        return;
      }
      if (error instanceof GoalError && error.code === "state-locked") {
        // Mutex contention is transient: retry the terminal on the normal
        // spacing (bypassing the seq dedup), bounded like other retries.
        const retries = state.terminalRetries + 1;
        state.terminalRetries = retries;
        if (retries > PLUGIN_CONSTANTS.submit_failure_limit) {
          logWarn(`terminal dropped after ${retries - 1} lock retries session=${sessionID} kind=${kind}`);
          return;
        }
        logWarn(`terminal retry ${retries} (mutex held) session=${sessionID} kind=${kind}`);
        this.schedule(() => {
          void this.onTerminal(kind, sessionID, { ...options, force: true });
        }, PLUGIN_CONSTANTS.min_continue_interval_ms);
        return;
      }
      logWarn(`terminal processing failed session=${sessionID}: ${errorText(error)}`);
    }
  }

  /** R-031: durable-first stop after a storage write failure. */
  private async stopForStorageFailure(sessionID: string, state: SessionState): Promise<void> {
    state.drainProgress = false;
    this.discardPendingLocked(state);
    try {
      await this.withSessionLock(sessionID, async () => {
        const { record } = await this.store.current(sessionID);
        if (!record || this.store.isForeign(record)) return;
        if (!record.continuing && record.stop_reason !== null) return;
        if (record.writer_pid !== this.store.writerPid) this.store.claim(record);
        record.continuing = false;
        record.stop_reason = "state-write-failed";
        this.flushTime(sessionID, record);
        state.timeMark = null;
        await this.store.writeRecord(sessionID, record);
        log(`goal stopped session=${sessionID} reason=state-write-failed`);
        try {
          await this.deps.emit(sessionID, "goal stopped — state-write-failed");
        } catch {
          // emission is best-effort
        }
        try {
          await this.deps.setTitle(sessionID, record);
        } catch {
          // title is best-effort
        }
      });
    } catch (error) {
      // The stop write failed too: keep the deferred stop so the next
      // successful acquisition lands it (R-031 with R-044b's shape).
      if (!state.deferredStop) {
        state.deferredStop = "state-write-failed";
        try {
          await this.deps.emit(sessionID, "goal stopped — state-write-failed");
        } catch {
          // emission is best-effort
        }
      }
      logWarn(`storage-failure stop deferred session=${sessionID}: ${errorText(error)}`);
    }
  }

  private async processTerminalLocked(
    kind: TerminalKind,
    sessionID: string,
    reason: string | undefined,
    state: SessionState,
  ): Promise<void> {
    const { record, goalId } = await this.store.current(sessionID);
    const binding = state.binding;
    state.binding = null;

    if (!record || !goalId) {
      this.discardPending(state);
      state.drainProgress = false;
      logDebug(`terminal for session with no live goal ${sessionID}`);
      return;
    }

    if (binding && binding.goalId !== goalId) {
      // R-045: bound to a generation that no longer names :current — applied to
      // nothing; arm the current goal's next continuation instead.
      log(
        `terminal bound to superseded goal ${binding.goalId} session=${sessionID}; current=${goalId}; applying nothing`,
      );
      if (state.pending && state.pending.goalId !== goalId) this.discardPending(state);
      this.armLocked(sessionID, record, state);
      return;
    }

    if (this.store.isForeign(record)) {
      // R-043: a foreign record is passive — no read-modify-write, no drive.
      logDebug(`terminal for foreign-owned goal session=${sessionID}`);
      this.discardPending(state);
      return;
    }
    if (record.writer_pid !== this.store.writerPid) {
      // Dead-owner takeover: the taker's pid is recorded before anything else.
      this.store.claim(record);
      await this.store.writeRecord(sessionID, record);
    }

    if (!record.continuing && record.stop_reason !== null) {
      // Stopped records are write-protected from terminals (R-045).
      logDebug(`terminal ignored for stopped goal session=${sessionID} reason=${record.stop_reason}`);
      this.discardPending(state);
      return;
    }

    if (binding && binding.kind === "handoff") {
      // R-042/AC-50: a handoff turn is never re-evaluated for ceilings or
      // progress and never re-arms the loop — even when the record was
      // resumed or re-armed while the handoff was in flight.
      logDebug(`handoff terminal applied to nothing session=${sessionID}`);
      state.drainProgress = false;
      return;
    }

    if (kind === "failed") {
      this.syncCounters(sessionID, record);
      record.turns_used += 1;
      state.drainProgress = false;
      await this.durableStopLocked(sessionID, record, "execution-failed", state, { handoff: false });
      return;
    }

    if (kind === "interrupted") {
      this.syncCounters(sessionID, record);
      record.turns_used += 1;
      state.drainProgress = false;
      if (!record.continuing) {
        // The goal was already paused, blocked, or stopped when we interrupted
        // its turn (our own pause/clear/block/refusal stop does exactly that):
        // the interrupt must not stamp a stop reason over that state.
        this.discardPending(state);
        await this.store.writeRecord(sessionID, record);
        logDebug(`interrupt terminal on a non-continuing goal session=${sessionID}`);
        return;
      }
      const stopReason = reason === "user" ? "user" : "execution-failed";
      await this.durableStopLocked(sessionID, record, stopReason, state, { handoff: false });
      return;
    }

    // kind === "succeeded": classify the drain from observables (R-009a).
    const progress = state.drainProgress;
    state.drainProgress = false;
    if (progress) {
      record.no_progress_turns = 0;
    } else {
      record.no_progress_turns += 1;
      log(`no progress turn ${record.no_progress_turns} session=${sessionID}`);
    }
    record.turns_used += 1;
    this.syncCounters(sessionID, record);
    this.flushTime(sessionID, record);

    const trip = this.evaluateStop(record);
    if (trip) {
      await this.durableStopLocked(sessionID, record, trip, state, { handoff: true });
      return;
    }

    // Only a continuable record arms: an operator pause or a cleared goal must
    // not leave a timer behind (dispatch would discard it, but arming it at all
    // is noise and a correctness trap if the guard ever drifts).
    if (record.status !== "active" || !record.continuing || record.stop_reason !== null) {
      logDebug(`terminal does not arm session=${sessionID} status=${record.status} continuing=${record.continuing}`);
      this.discardPending(state);
      await this.store.writeRecord(sessionID, record);
      return;
    }

    await this.store.writeRecord(sessionID, record);
    this.armLocked(sessionID, record, state);
  }

  private evaluateStop(record: GoalRecord): "max_turns" | "max_tokens" | "no-progress" | null {
    if (record.max_turns !== null && record.turns_used >= record.max_turns) return "max_turns";
    if (record.max_tokens !== null && record.tokens_used >= record.max_tokens) return "max_tokens";
    if (record.no_progress_turns >= PLUGIN_CONSTANTS.no_progress_limit) return "no-progress";
    return null;
  }

  /**
   * R-042: one durable write (reason + continuing:false) and one stop line
   * first; then a single best-effort handoff turn, inline, for ceiling and
   * no-progress stops only.
   */
  private async durableStopLocked(
    sessionID: string,
    record: GoalRecord,
    reason: GoalRecord["stop_reason"],
    state: SessionState,
    options: { handoff: boolean },
  ): Promise<void> {
    record.continuing = false;
    record.stop_reason = reason;
    this.flushTime(sessionID, record);
    state.timeMark = null;
    // A newer authoritative stop supersedes any deferred storage-failure stop.
    state.deferredStop = null;
    await this.store.writeRecord(sessionID, record);
    this.discardPending(state);
    try {
      await this.deps.emit(sessionID, `goal stopped — ${reason}`);
    } catch (error) {
      logWarn(`stop emission failed session=${sessionID}: ${errorText(error)}`);
    }
    try {
      await this.deps.setTitle(sessionID, record);
    } catch {
      // title is best-effort
    }
    log(`goal stopped session=${sessionID} reason=${reason}`);
    if (!options.handoff || record.stop_reason === null || NO_HANDOFF_REASONS.has(record.stop_reason)) return;
    try {
      await this.deps.session.synthetic({
        sessionID,
        text: handoffPrompt({ objective: record.objective, stopReason: record.stop_reason }),
        description: "goal handoff (loop stopped)",
        // Queued, like continuations: an operator interrupt must not wake it.
        delivery: "queue",
      });
      state.binding = { goalId: record.goal_id, kind: "handoff" };
      log(`handoff dispatched session=${sessionID} reason=${record.stop_reason}`);
    } catch (error) {
      // Best-effort by contract: a lost handoff is not retried and not durable.
      logWarn(`handoff lost session=${sessionID}: ${errorText(error)}`);
    }
  }

  // ------------------------------------------------------ pending submission

  /**
   * The one-pending guard with the generation-aware invalidation of R-037.
   * Caller holds the session lock.
   */
  armLocked(sessionID: string, record: GoalRecord, state: SessionState, options: ArmOptions = {}): void {
    const goalId = record.goal_id;
    const pending = state.pending;
    if (pending) {
      if (pending.goalId === goalId) {
        if (pending.waitingForTerminal) {
          pending.waitingForTerminal = false;
          this.schedulePending(sessionID, pending, 0);
        }
        return;
      }
      // A pending armed for a superseded goal cannot consume the successor's
      // only arming opportunity (R-037, R-045).
      this.discardPending(state);
    }
    const next: PendingSubmission = {
      goalId,
      timer: null,
      waitingForTerminal: this.isExecuting(sessionID),
      submitFailures: 0,
      mutexFailures: 0,
    };
    state.pending = next;
    if (next.waitingForTerminal) {
      logDebug(`pending waits for the in-flight terminal session=${sessionID}`);
      return;
    }
    this.schedulePending(sessionID, next, options.immediate ? 0 : PLUGIN_CONSTANTS.min_continue_interval_ms);
  }

  private schedulePending(sessionID: string, pending: PendingSubmission, delayMs: number): void {
    if (pending.timer !== null) {
      this.cancel(pending.timer);
      pending.timer = null;
    }
    pending.timer = this.schedule(() => {
      pending.timer = null;
      void this.dispatch(sessionID, pending);
    }, delayMs);
  }

  /** Public: /goal resume and clear discard any pending submission. */
  discardPending(sessionID: string): void {
    const state = this.states.get(sessionID);
    if (!state) return;
    this.discardPendingLocked(state);
  }

  private discardPendingLocked(state: SessionState): void {
    const pending = state.pending;
    if (!pending) return;
    if (pending.timer !== null) this.cancel(pending.timer);
    state.pending = null;
  }

  /** A non-stopping interruption holds the pending for the resumed term. */
  private holdPendingForTerminal(state: SessionState): void {
    const pending = state.pending;
    if (!pending) return;
    if (pending.timer !== null) {
      this.cancel(pending.timer);
      pending.timer = null;
    }
    pending.waitingForTerminal = true;
  }

  // -------------------------------------------------------------- dispatching

  private async dispatch(sessionID: string, pending: PendingSubmission): Promise<void> {
    if (this.closed) return;
    let state = this.states.get(sessionID);
    if (!state || state.pending !== pending) return;
    if (this.isExecuting(sessionID)) {
      pending.waitingForTerminal = true;
      return;
    }

    let outcome: "dispatched" | "discarded" | "retry" | "stopped" | "locked" = "retry";
    try {
      await this.withSessionLock(sessionID, async () => {
        state = this.states.get(sessionID);
        if (!state || state.pending !== pending) {
          outcome = "discarded";
          return;
        }
        const { record, goalId } = await this.store.current(sessionID);
        if (!record || goalId !== pending.goalId || record.status !== "active" || !record.continuing) {
          outcome = "discarded"; // paused, blocked, completed, cleared, or replaced
          return;
        }
        if (this.store.isForeign(record)) {
          outcome = "discarded"; // R-043: never dispatch for a foreign record
          return;
        }
        if (this.isExecuting(sessionID)) {
          pending.waitingForTerminal = true;
          outcome = "discarded";
          return;
        }
        if (record.writer_pid !== this.store.writerPid) {
          this.store.claim(record);
          await this.store.writeRecord(sessionID, record);
        }
        if (this.deps.isPrimaryAgent) {
          // R-013: continuation runs only on a primary agent.
          const info = await this.deps.session.get({ sessionID }).catch(() => undefined);
          const agent = typeof info?.agent === "string" ? info.agent : undefined;
          if (!this.deps.isPrimaryAgent(agent)) {
            log(`continuation refused: session=${sessionID} agent=${agent ?? "unknown"} is not primary`);
            outcome = "discarded";
            return;
          }
        }
        const text = continuationPrompt({
          objective: record.objective,
          goalId: record.goal_id,
          turnsUsed: record.turns_used,
          maxTurns: record.max_turns,
          tokensUsed: record.tokens_used,
          maxTokens: record.max_tokens,
        });
        try {
          // `queue`, never `steer`: an operator interrupt with resume=true wakes
          // steer-scoped work, so a steered continuation would restart the loop
          // the operator just stopped (execution.ts:153-169). Queued prompts
          // stay parked across that wake and run in their normal turn order.
          //
          // Synthetic, not a prompt: the model still receives the full
          // instruction as its text, while the operator's transcript shows one
          // status line instead of the automatic prompt text.
          await this.deps.session.synthetic({
            sessionID,
            text,
            description: "goal continuation",
            delivery: "queue",
          });
          state.binding = { goalId: pending.goalId, kind: "continuation" };
          state.pending = null;
          outcome = "dispatched";
        } catch (error) {
          pending.submitFailures += 1;
          logWarn(
            `continuation submit failed (${pending.submitFailures}/${PLUGIN_CONSTANTS.submit_failure_limit}) ` +
              `session=${sessionID}: ${errorText(error)}`,
          );
          if (pending.submitFailures >= PLUGIN_CONSTANTS.submit_failure_limit) {
            this.syncCounters(sessionID, record);
            await this.durableStopLocked(sessionID, record, "submit-failed", state, { handoff: false });
            outcome = "stopped";
          } else {
            outcome = "retry";
          }
        }
      });
    } catch (error) {
      if (error instanceof GoalError && error.code === "state-locked") {
        pending.mutexFailures += 1;
        logWarn(
          `continuation deferred (mutex unavailable, ${pending.mutexFailures}/${PLUGIN_CONSTANTS.submit_failure_limit}) session=${sessionID}`,
        );
        if (pending.mutexFailures >= PLUGIN_CONSTANTS.submit_failure_limit) {
          // R-044b: stop driving immediately in-process; write nothing to the
          // unlocked record; the durable stop lands on the next acquisition.
          if (state.pending === pending) state.pending = null;
          state.deferredStop = "state-write-failed";
          try {
            await this.deps.emit(sessionID, "goal stopped — state-write-failed");
          } catch {
            // emission is best-effort
          }
          return;
        }
        outcome = "retry";
      } else {
        logWarn(`continuation dispatch error session=${sessionID}: ${errorText(error)}`);
        outcome = "retry";
      }
    }

    const finalState = this.states.get(sessionID);
    if (!finalState || finalState.pending !== pending) return;
    if (outcome === "retry") {
      this.schedulePending(sessionID, pending, PLUGIN_CONSTANTS.min_continue_interval_ms);
      return;
    }
    if (outcome === "discarded") {
      if (finalState.pending === pending) finalState.pending = null;
    }
  }

  private async applyDeferredStop(sessionID: string): Promise<void> {
    const state = this.states.get(sessionID);
    if (!state?.deferredStop) return;
    const reason = state.deferredStop;
    state.deferredStop = null;
    try {
      const { record } = await this.store.current(sessionID);
      if (!record || this.store.isForeign(record)) return;
      if (record.writer_pid !== this.store.writerPid) this.store.claim(record);
      // Apply only while the record still needs a stop: a newer authoritative
      // stop (ceiling, user, pause) that landed in the meantime wins, and the
      // deferred state-write-failed must never overwrite it (Scope B review
      // finding 3).
      if (record.continuing && record.stop_reason === null) {
        record.continuing = false;
        record.stop_reason = reason;
        this.flushTime(sessionID, record);
        state.timeMark = null;
        await this.store.writeRecord(sessionID, record);
        log(`deferred stop applied session=${sessionID} reason=${reason}`);
      }
    } catch (error) {
      logWarn(`deferred stop failed session=${sessionID}: ${errorText(error)}`);
    }
  }

  // ------------------------------------------------------------- locking

  /**
   * The single locked entry point for every mutation and driving decision.
   * Pure reads never take this path (R-044).
   */
  async withSessionLock<T>(sessionID: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.withLock(sessionID, async () => {
      await this.applyDeferredStop(sessionID);
      return fn();
    });
  }

  // ------------------------------------------------------- reconciliation

  /**
   * R-040: re-arm goals a restart left active and continuing. Known residual
   * (recorded, not solved): after a restart, `executing` is empty, so the
   * no-steer guarantee rests on observing the resumed turn's `started` event
   * before the re-armed delay elapses; no plugin API exposes in-flight state.
   */
  async reconcile(): Promise<number> {
    const sessionIDs = await this.store.listCurrentPointers();
    let armed = 0;
    for (const sessionID of sessionIDs) {
      try {
        const armedHere = await this.withSessionLock(sessionID, async () => {
          const { record, goalId } = await this.store.current(sessionID);
          if (!record || !goalId) return false;
          if (!record.active || !record.continuing) return false;
          if (this.store.isForeign(record)) {
            log(`reconcile: goal session=${sessionID} owned by live pid ${record.writer_pid}; skipped`);
            this.ensureState(sessionID);
            return false;
          }
          const info = await this.deps.session.get({ sessionID }).catch(() => undefined);
          if (!info || typeof info.id !== "string") {
            log(`reconcile: session ${sessionID} no longer resolves; skipped`);
            return false;
          }
          if (record.writer_pid !== this.store.writerPid) {
            this.store.claim(record);
            await this.store.writeRecord(sessionID, record);
          }
          const state = this.noteGoalStarted(sessionID);
          this.armLocked(sessionID, record, state);
          return true;
        });
        if (armedHere) {
          armed += 1;
          log(`reconcile: re-armed goal session=${sessionID}`);
        }
      } catch (error) {
        logWarn(`reconcile failed session=${sessionID}: ${errorText(error)}`);
      }
    }
    return armed;
  }

  // --------------------------------------------------------------- sweeps

  /** R-030: sweep every key and the mutex row for a deleted session. */
  async sweepSession(sessionID: string): Promise<void> {
    const state = this.states.get(sessionID);
    if (state) {
      this.discardPendingLocked(state);
      this.states.delete(sessionID);
    }
    this.usage.delete(sessionID);
    // Release host objects that the swept keys reference (the reviewer session)
    // before the reference itself is dropped.
    if (this.deps.releaseReviewer) {
      try {
        await this.deps.releaseReviewer(sessionID);
      } catch (error) {
        logWarn(`reviewer release on sweep failed session=${sessionID}: ${errorText(error)}`);
      }
    }
    const removed = await this.store.sweepSession(sessionID);
    await this.mutex.deleteRow(sessionID);
    log(`swept session=${sessionID} keys=${removed}`);
  }

  /**
   * Setup sweep: remove stranded keys for sessions that no longer exist.
   * Fail-conservative: only a positively missing session is swept; an
   * unreadable answer leaves the keys alone.
   */
  async sweepMissingSessions(): Promise<number> {
    const stored = await this.store.listStoredSessions();
    let swept = 0;
    for (const sessionID of stored) {
      let missing = false;
      try {
        const info = await this.deps.session.get({ sessionID });
        missing = !info || typeof info.id !== "string";
      } catch (error) {
        const message = errorText(error);
        if (/SessionNotFound|session not found|not\s*found|404/i.test(message)) {
          missing = true;
        } else {
          logWarn(`setup sweep skipped session=${sessionID} (unreadable: ${message})`);
          continue;
        }
      }
      if (!missing) continue;
      await this.sweepSession(sessionID);
      swept += 1;
    }
    return swept;
  }

  shutdown(): void {
    this.closed = true;
    for (const state of this.states.values()) {
      this.discardPendingLocked(state);
    }
    this.states.clear();
    this.executing.clear();
  }
}
