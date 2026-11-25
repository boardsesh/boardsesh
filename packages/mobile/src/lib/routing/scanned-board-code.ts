// What the in-app "Scan a board code" camera does with a QR code it reads.
//
// A code is only followed when it is a link the app would also open from the
// system camera: a board or climb link on our own hosts (www or apex
// boardsesh.com, or the app's scheme), read by the same parser the deep-link
// provider uses (`board-deep-link.ts`), or a crew session's `/join/{id}` link.
// Everything else, another site, a Wi-Fi code, plain text, is refused, and the
// screen says the code isn't a Boardsesh board. The board path that comes out
// is rebuilt from validated pieces, so a crafted code cannot hand the router
// anything a tapped link could not.
//
// Pure and React-free so every rule is a unit test.

import { boardseshLinkPathname, parseBoardLinkPath } from './board-deep-link';

export type ScannedBoardCode =
  | { kind: 'board'; href: string }
  | { kind: 'join'; sessionId: string }
  | { kind: 'not-boardsesh' };

/** A crew session id, the shape `/join/{id}` links carry. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A QR code holds at most a few kilobytes; anything near this is not one of our links. */
const MAX_CODE_LENGTH = 2048;

const NOT_BOARDSESH: ScannedBoardCode = { kind: 'not-boardsesh' };

/** Where a scanned QR code's text leads, or `not-boardsesh` when it is not one of our links. */
export function parseScannedBoardCode(data: string | null | undefined): ScannedBoardCode {
  if (typeof data !== 'string') return NOT_BOARDSESH;
  const url = data.trim();
  if (url.length === 0 || url.length > MAX_CODE_LENGTH) return NOT_BOARDSESH;

  const href = parseBoardLinkPath(url);
  if (href) return { kind: 'board', href };

  const pathname = boardseshLinkPathname(url);
  const [first, sessionId, ...rest] = pathname?.split('/').filter((segment) => segment.length > 0) ?? [];
  if (first === 'join' && rest.length === 0 && sessionId !== undefined && SESSION_ID.test(sessionId)) {
    return { kind: 'join', sessionId };
  }
  return NOT_BOARDSESH;
}
