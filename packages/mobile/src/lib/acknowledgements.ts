/**
 * App-facing accessors for the Acknowledgements screen.
 *
 * GitHub contributors + sponsors come from a build-time generated JSON
 * (scripts/fetch-acknowledgements.ts). The personal thanks are kept here as
 * data — names are proper nouns, so they're never translated; the surrounding
 * copy lives in the i18n catalogs.
 */
import data from '../data/acknowledgements.generated.json';

export type Contributor = {
  login: string;
  name: string | null;
  avatarUrl: string;
  htmlUrl: string;
  pullRequests: number;
  issues: number;
  /** pullRequests + issues — the ranking score the list is sorted by. */
  contributions: number;
};

export type Sponsor = {
  login: string;
  name: string | null;
  avatarUrl: string;
  url: string;
};

export const contributors: Contributor[] = data.contributors;
export const sponsors: Sponsor[] = data.sponsors;

/** Sponsors who chose to stay private — shown only as an anonymous count. */
export const privateSponsorCount: number = data.privateSponsorCount;

/** Where the "Become a sponsor" empty-state CTA points. */
export const SPONSORS_URL = 'https://github.com/sponsors/boardsesh';

// Personal thanks — kept as data so the screen renders the names directly.
// Gabby leads the crew; Scout gets her own easter-egg page.
export const friends = ['Gabby', 'Caz', 'Josh', 'Pete', 'Nic', 'Jess', 'Roxy'] as const;
export const dogName = 'Scout';
