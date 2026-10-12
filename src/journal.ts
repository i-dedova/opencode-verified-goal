// Review journal (operator direction): every gated review appends one JSON line
// to `<os temp>/opencode-verified-goal/reviews/<session>.jsonl`, so a goal's reviews can be
// debugged after the fact — the durable goal record deliberately keeps no
// history and `/goal clear` removes it. The trail is pruned at setup; files
// older than REVIEW_JOURNAL_RETENTION_DAYS are deleted. Writes are best-effort:
// a failed journal write never affects a transition.

import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logWarn } from "./log.ts";

export const REVIEW_JOURNAL_RETENTION_DAYS = 14;

export function reviewJournalDir(): string {
  return join(tmpdir(), "opencode-verified-goal", "reviews");
}

export function reviewJournalPath(sessionID: string): string {
  return join(reviewJournalDir(), `${sessionID}.jsonl`);
}

export interface ReviewJournalEntry {
  at: string;
  session_id: string;
  goal_id: string;
  transition: string;
  profile: string;
  reviewer_session_id: string;
  reviewer_model: string | null;
  reused_reviewer: boolean;
  payload_bytes: number;
  status: string;
  verdict: "approved" | "rejected" | null;
  reason: string;
  unmet: string;
  raw: string;
  duration_ms: number;
}

export async function recordReview(entry: ReviewJournalEntry): Promise<void> {
  try {
    await mkdir(reviewJournalDir(), { recursive: true });
    await appendFile(reviewJournalPath(entry.session_id), `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    logWarn(
      `review journal write failed session=${entry.session_id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Delete journal files older than `days`; returns how many were removed. */
export async function pruneReviews(days: number = REVIEW_JOURNAL_RETENTION_DAYS): Promise<number> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    const dir = reviewJournalDir();
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const info = await stat(path);
        if (info.mtimeMs < cutoff) {
          await unlink(path);
          removed += 1;
        }
      } catch {
        // raced with another sweep; nothing to do
      }
    }
  } catch {
    // no journal directory yet
  }
  return removed;
}
