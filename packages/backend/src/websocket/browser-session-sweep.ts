import { AUTH_ADMISSION_BATCH_SIZE } from '../auth/admission-read-runner';
import { readLiveSessions } from '../auth/authority/browser-access-token';
import type { FirstPartySession } from '../auth/authority/session-reader';

export type LiveBrowserSessions = ReadonlyMap<string, FirstPartySession>;

/**
 * The live sessions among those the open browser sockets were opened with,
 * read by the request path's own rules, one bounded admission read per 128
 * ids, one after another. Throws on an outage, which the sweep answers by
 * keeping sockets open.
 */
export async function readLiveBrowserSessions(sessionIds: readonly string[]): Promise<LiveBrowserSessions> {
  const unique = [...new Set(sessionIds)];
  const chunks: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += AUTH_ADMISSION_BATCH_SIZE)
    chunks.push(unique.slice(offset, offset + AUTH_ADMISSION_BATCH_SIZE));
  // One chunk at a time: a round never holds more than one runner slot for this read.
  const live = new Map<string, FirstPartySession>();
  for (const chunk of chunks)
    for (const [sessionId, session] of await readLiveSessions(chunk)) live.set(sessionId, session);
  return live;
}

/** The socket's session is live and is still the one its token was signed for. */
export function isBrowserSessionStillLive(
  binding: {
    readonly userId: string;
    readonly browserSession?: { readonly sessionId: string; readonly generation: number };
  },
  live: LiveBrowserSessions,
): boolean {
  if (!binding.browserSession) return true;
  const session = live.get(binding.browserSession.sessionId);
  return (
    session !== undefined &&
    session.userId === binding.userId &&
    session.generation === binding.browserSession.generation
  );
}
