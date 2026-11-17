import { isSameSectionLayout, type SectionLayout, type SectionLayoutSpec } from './section-layout';
import { createSectionLayoutStore, settingsLayoutStorage, useSectionLayout } from './section-layout-store';

// The sections Home shows, and in what order (#6289). The default is This week
// (#7690), Climbing now, then the feed. The three Boardz-style cards and Fresh
// beta (the beta shelf Home had until #5518) start hidden, and "Focused" is one
// tap away.
//
// A section added in a later release takes its default place and switch, also
// for a climber who customised Home: their own order and switches stay as they
// were around it.
//
// The feed stays last: it scrolls forever, so nothing could sit under it.

export const HOME_SECTION_IDS = ['week', 'board', 'session', 'playlists', 'climbingNow', 'beta', 'feed'] as const;
export type HomeSectionId = (typeof HOME_SECTION_IDS)[number];
/** The sections drawn above the feed; the feed is the list itself. */
export type HomeTopSectionId = Exclude<HomeSectionId, 'feed'>;

function isTopSection(sectionId: HomeSectionId): sectionId is HomeTopSectionId {
  return sectionId !== 'feed';
}

export const HOME_SECTIONS: SectionLayoutSpec<HomeSectionId> = {
  ids: HOME_SECTION_IDS,
  defaults: {
    order: HOME_SECTION_IDS,
    visible: { week: true, board: false, session: false, playlists: false, climbingNow: true, beta: false, feed: true },
  },
  lockedLast: 'feed',
};

/** What "Focused" shows: your week and the three cards, without the feed and Climbing now. */
const FOCUSED_VISIBILITY: Readonly<Record<HomeSectionId, boolean>> = {
  week: true,
  board: true,
  session: true,
  playlists: true,
  climbingNow: false,
  beta: false,
  feed: false,
};

/** The Focused preset, keeping the climber's order. */
export function focusedHomeLayout(current: SectionLayout<HomeSectionId>): SectionLayout<HomeSectionId> {
  return { order: current.order, visible: FOCUSED_VISIBILITY };
}

export function isFocusedHomeLayout(layout: SectionLayout<HomeSectionId>): boolean {
  return isSameSectionLayout(layout, focusedHomeLayout(layout));
}

export function isDefaultHomeLayout(layout: SectionLayout<HomeSectionId>): boolean {
  return isSameSectionLayout(layout, HOME_SECTIONS.defaults);
}

/** Which preset a layout matches, for the value beside Settings › Home. */
export type HomeLayoutPreset = 'default' | 'focused' | 'custom';

export function homeLayoutPreset(layout: SectionLayout<HomeSectionId>): HomeLayoutPreset {
  if (isDefaultHomeLayout(layout)) return 'default';
  return isFocusedHomeLayout(layout) ? 'focused' : 'custom';
}

/** The sections above the feed that are switched on, in order. */
export function visibleTopHomeSections(layout: SectionLayout<HomeSectionId>): HomeTopSectionId[] {
  return layout.order.filter(isTopSection).filter((sectionId) => layout.visible[sectionId]);
}

export const homeSectionsStore = createSectionLayoutStore({
  spec: HOME_SECTIONS,
  ...settingsLayoutStorage('homeSectionsV1'),
});

export function useHomeSectionLayout(): SectionLayout<HomeSectionId> {
  return useSectionLayout(homeSectionsStore);
}
