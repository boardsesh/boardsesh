// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
const config = vi.hoisted(() => ({ left: 0, right: 0, variant: 'liquidGlass' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: config.left, right: config.right }),
}));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const { flattenStyle } = await import('../../../../test/flatten-style');
  return {
    StyleSheet: { create: <T,>(styles: T) => styles },
    View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
      createElement('div', { 'data-style': JSON.stringify(flattenStyle(style)) }, children),
    RefreshControl: () => null,
  };
});
vi.mock('react-native-paper', () => ({ Appbar: { Action: () => null, Content: () => null } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ variant: config.variant, systemColors: {}, actionColors: {} }),
}));
vi.mock('../../../hooks/use-native-root-header', () => ({ useNativeRootHeader: () => true }));
vi.mock('../use-story-bottom-inset', () => ({ useStoryBottomInset: () => 0, useStorySessionFooterBottom: () => 0 }));
vi.mock('../story-board-fixture', () => ({
  useStoryBoardFixture: () => ({ board: { boardName: 'kilter' }, label: 'Kilter', climbs: [{ uuid: 'one' }] }),
}));
vi.mock('../../fixtures/profile', () => ({ profileStoryData: () => ({}) }));
vi.mock('../../../components/climb-actions/climb-menu-items', () => ({ buildClimbMenuItems: () => [] }));
vi.mock('../../../components/play-drawer/play-drawer-menu-rows', () => ({ buildPlayDrawerMenuRows: () => [] }));
vi.mock('../../../components/ClimbListRow', () => ({ ClimbListRowView: () => null }));
vi.mock('../../../components/ClimbListItemContent', () => ({
  ClimbListItemContentView: () => null,
  ClimbSubtitleView: () => null,
  ClimbAscentStatusView: () => null,
}));
vi.mock('../StoryClimbRow', () => ({
  StoryClimbArtObserverProvider: ({ children }: { children: ReactNode }) => children,
  renderStoryClimbContent: () => null,
  StoryClimbThumbnail: () => null,
  StoryClimbGrade: () => null,
}));
vi.mock('../../../components/ClimbListRowSkeleton', () => ({ ClimbListRowSkeletonView: () => null }));
vi.mock('../../../components/search/ClimbTopChrome', () => ({ ClimbTopChromeView: () => null }));
vi.mock('../../../components/search/FilterChipRow', () => ({ FilterChipRow: () => null }));
vi.mock('../../../components/chrome/NativeRootHeader', () => ({ NativeRootHeader: () => null }));
vi.mock('../../../components/chrome/CollapsingLargeTitleHeader', () => ({ CollapsingLargeTitleHeader: () => null }));
vi.mock('../../../components/chrome/GlassActionToolbar', () => ({
  GlassActionToolbar: () => null,
  GlassToolbarAction: () => null,
}));
vi.mock('../../../components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../components/Text', () => ({ Text: () => null }));
vi.mock('../../../components/climbs/ClimbsEmptyState', () => ({ ClimbsEmptyState: () => null }));
vi.mock('../../../components/user-drawer/UserAvatarToolbarActionView', () => ({
  UserAvatarToolbarActionView: () => null,
}));
vi.mock('../../../components/you/ProfileTopChromeView', () => ({ ProfileTopChromeView: () => null }));
vi.mock('../../../components/you/ProgressView', () => ({ ProgressView: () => <div data-testid="progress-content" /> }));
vi.mock('../../../components/climbs/ClimbsView', async () => {
  const { flattenStyle } = await import('../../../../test/flatten-style');
  return {
    ClimbsView: ({ clipStyle }: { clipStyle: unknown }) => (
      <div data-testid="climbs-content" data-style={JSON.stringify(flattenStyle(clipStyle))} />
    ),
  };
});
vi.mock('../../../hooks/use-glass-capability', () => ({ useGlassCapability: () => null }));
vi.mock('../StorySprayBoard', () => ({ StorySprayBoard: () => null }));
vi.mock('../StoryBoard', () => ({ StoryBoard: () => null }));
vi.mock('../../../components/boards/BoardSummaryCard', () => ({ BoardSummaryCardView: () => null }));
vi.mock('../../../components/session-screen/RecordTopChrome', () => ({ RecordTopChromeView: () => null }));
vi.mock('../../../components/session-screen/RestTimerArmRow', () => ({ RestTimerArmRowView: () => null }));
vi.mock('../../../components/session-screen/SessionVisibilityRow', () => ({ SessionVisibilityRow: () => null }));
vi.mock('../../../components/queue-control/RestTimerSheetViews', () => ({ RestTimerLengthSettingView: () => null }));
vi.mock('../../../components/session-screen/pre-session/GeneratorPickerCard', () => ({
  GeneratorPickerCardView: () => null,
}));
vi.mock('../../../components/session-screen/pre-session/PreSessionHeaderView', () => ({
  PreSessionHeaderView: () => null,
}));
vi.mock('../../../components/session-screen/pre-session/WorkoutPreviewSection', () => ({
  WorkoutPreviewSection: () => null,
}));
vi.mock('../../../components/session-screen/pre-session/WorkoutPreviewRow', () => ({
  WorkoutPreviewRowView: () => null,
}));
vi.mock('../../../components/session-screen/SessionStartFab', () => ({
  SessionStartFab: () => null,
  SESSION_START_FAB_HEIGHT: 48,
}));
vi.mock('../../../lib/climb-to-queue-item', () => ({ climbToQueueItem: () => ({}) }));
vi.mock('../../fixtures/workout', () => ({ buildStoryWorkout: () => ({ climbs: [], targetGrade: 10 }) }));
vi.mock('../../../components/session-screen/pre-session/PreSessionPresentation', () => ({
  PreSessionPresentation: () => <div data-testid="workout-content" />,
}));
import workoutStories from '../../../components/session-screen/pre-session/WorkoutGenerator.stories';
import { ClimbsStory } from '../../../components/climbs/Climbs.stories';
import progressStories from '../../../components/you/Progress.stories';
const noop = () => {};
function styleOf(element: Element | null): Record<string, unknown> {
  expect(element).not.toBeNull();
  return JSON.parse(element?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
}
beforeEach(() => Object.assign(config, { left: 0, right: 0, variant: 'liquidGlass' }));
describe('story content beside native navigation', () => {
  it.each([
    { left: 280, right: 0 },
    { left: 0, right: 84 },
  ])('keeps climb rows out of side chrome %j', (insets) => {
    Object.assign(config, insets);
    const { getByTestId } = render(<ClimbsStory scene="populated" onReady={noop} />);
    expect(styleOf(getByTestId('climbs-content'))).toMatchObject(insets);
  });
  it('releases the side clearance when the native layout returns to portrait', () => {
    config.left = 280;
    const { getByTestId, rerender } = render(<ClimbsStory scene="populated" onReady={noop} />);
    config.left = 0;
    rerender(<ClimbsStory scene="populated" onReady={noop} />);
    expect(styleOf(getByTestId('climbs-content'))).toMatchObject({ left: 0, right: 0 });
  });
  it('keeps the workout form inside the production session side clearance', () => {
    config.left = 280;
    const { getByTestId } = render(workoutStories.stories.volume.render({ onReady: noop, onError: noop }));
    expect(styleOf(getByTestId('workout-content').parentElement)).toMatchObject({
      paddingLeft: 280,
      paddingRight: 0,
      flex: 1,
    });
  });
  it('uses the production readable column for profile content under a sidebar', () => {
    config.left = 280;
    const story = progressStories.stories.overview;
    const { getByTestId } = render(story.render({ onReady: noop, onError: noop }));
    expect(styleOf(getByTestId('progress-content').parentElement)).toMatchObject({
      paddingLeft: 280,
      paddingRight: 0,
      maxWidth: 952,
      flex: 1,
    });
  });
});
