import { isSameSectionLayout, type SectionLayout, type SectionLayoutSpec } from './section-layout';
import { createSectionLayoutStore, settingsLayoutStorage, useSectionLayout } from './section-layout-store';

// The sections Home shows, and in what order (#6289). The default is the Home
// redesign's (#7688): This week (#7690), Session, Climbing now, Back to your
// projects (#7691, which draws nothing for a climber with no project), At your
// level, then the feed. Your board and Fresh beta (the beta shelf Home had until #5518)
// start hidden, and "Focused" is one tap away.
//
// Climbing now stays its own rail until the Session card can lead with a live
// session and Join (#7689, waiting on the button pair in #7695).
//
// A climber who customised Home keeps their layout: a stored record holds every
// section's switch and place, so a new default order or switch reaches only
// climbers on the defaults (stored as `null`). A section added in a later release takes its default place and switch, also
// for a climber who customised Home: their own order and switches stay as they
// were around it.
//
// The feed stays last: it scrolls forever, so nothing could sit under it.

export const HOME_SECTION_IDS = [
  'week',
  'session',
  'climbingNow',
  'projects',
  'playlists',
  'board',
  'beta',
  'feed',
] as const;
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
    visible: {
      week: true,
      session: true,
      climbingNow: true,
      projects: true,
      playlists: true,
      board: false,
      beta: false,
      feed: true,
    },
  },
  lockedLast: 'feed',
};

/** What "Focused" shows: your week, your projects and the three cards, without the feed and Climbing now. */
const FOCUSED_VISIBILITY: Readonly<Record<HomeSectionId, boolean>> = {
  week: true,
  projects: true,
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
