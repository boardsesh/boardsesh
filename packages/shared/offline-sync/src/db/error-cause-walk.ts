// Walking a thrown value's `.cause` chain, once, for every SQLite classifier.
//
// Both platforms wrap the driver error AND concatenate it into the outer
// `message` (iOS `Exception.swift`, Android `CodedException.kt`), so the same
// failure arrives as one flat string on some builds and as an outer message
// plus a structured `.cause` on others. Every classifier therefore has to read
// the whole chain, not just the top frame.
//
// `lock-errors.ts` and `handle-errors.ts` both need that walk with the same
// depth limit and the same cycle guard, and a classifier that quietly walked
// one link further than its sibling would disagree with it on real Sentry
// payloads. Extracting it is what stops them drifting.

/**
 * How many `.cause` links to follow. Matches the depth error-classification.ts
 * uses: expo-sqlite wraps at most twice (FunctionCallException → CodedException
 * → driver error) and an unbounded walk on a caller-supplied object is an easy
 * way to hang on a long chain.
 */
export const MAX_CAUSE_DEPTH = 3;

/** The `message` of a thrown value, or the value itself when it is a string. */
export function messageOf(error: unknown): string | null {
  if (typeof error === 'string') return error;
  if (error === null || typeof error !== 'object') return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : null;
}

/**
 * Every link of the chain, nearest first, bounded by `MAX_CAUSE_DEPTH`.
 *
 * Cycle-safe by identity rather than by depth alone: a self-referential
 * `.cause` is rare but real (a re-thrown error that wraps itself), and the
 * depth limit alone would still visit it three times.
 */
export function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || current === undefined) break;
    if (typeof current === 'object') {
      if (seen.has(current)) break;
      seen.add(current);
    }
    chain.push(current);
    if (typeof current !== 'object') break;
    current = (current as { cause?: unknown }).cause;
  }

  return chain;
}

/**
 * Every message in the chain, joined by newlines.
 *
 * Joined rather than tested one frame at a time because the two markers a
 * dead-handle verdict needs can be split ACROSS links — the expo rejection
 * frame in the outer message, the `java.lang.NullPointerException` in the
 * cause — and a per-frame test would see neither frame carrying both.
 */
export function chainMessage(error: unknown): string {
  const messages: string[] = [];
  for (const link of causeChain(error)) {
    const message = messageOf(link);
    if (message !== null) messages.push(message);
  }
  return messages.join('\n');
}
