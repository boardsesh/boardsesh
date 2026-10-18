import type { ReactNode } from 'react';
import type { ScenarioOverrides } from './scenario-overrides';

/**
 * A component story: draws something on the story screen, inside the real app's
 * providers (theme, i18n, query client, board, presence). Use it for leaf UI
 * whose states are cheap to build from props.
 */
export type ComponentStory = {
  /** Shown in the story index and above the canvas. */
  name: string;
  render: () => ReactNode;
  /**
   * Live values to fake while this story is on screen, for a component that
   * reads them from context instead of props. Applied on focus, cleared on blur
   * unless a newer story replaced them. Left out, the story clears any
   * scenario's overrides, so it draws the same whatever ran before it.
   */
  overrides?: ScenarioOverrides;
  /** `padded` (default) scrolls the canvas under a caption; `fullscreen` draws edge to edge. */
  layout?: 'padded' | 'fullscreen';
};

/**
 * A scenario story: fakes a few live values on top of the real app, then opens a
 * real route. Use it for whole screens whose state is hard to reach by hand, such
 * as a crew session with nobody else around.
 *
 * The overrides stay on after navigating away, until another story (scenario
 * or component) replaces them or `dev/stories/reset` clears them.
 */
export type ScenarioStory = {
  name: string;
  overrides: ScenarioOverrides;
  /** The real route to open, e.g. `/climbs?screenshotOpenFirst=1`. */
  route: string;
  /**
   * Runs before the overrides go on, for device state the screen reads from
   * settings rather than context (`setSetting('lightOnSwipe', true)`). It
   * persists on the simulator, so pin every setting the story depends on.
   */
  prepare?: () => void | Promise<void>;
};

export type Story = ComponentStory | ScenarioStory;

/** The default export of a `*.stories.tsx` file. */
export type StoryModule = {
  /** Heading in the story index, e.g. `Play drawer / Crew browse`. */
  title: string;
  /**
   * Keys become the second half of each story id, kebab-cased:
   * `browsingPill` in `WallState.stories.tsx` is `wall-state--browsing-pill`.
   */
  stories: Record<string, Story>;
};

export type RegisteredStory = {
  /** `<module>--<story>`, the path segment in `dev/stories/<id>`. */
  id: string;
  moduleId: string;
  title: string;
  story: Story;
  /** Declaration order across all files; a bare module id opens its file's lowest. */
  order: number;
};

export function isScenarioStory(story: Story): story is ScenarioStory {
  return 'route' in story;
}
