/**
 * App-facing accessors for the Acknowledgements screen.
 *
 * The data lives in @boardsesh/acknowledgements so web and mobile read the same
 * lists. This module stays as the screen's import seam (tests mock it).
 */
export type { Contributor, Sponsor } from '@boardsesh/acknowledgements';
export { contributors, sponsors, privateSponsorCount, XPREM_URL, friends, dogName } from '@boardsesh/acknowledgements';
