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
 *    the shared responsive `--page-gutter` token; shell padding would add
 *    another inset and move their headings out of line with the site header.
 *
 * `minHeight: 100dvh` stays. The site header is `position: fixed` and
 * `box-sizing` is border-box, so the padding-top sits INSIDE the 100dvh: the
 * shell ends exactly at the fold and `SiteFooter` starts there. That is the
 * sticky-footer behaviour; dropping it would float the footer mid-screen on a
 * board with three climbs.
 *
 * The ground is the page background, not `surface`. Surface is the card colour:
 * painting the whole page with it left cards no lighter step to sit on, and
 * washed the board art's own dark ground into a lilac frame.
 */
export const boardShellSx = {
  minHeight: '100dvh',
  paddingTop: 'var(--global-header-height)',
  background: 'var(--semantic-background)',
} as const;
