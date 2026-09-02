/**
 * The board shell both `/list` trees hang off — the config-tuple route and
 * `/b/{slug}`. One object so the two can't drift into two different insets.
 *
 * What it deliberately does NOT do:
 *
 *  - **No `<main>` of its own.** Every page under these shells renders one
 *    (`StaticListFrontDoor`, `ClimbFrontDoor`), matching how the rest of www
 *    puts the landmark on the page content component. Two nested `<main>`s is
 *    invalid HTML and two landmarks for one region.
 *  - **No horizontal padding.** The front doors already inset themselves by
 *    `spacing[4]`; the shell's old `spacing[2]` on top of that was a leftover
 *    from the pivot and made a 24px gutter on a phone.
 *
 * `minHeight: 100dvh` stays. The site header is `position: fixed` and
 * `box-sizing` is border-box, so the padding-top sits INSIDE the 100dvh: the
 * shell ends exactly at the fold and `SiteFooter` starts there. That is the
 * sticky-footer behaviour; dropping it would float the footer mid-screen on a
 * board with three climbs.
 */
export const boardShellSx = {
  minHeight: '100dvh',
  paddingTop: 'var(--global-header-height)',
  background: 'var(--semantic-surface)',
} as const;
