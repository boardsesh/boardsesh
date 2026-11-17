// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';

type HostProps = { children?: ReactNode };

vi.mock('react-native', () => ({
  View: ({ children }: HostProps) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  Platform: { OS: 'ios' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'mobile.boardPresence.kiosk.previewTag' ? 'Preview' : key),
  }),
}));

vi.mock('../../../Text', () => ({
  Text: ({ children }: HostProps) => createElement('span', null, children),
}));

vi.mock('../../../grade/grade-chip-colors', () => ({ readableTextColor: () => '#000000' }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#eee', label: '#111', secondaryLabel: '#666' },
    brandColors: { historyFill: '#333' },
  }),
}));
vi.mock('../../../../hooks/use-aurora-presence-grades', () => ({
  useAuroraPresenceClimb: (climb: BoardPresenceClimb | null, config: { angle: number } | null) =>
    climb?.source === 'aurora' && config
      ? {
          climb: { ...climb, angle: config.angle, grade: `V${config.angle}` },
          grade: { difficulty: `V${config.angle}` },
        }
      : { climb, grade: undefined },
}));
vi.mock('../../../../hooks/use-display-grade', () => ({
  useDisplayGrade: () => ({
    resolveGrade: (climb: { difficulty?: string | null }) => ({ label: climb.difficulty ?? '', color: '#ff0' }),
  }),
}));
vi.mock('../../../../theme/tokens', () => ({
  spacing: { 2: 8, 3: 12 },
  borderRadius: { sm: 4, md: 8, full: 9999 },
}));

import { WallIdentityBlock } from '../WallIdentityBlock';
import { WallIdleRecoveryView } from '../WallIdleRecoveryView';

const typeScale = {
  gradeFontSize: 64,
  gradeLineHeight: 68,
  nameFontSize: 40,
  nameLineHeight: 44,
  metaFontSize: 20,
  metaLineHeight: 26,
  stateFontSize: 20,
  stateLineHeight: 26,
};

const climb: BoardPresenceClimb = {
  climbUuid: 'climb-1',
  name: 'Moon Cheese',
  grade: 'V5',
  angle: 40,
  setter: 'Taylor',
  sentByUserId: 'lighter-1',
  sentByDisplayName: 'Marco',
  sentByAvatarUrl: null,
  sentAt: '2026-07-31T12:00:00.000Z',
  seq: 1,
};

describe('WallIdentityBlock at reading distance', () => {
  it('shows the grade and the name, and nothing too small to read from the mat', () => {
    const { container, getByText } = render(
      <WallIdentityBlock climb={climb} typeScale={typeScale} isPreviewing={false} />,
    );

    expect(getByText('V5')).toBeTruthy();
    expect(getByText('Moon Cheese')).toBeTruthy();
    // The setter, the angle badge and the Lit-by name were 13–24 pt.
    expect(container.textContent).not.toContain('Taylor');
    expect(container.textContent).not.toContain('40°');
    expect(container.textContent).not.toContain('Marco');
  });

  it('tags a history preview so it never reads as the live climb', () => {
    const { getByText } = render(<WallIdentityBlock climb={climb} typeScale={typeScale} isPreviewing />);

    expect(getByText('Preview')).toBeTruthy();
  });

  it('renders nothing without a climb', () => {
    const { container } = render(<WallIdentityBlock climb={null} typeScale={typeScale} isPreviewing={false} />);

    expect(container.textContent).toBe('');
  });
});

it('updates kiosk identity grades at the selected angle without stamping shared history', () => {
  const imported = { ...climb, source: 'aurora' as const, grade: null, angle: null };
  const config = { boardName: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13', angle: 20 };
  const { getByText, rerender } = render(
    <WallIdentityBlock climb={imported} typeScale={typeScale} isPreviewing={false} boardConfig={config} />,
  );
  expect(getByText('V20')).toBeTruthy();
  rerender(
    <WallIdentityBlock
      climb={imported}
      typeScale={typeScale}
      isPreviewing={false}
      boardConfig={{ ...config, angle: 45 }}
    />,
  );
  expect(getByText('V45')).toBeTruthy();
  expect(imported.angle).toBeNull();
});

it('shows the selected-angle Boardsesh-only estimate for the idle last-lit Aurora climb', () => {
  const lastLit = { ...climb, source: 'aurora' as const, grade: null, angle: null };
  const { container, rerender } = render(
    <WallIdleRecoveryView
      lastLitClimb={lastLit}
      typeScale={typeScale}
      ledless={false}
      resolvedGrade={{ label: '≈V5', color: '#ff0' }}
      relativeTime="now"
    />,
  );
  expect(container.textContent).toContain('≈V5');
  expect(container.textContent).toContain('Moon Cheese');
  expect(lastLit).toMatchObject({ grade: null, angle: null });
  rerender(
    <WallIdleRecoveryView
      lastLitClimb={{ ...lastLit, source: 'boardsesh' }}
      typeScale={typeScale}
      ledless={false}
      resolvedGrade={{ label: '≈V5', color: '#ff0' }}
      relativeTime="now"
    />,
  );
  expect(container.textContent).not.toContain('≈V5');
});
