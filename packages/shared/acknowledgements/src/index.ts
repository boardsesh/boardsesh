/**
 * The people and projects Boardsesh thanks, shared by web and mobile.
 *
 * GitHub contributors + sponsors come from a generated JSON
 * (scripts/fetch-acknowledgements.ts, refreshed by
 * .github/workflows/refresh-acknowledgements.yml). The personal thanks are kept
 * here as data — names are proper nouns, so they're never translated; the
 * surrounding copy lives in each app's i18n catalogs.
 */
import acknowledgements from './acknowledgements.generated.json';

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

export const contributors: Contributor[] = acknowledgements.contributors;
export const sponsors: Sponsor[] = acknowledgements.sponsors;

/** Sponsors who chose to stay private — shown only as an anonymous count. */
export const privateSponsorCount: number = acknowledgements.privateSponsorCount;

/** The OTA server behind our releases — Mercure Technologies gave us an enterprise license. */
export const XPREM_URL = 'https://github.com/mercuretechnologies/xprem';

// Personal thanks — kept as data so the screen renders the names directly.
// Gabby leads the crew; Scout gets her own easter-egg page.
export const friends = ['Gabby', 'Caz', 'Josh', 'Pete', 'Nic', 'Jess', 'Roxy'] as const;
export const dogName = 'Scout';
