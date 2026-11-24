// Website journeys use bounded labels, never a full URL, board slug or account ID.
import type { AnalyticsPropertyValue } from './client';
import type { AnalyticsBoardType } from './board-type-property';

export const WEBSITE_JOURNEY_EVENTS = {
  WebAppOpened: 'Web App Opened',
  CompatibilityBoardSelected: 'Compatibility Board Selected',
  ImportPathChosen: 'Import Path Chosen',
  SpraywallPathClicked: 'Spraywall Path Clicked',
  NavLinkClicked: 'Nav Link Clicked',
  GymClaimPathClicked: 'Gym Claim Path Clicked',
  PartnerContactClicked: 'Partner Contact Clicked',
} as const;

export const WEBSITE_JOURNEY_PLACEMENTS = [
  'hero',
  'header',
  'header-menu',
  'footer',
  'setter',
  'playlist',
  'playlists',
  'board-compat',
  'home-chip',
  'help-spray',
  'logbook-import',
  'bring-your-logbook',
  'sticky-bar',
  'about',
  'support',
  'climb-view',
  'climb-list',
  'spray-climb',
  'spray-wall',
  'spraywalls',
  'gyms-directory',
  'help',
  'run-a-wall',
  'compare-hub',
  'compare-kilter',
  'compare-aurora',
  'compare-moonboard',
  'compare-woods',
  'compare-spray',
] as const;

export type WebsiteJourneyPlacement = (typeof WEBSITE_JOURNEY_PLACEMENTS)[number];
export type WebsiteCompatibilityBoard = AnalyticsBoardType;
export type WebsiteImportPath = 'account-link' | 'aurora-export';
export type WebsiteNavArea = 'header' | 'header-menu' | 'footer';
export type WebsiteNavTarget =
  | '/'
  | '/boards'
  | '/apps'
  | '/spraywalls'
  | '/run-a-wall'
  | '/for-gyms'
  | '/developers'
  | 'source'
  | 'roadmap'
  | 'discord'
  | 'report-bug'
  | '/gyms'
  | '/gyms/kilter'
  | '/gyms/tension'
  | '/gyms/moonboard'
  | '/playlists'
  | '/about'
  | '/help'
  | '/support'
  | '/bring-your-logbook'
  | '/docs'
  | '/legal'
  | '/privacy'
  | '/build-plans'
  | '/auth/login'
  | '/settings'
  | 'profile'
  | 'app'
  | 'privacy-choices';
export type WebsiteJourneyEvent = {
  name: (typeof WEBSITE_JOURNEY_EVENTS)[keyof typeof WEBSITE_JOURNEY_EVENTS];
  properties: Record<string, AnalyticsPropertyValue>;
};

/** A click that opens the browser app, not evidence that it loaded or activated. */
export function webAppOpened(placement: WebsiteJourneyPlacement): WebsiteJourneyEvent {
  return { name: WEBSITE_JOURNEY_EVENTS.WebAppOpened, properties: { placement } };
}

export function compatibilityBoardSelected(
  board: WebsiteCompatibilityBoard,
  source: WebsiteJourneyPlacement,
): WebsiteJourneyEvent {
  return { name: WEBSITE_JOURNEY_EVENTS.CompatibilityBoardSelected, properties: { board, source } };
}

export function importPathChosen(source: WebsiteImportPath): WebsiteJourneyEvent {
  return { name: WEBSITE_JOURNEY_EVENTS.ImportPathChosen, properties: { source } };
}

export function spraywallPathClicked(placement: WebsiteJourneyPlacement): WebsiteJourneyEvent {
  return { name: WEBSITE_JOURNEY_EVENTS.SpraywallPathClicked, properties: { placement } };
}

export function navLinkClicked(area: WebsiteNavArea, target: WebsiteNavTarget): WebsiteJourneyEvent {
  return { name: WEBSITE_JOURNEY_EVENTS.NavLinkClicked, properties: { area, target } };
}

/** Generic search entry, before a particular gym or claim has been chosen. */
export function gymClaimPathClicked(placement: 'home' | 'for-gyms'): WebsiteJourneyEvent {
  return { name: WEBSITE_JOURNEY_EVENTS.GymClaimPathClicked, properties: { placement } };
}

/** Contact intent only: opening an email app does not establish a submission. */
export function partnerContactClicked(
  type: 'partner' | 'builder',
  placement: 'home' | 'for-gyms',
): WebsiteJourneyEvent {
  return { name: WEBSITE_JOURNEY_EVENTS.PartnerContactClicked, properties: { type, placement } };
}
