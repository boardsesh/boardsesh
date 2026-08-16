// Routes that render ZERO app chrome — no GlobalHeader, no bottom bar, no
// banners. The root layout mounts that chrome unconditionally (a nested layout
// cannot remove it), so the chrome components themselves gate on these
// prefixes via `usePathnameWithoutLocale()` (locale-prefix aware: /es/kiosk/…
// arrives here already stripped to /kiosk/…).
//
// - /kiosk — public smart-TV surfaces: full-viewport 100dvh grids where any
//   overlaid chrome breaks the no-scroll contract.
// - /embed — iframe embeds (PR G, stacked on the kiosk foundation): embedded
//   third-party pages must never show Boardsesh navigation.

export const CHROME_LESS_ROUTE_PREFIXES = ['/kiosk', '/embed'] as const;

// Chrome-less surfaces that are NOT a whole route subtree, so a prefix cannot
// express them.
//
// - /gym/<slug>/poster — the printable QR poster (#4379). It sits inside the
//   very much chromed /gym tree, and the chrome removal is functional rather
//   than cosmetic: the header is `position: fixed`, so it prints on top of the
//   poster, and the footer's link columns push the sheet onto a second page.
//   Anchored at both ends — nothing below /poster matches, and neither does
//   /gym/<slug> itself.
export const CHROME_LESS_ROUTE_PATTERNS = [/^\/gym\/[^/]+\/poster$/] as const;

/**
 * Whether a locale-stripped pathname belongs to a chrome-less surface.
 * Boundary-aware prefix match: '/kiosk' and '/kiosk/…' match, '/kiosks' does not.
 */
export function isChromeLessPath(pathnameWithoutLocale: string): boolean {
  return (
    CHROME_LESS_ROUTE_PREFIXES.some(
      (prefix) => pathnameWithoutLocale === prefix || pathnameWithoutLocale.startsWith(`${prefix}/`),
    ) || CHROME_LESS_ROUTE_PATTERNS.some((pattern) => pattern.test(pathnameWithoutLocale))
  );
}
