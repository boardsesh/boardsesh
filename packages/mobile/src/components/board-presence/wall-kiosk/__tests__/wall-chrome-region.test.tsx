// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import type { WallPreviewState } from '../useWallPreview';

type HostProps = { children?: ReactNode };

vi.mock('react-native', () => ({
  View: ({ children }: HostProps) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../WallStateStrip', () => ({
  WallStateStrip: () => createElement('div', { 'data-testid': 'state-strip' }),
}));

vi.mock('../WallScrubber', () => ({
  WallScrubber: () => createElement('div', { 'data-testid': 'scrubber' }),
}));

vi.mock('../WallIdentityBlock', () => ({
  WallIdentityBlock: ({ nameLines }: { nameLines?: number }) =>
    createElement('div', { 'data-testid': 'identity', 'data-name-lines': String(nameLines) }),
}));

vi.mock('../../../Text', () => ({
  Text: ({ children }: HostProps) => createElement('span', null, children),
}));

vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { elevatedSurface: '#fff', separator: '#ccc', secondaryLabel: '#666', label: '#111' },
  }),
}));

vi.mock('../../../../hooks/use-display-grade', () => ({
  useDisplayGrade: () => ({ resolveGrade: () => ({ label: 'V5', color: '#ff0' }) }),
}));

vi.mock('../../../../lib/format-relative-time', () => ({ formatRelativeTime: () => 'now' }));
vi.mock('../../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16 }, borderRadius: { lg: 12 } }));

import { WallChromeRegion } from '../WallChromeRegion';

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

const preview: WallPreviewState = {
  displayedClimb: climb,
  liveClimb: climb,
  previewClimb: null,
  isPreviewing: false,
  stepsBack: 0,
  previewTimestamp: null,
  historyCount: 1,
  lastLitClimb: null,
  canStepOlder: true,
  canStepNewer: false,
  isLoadingOlder: false,
  step: vi.fn(),
  goOldest: vi.fn(),
  backToLive: vi.fn(),
  canLight: false,
  lightBlockedReason: null,
  isLighting: false,
  lightError: false,
  lightThis: vi.fn(),
  pendingOverride: false,
  confirmOverride: vi.fn(),
  cancelOverride: vi.fn(),
};

describe('WallChromeRegion at reading distance', () => {
  it('puts the state strip and identity beside the scrubber on a two-column 11-inch portrait band', () => {
    const { getByTestId, container } = render(
      <WallChromeRegion region="band" mode="live" preview={preview} typeScale={typeScale} bandWidth={738} />,
    );

    expect(getByTestId('identity').getAttribute('data-name-lines')).toBe('2');
    expect(getByTestId('state-strip').parentElement).toBe(getByTestId('identity').parentElement);
    expect(getByTestId('scrubber').parentElement).not.toBe(getByTestId('identity').parentElement);
    // No setter byline: it was too small to read from the mat.
    expect(container.textContent).not.toContain('setByLine');
  });

  it('gives the state strip its own column and fits the name to one line on a three-column 13-inch band', () => {
    const { getByTestId, container } = render(
      <WallChromeRegion region="band" mode="live" preview={preview} typeScale={typeScale} bandWidth={1270} />,
    );

    expect(getByTestId('identity').getAttribute('data-name-lines')).toBe('1');
    expect(getByTestId('state-strip').parentElement).not.toBe(getByTestId('identity').parentElement);
    expect(getByTestId('state-strip').parentElement).not.toBe(getByTestId('scrubber').parentElement);
    expect(container.textContent).not.toContain('setByLine');
  });

  it('stacks the state strip over the identity in a rail, with the scrubber below', () => {
    const { getByTestId } = render(
      <WallChromeRegion region="rail" mode="live" preview={preview} typeScale={typeScale} bandWidth={360} />,
    );

    expect(getByTestId('identity').getAttribute('data-name-lines')).toBe('2');
    expect(getByTestId('state-strip').parentElement).toBe(getByTestId('identity').parentElement);
    expect(getByTestId('scrubber').parentElement).not.toBe(getByTestId('identity').parentElement);
  });
});
