import type { SessionUser } from '@boardsesh/shared-schema';
import type { ScenarioOverrides } from '../../dev/stories/scenario-overrides';
import type { StoryModule } from '../../dev/stories/types';

// What the player says about the wall (#6939, #7000): the back chip and the
// wall button's lit and dark states on the real drawer, forced past their
// resolvers so one simulator shows them all without a crew.

type PlayerOverrides = NonNullable<ScenarioOverrides['player']>;

const CREW: SessionUser[] = [
  { id: 'story-me', username: 'You', isLeader: true, connectionState: 'CONNECTED' },
  { id: 'story-sam', username: 'Sam', isLeader: false, userId: 'story-sam-user', connectionState: 'CONNECTED' },
];

const ROUTE = '/climbs?screenshotOpenFirst=1';

const player = (wallPill: PlayerOverrides['wallPill'], wallLit: PlayerOverrides['wallLit']): ScenarioOverrides => ({
  player: { wallPill, wallLit },
});

const stories: StoryModule = {
  title: 'Play drawer / Wall signal',
  stories: {
    onWall: {
      name: 'The climb on screen is lit',
      overrides: player(null, 'lit'),
      route: ROUTE,
    },
    previewNotLit: {
      name: 'Solo, looking at another climb while the wall is lit',
      overrides: player('browsing', 'notLit'),
      route: ROUTE,
    },
    onlyYou: {
      name: 'In a crew, looking at a climb nobody else sees',
      overrides: {
        queue: { isSharedSession: true, sessionId: 'story-crew-session', sessionUsers: CREW },
        ...player('browsing', 'notLit'),
      },
      route: ROUTE,
    },
    liveButDark: {
      name: 'Wall driven, current climb dark (#7000)',
      overrides: player(null, 'notLit'),
      route: ROUTE,
    },
    noBoard: {
      name: 'No board connected',
      overrides: player(null, 'notLit'),
      route: ROUTE,
    },
  },
};

export default stories;
