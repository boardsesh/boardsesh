import * as StoreReview from 'expo-store-review';
import type { SessionSummary } from '@boardsesh/shared-schema';
import { getPreference, setPreference } from './preference-store';

type SessionStoreReviewPromptState = {
  lastPromptedAtMs: number;
  lastPromptedSessionId: string | null;
};

const SESSION_STORE_REVIEW_PROMPT_KEY = 'sessionStoreReviewPrompt';

export const SESSION_STORE_REVIEW_MIN_SENDS = 3;
export const SESSION_STORE_REVIEW_COOLDOWN_MS = 90 * 24 * 60 * 60 * 1000;
export const SESSION_STORE_REVIEW_CANDIDATE_PARAM = '1';
export const STORE_REVIEW_PROMPT_DELAY_MS = 1000;

export function isSessionStoreReviewEligible(summary: Pick<SessionSummary, 'totalSends'>): boolean {
  return summary.totalSends >= SESSION_STORE_REVIEW_MIN_SENDS;
}

async function readPromptState(): Promise<SessionStoreReviewPromptState | null> {
  const storedState = await getPreference<SessionStoreReviewPromptState>(SESSION_STORE_REVIEW_PROMPT_KEY);
  if (!storedState || typeof storedState.lastPromptedAtMs !== 'number') return null;
  return {
    lastPromptedAtMs: storedState.lastPromptedAtMs,
    lastPromptedSessionId:
      typeof storedState.lastPromptedSessionId === 'string' ? storedState.lastPromptedSessionId : null,
  };
}

async function writePromptState(state: SessionStoreReviewPromptState): Promise<void> {
  await setPreference(SESSION_STORE_REVIEW_PROMPT_KEY, state);
}

export async function shouldRequestSessionStoreReview(
  summary: Pick<SessionSummary, 'sessionId' | 'totalSends'>,
  nowMs = Date.now(),
): Promise<boolean> {
  try {
    if (!isSessionStoreReviewEligible(summary)) return false;

    const promptState = await readPromptState();
    if (promptState?.lastPromptedSessionId === summary.sessionId) return false;
    if (promptState && nowMs - promptState.lastPromptedAtMs < SESSION_STORE_REVIEW_COOLDOWN_MS) return false;

    return await StoreReview.hasAction();
  } catch {
    return false;
  }
}

export async function maybeRequestSessionStoreReview(
  summary: Pick<SessionSummary, 'sessionId' | 'totalSends'>,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!(await shouldRequestSessionStoreReview(summary, nowMs))) return false;

  try {
    await writePromptState({
      lastPromptedAtMs: nowMs,
      lastPromptedSessionId: summary.sessionId,
    });
  } catch {
    return false;
  }

  try {
    await StoreReview.requestReview();
    return true;
  } catch {
    return false;
  }
}
