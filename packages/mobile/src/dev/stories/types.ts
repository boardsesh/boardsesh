import type { ReactNode } from 'react';

/**
 * A component story receives data and callbacks as view props, with only
 * presentation providers (theme, i18n, native navigation, sheets and portals).
 */
export type StoryRenderControls = {
  /** Call only after required images/board art and the intended view state have painted. */
  onReady: () => void;
  /** Asset or render failures must fail the capture, not produce an empty screenshot. */
  onError: (error: unknown) => void;
};

export type ComponentStory = {
  /** Shown in the story index and above the canvas. */
  name: string;
  render: (controls: StoryRenderControls) => ReactNode;
  /** Asset-heavy stories explicitly report readiness; other stories wait for layout. */
  readiness?: 'layout' | 'explicit';
  /** `padded` (default) scrolls the canvas under a caption; `fullscreen` draws edge to edge. */
  layout?: 'padded' | 'fullscreen';
  /** Mount inside the app’s real tab navigator with this tab selected. */
  tab?: 'home' | 'record' | 'discover' | 'profile' | 'climbs';
  /** False for a pushed view whose Material tab bar sits in flow. */
  tabRoot?: boolean;
};

export type Story = ComponentStory;

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
