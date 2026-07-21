/**
 * Middleware forwards the (locale-stripped) request pathname in this header so
 * a server layout can branch on the child route segment that its own route
 * params can't reveal. The board `[angle]` layout uses it to tell a `/view/` or
 * `/play/` request apart from a `/list` one.
 *
 * Kept in a dependency-light module (no `next/*`, no `server-only`) so the edge
 * middleware can import the constant without pulling a heavier module into its
 * bundle — mirroring `climb-session-cookie.ts`. Middleware always overwrites the
 * header, so a client-supplied value can never reach a server component.
 */
export const PATHNAME_HEADER = 'x-boardsesh-pathname';
