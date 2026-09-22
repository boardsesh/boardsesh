import acknowledgements from './acknowledgements.generated.json';

export type Contributor = (typeof acknowledgements.contributors)[number];
export type Sponsor = (typeof acknowledgements.sponsors)[number];

export const contributors: Contributor[] = acknowledgements.contributors;
export const sponsors: Sponsor[] = acknowledgements.sponsors;
export const privateSponsorCount = acknowledgements.privateSponsorCount;

export const XPREM_URL = 'https://github.com/mercuretechnologies/xprem';
export const friends = ['Gabby', 'Caz', 'Josh', 'Pete', 'Nic', 'Jess', 'Roxy'] as const;
export const dogName = 'Scout';
