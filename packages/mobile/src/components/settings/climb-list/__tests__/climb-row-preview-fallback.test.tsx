// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type StatusEntry = { status: 'flash' | 'send' | 'attempt'; is_ascent: boolean; tries: number; is_mirror: boolean };

const live = vi.hoisted(() => ({
  statsCalls: 0,
  gradeCalls: 0,
  myGradeCalls: 0,
  // "Use my grades", on for these tests so a row can carry the climber's own.
  personalGrades: true,
  myGrade: { status: 'unknown' } as { status: 'unknown' } | { status: 'set'; difficultyId: number; climbedAt: null },
  logbook: null as { logbookByClimbAngle: Map<string, StatusEntry[]> } | null,
  thumbnailProps: [] as Record<string, unknown>[],
}));

vi.mock('react-native', async () => {
  const { flattenStyle } = await import('../../../../../test/flatten-style');
  return {
    useWindowDimensions: () => ({ fontScale: 1 }),
    Platform: { OS: 'ios', select: () => undefined },
    PlatformColor: (name: string) => name,
    DynamicColorIOS: (appearances: { light: string }) => appearances.light,
    StyleSheet: { create: <Styles,>(styles: Styles): Styles => styles, flatten: flattenStyle, hairlineWidth: 0.5 },
    View: ({
      children,
      style,
      testID,
      accessibilityLabel,
      accessibilityRole,
    }: {
      children?: ReactNode;
      style?: unknown;
      testID?: string;
      accessibilityLabel?: string;
      accessibilityRole?: string;
    }) =>
      createElement(
        'div',
        {
          'data-testid': testID,
          'aria-label': accessibilityLabel,
          'data-role': accessibilityRole,
          'data-style': JSON.stringify(flattenStyle(style)),
        },
        children,
      ),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { formattedCount?: string }) =>
      key === 'sends' && options?.formattedCount ? `${options.formattedCount} sends` : key,
  }),
}));

vi.mock('@boardsesh/board-react', () => ({
  useOptionalBoardLogbook: () => live.logbook,
  logbookClimbAngleKey: (climbUuid: string, angle: number) => `${climbUuid}:${angle}`,
  useEffectiveClimbStats: (
    _boardName: string,
    _layoutId: number,
    _climbUuid: string,
    _angle: number,
    base: { ascensionistCount?: number; qualityAverage?: string; difficulty?: string },
  ) => {
    live.statsCalls += 1;
    return {
      ascensionistCount: base.ascensionistCount ?? 0,
      qualityAverage: base.qualityAverage ?? null,
      difficulty: base.difficulty ?? null,
    };
  },
}));

vi.mock('../../../../hooks/use-display-grade', () => ({
  useBoardseshGradesActive: () => false,
  // One call per mounted leaf that works a grade out.
  useDisplayGrade: () => {
    live.gradeCalls += 1;
    return { boardseshActive: false, resolveGrade: () => ({ label: 'V4', color: '#44AA44', isBoardsesh: false }) };
  },
}));
vi.mock('../../../../hooks/use-personal-grades', () => ({ usePersonalGradesActive: () => live.personalGrades }));
vi.mock('../../../../hooks/use-my-grade', () => ({
  // The row's way to the climber's own grade, and so to the logbook: one call per
  // mounted leaf that subscribes. No grade while personal grades are off, like
  // the real hook.
  useMyGrade: () => {
    live.myGradeCalls += 1;
    return live.personalGrades ? live.myGrade : { status: 'none' };
  },
}));
vi.mock('../../../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ gradeFormat: 'v-grade' }) }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({
    textStyles: { body: { lineHeight: 22 } },
    systemColors: { secondaryLabel: '#8E8E93', fill: '#E5E5EA' },
    brandColors: { primary: '#557799' },
  }),
}));

vi.mock('../../../Text', async () => {
  const { flattenStyle } = await import('../../../../../test/flatten-style');
  return {
    Text: ({
      children,
      style,
      variant,
      numberOfLines,
      accessibilityLabel,
    }: {
      children?: ReactNode;
      style?: unknown;
      variant?: string;
      numberOfLines?: number;
      accessibilityLabel?: string;
    }) =>
      createElement(
        'span',
        {
          'data-variant': variant,
          'data-lines': numberOfLines,
          'aria-label': accessibilityLabel,
          'data-style': JSON.stringify(flattenStyle(style)),
        },
        children,
      ),
  };
});

vi.mock('../../../ClimbListThumbnail', async () => {
  const metrics = await import('../../../climb-list-thumbnail-metrics');
  return {
    ...metrics,
    ClimbListThumbnail: (props: Record<string, unknown>) => {
      live.thumbnailProps.push(props);
      return createElement('i', { 'data-thumbnail': 'true' });
    },
  };
});

vi.mock('../../../Icon', () => ({
  Icon: ({ name, size, color }: { name: string; size: number; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-size': size, 'data-color': color }),
}));

// The tag strip has its own suite; here it only has to be mounted or not.
vi.mock('../../../ClimbPlaylistChips', () => ({
  ClimbPlaylistChipsView: () => createElement('div', { 'data-testid': 'staged-playlists' }),
  ClimbPlaylistChips: ({ climbUuid }: { climbUuid: string }) =>
    createElement('div', { 'data-testid': 'playlist-chips', 'data-climb': climbUuid }),
}));

vi.mock('../../../../hooks/use-board-preview-climb', () => ({
  useBoardPreviewClimb: () => ({ status: 'unavailable', preview: null, climb: null }),
}));
vi.mock('../ClimbRowPresetChips', () => ({ ClimbRowPresetChips: () => null }));
import { DEFAULT_CLIMB_ROW_DISPLAY } from '../../../../lib/climb-row-display';
import { ClimbRowSettingsPreview } from '../ClimbRowSettingsPreview';

describe('Climb list preview without an active board', () => {
  it('draws the fixture, staged marks and neutral picture as a resolved row', () => {
    const { container, getByText, queryByText, getByTestId } = render(
      <ClimbRowSettingsPreview
        display={DEFAULT_CLIMB_ROW_DISPLAY}
        activePreset="default"
        hasLastCustom={false}
        selectPreset={() => {}}
        windowHeight={117}
      />,
    );
    expect(getByText('mobile.settings.climbList.sampleName')).toBeTruthy();
    expect(queryByText('mobile.climbRow.unknownClimb')).toBeNull();
    expect(getByTestId('climb-preview-neutral-picture')).toBeTruthy();
    expect(container.querySelector('[data-icon="flash"]')).toBeTruthy();
    expect(container.querySelector('[data-icon="favorite.fill"]')).toBeTruthy();
    expect(live.statsCalls).toBe(0);
    expect(live.myGradeCalls).toBe(0);
    expect(live.thumbnailProps).toHaveLength(0);
  });
});
