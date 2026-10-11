// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { ClimbProgress } from '../../lib/climb-progress';

const live = vi.hoisted(() => ({ fontScale: 1, now: 0, clockReads: 0 }));
vi.mock('../../lib/clock', () => ({
  nowMs: () => {
    live.clockReads += 1;
    return live.now;
  },
}));
vi.mock('../../hooks/use-climb-progress', () => ({ useClimbProgress: () => null, useBoardClimbProgress: () => null }));
vi.mock('../Text', () => ({
  Text: ({
    children,
    variant,
    maxFontSizeMultiplier,
  }: {
    children?: ReactNode;
    variant?: string;
    maxFontSizeMultiplier?: number;
  }) => createElement('span', { 'data-variant': variant, 'data-font-cap': maxFontSizeMultiplier }, children),
}));
vi.mock('../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ fontScale: live.fontScale }),
  StyleSheet: { create: <Styles,>(styles: Styles) => styles },
  View: ({
    children,
    accessibilityLabel,
    testID,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    testID?: string;
  }) => createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#111', secondaryLabel: '#888' } }),
}));
const translate = (key: string, options?: Record<string, unknown>) => {
  const words: Record<string, string> = {
    'mobile.climbRow.progress.flashed': 'Flashed',
    'mobile.climbRow.progress.sent': 'Sent',
    'mobile.climbRow.progress.sentTimes': `Sent ×${String(options?.count)}`,
    'mobile.climbRow.progress.tries': `${String(options?.count)} tries`,
    'mobile.climbRow.progress.today': 'today',
    'mobile.climbRow.progress.daysAgo': `${String(options?.count)}d`,
    'mobile.logbook.originalTag': 'Original',
    'mobile.logbook.mirroredTag': 'Mirror',
    'mobile.climbRow.ascentStatus.send': 'Sent',
    'mobile.climbRow.ascentStatus.flash': 'Flashed',
    'mobile.climbRow.ascentStatus.attempt': 'Tried',
    'mobile.climbRow.directionStatus': `${String(options?.direction)}: ${String(options?.status)}`,
  };
  return words[key] ?? key;
};
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en-US' } }) }));
import { ClimbProgressView } from '../ClimbProgressLine';

const progress: ClimbProgress = {
  status: 'flash',
  outcome: { kind: 'flash', sendCount: 3 },
  mirror: 'both',
  originalStatus: 'flash',
  mirrorStatus: 'attempt',
  latestClimbedAtMs: null,
};
const props = { supportsMirroring: true, showDirectionStatuses: true, reserveLine: true };
beforeEach(() => {
  live.fontScale = 1;
  live.clockReads = 0;
  live.now = new Date(2026, 9, 11, 12).getTime();
});
describe('personal progress line', () => {
  it('shows flash repeat count and both independent statuses on one line', () => {
    const { container } = render(<ClimbProgressView {...props} progress={progress} />);
    expect(screen.getByText('Sent ×3')).toBeTruthy();
    expect(screen.getAllByTestId('climb-row-personal-line')).toHaveLength(1);
    expect(screen.getByTestId('climb-row-personal-line').getAttribute('aria-label')).toBe(
      'Sent ×3 · Original: Flashed · Mirror: Tried',
    );
    expect(container.querySelector('[data-icon="ascent.attempt"]')).toBeTruthy();
  });
  it('keeps direction statuses in the spoken label at large text', () => {
    live.fontScale = 1.5;
    render(<ClimbProgressView {...props} progress={progress} />);
    expect(screen.getByTestId('climb-row-personal-line').getAttribute('aria-label')).toContain('Mirror: Tried');
    expect(screen.getByText('Sent ×3').getAttribute('data-font-cap')).toBe('1.3');
  });
  it('reserves a silent line before history arrives and for signed-out rows', () => {
    const result = render(<ClimbProgressView {...props} progress={null} />);
    expect(screen.getByTestId('climb-row-personal-line').textContent).toBe('\u00A0');
    result.rerender(<ClimbProgressView {...props} reserveLine={false} progress={null} />);
    expect(screen.queryByTestId('climb-row-personal-line')).toBeNull();
  });
  it('memoizes the recency clock and drops it before outcome text', () => {
    const recent = { ...progress, latestClimbedAtMs: new Date(2026, 9, 10, 12).getTime() };
    const result = render(<ClimbProgressView {...props} progress={recent} />);
    expect(screen.getByText('· 1d')).toBeTruthy();
    live.now += 86_400_000;
    result.rerender(<ClimbProgressView {...props} progress={recent} />);
    expect(live.clockReads).toBe(1);
    expect(screen.getByText('· 1d')).toBeTruthy();
    live.fontScale = 1.3;
    result.rerender(<ClimbProgressView {...props} reserveLine={false} progress={recent} />);
    expect(screen.queryByText('· 2d')).toBeNull();
    expect(screen.getByText('Sent ×3')).toBeTruthy();
  });
});
