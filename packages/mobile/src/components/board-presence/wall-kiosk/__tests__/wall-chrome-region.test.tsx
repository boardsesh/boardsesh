// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BoardClimbRecentSender, BoardPresenceClimb } from '@boardsesh/shared-schema';
import type { WallPreviewState } from '../useWallPreview';

type HostProps = { children?: ReactNode };

vi.mock('react-native', () => ({
  View: ({ children }: HostProps) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Every byline key the chrome can render, so a test that stops mocking
    // WallAttributionBlock gets real copy instead of raw key strings.
    t: (key: string, values?: Record<string, string>) => {
      if (key === 'mobile.boardPresence.setByLine') return `Set by ${values?.setter}`;
      if (key === 'boardPresence.litByLine') return `Lit by ${values?.name}`;
      if (key === 'boardPresence.sentByLabel') return 'Sent by';
      return key;
    },
  }),
}));

vi.mock('../WallStateStrip', () => ({
  WallStateStrip: () => createElement('div', { 'data-testid': 'state-strip' }),
}));

vi.mock('../WallScrubber', () => ({
  WallScrubber: () => createElement('div', { 'data-testid': 'scrubber' }),
}));

vi.mock('../WallIdentityBlock', () => ({
  WallIdentityBlock: ({
    showAttribution,
    showSetter,
    nameLines,
  }: {
    showAttribution?: boolean;
    showSetter?: boolean;
    nameLines?: number;
  }) =>
    createElement('div', {
      'data-testid': 'identity',
      'data-show-attribution': String(showAttribution),
      'data-show-setter': String(showSetter),
      'data-name-lines': String(nameLines),
    }),
  WallAttributionBlock: () => createElement('div', { 'data-testid': 'attribution' }),
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

const recentSenders: BoardClimbRecentSender[] = [
  {
    userId: 'sender-1',
    displayName: 'Alex',
    avatarUrl: null,
    lastSentAt: '2026-07-31T11:00:00.000Z',
  },
];

describe('WallChromeRegion band attribution placement', () => {
  it('uses the controls column slack on a two-column 11-inch portrait band', () => {
    const { getByTestId } = render(
      <WallChromeRegion
        region="band"
        mode="live"
        preview={preview}
        typeScale={typeScale}
        bandWidth={738}
        compact={false}
        recentSenders={recentSenders}
      />,
    );

    expect(getByTestId('identity').getAttribute('data-show-attribution')).toBe('false');
    expect(getByTestId('identity').getAttribute('data-show-setter')).toBe('true');
    expect(getByTestId('identity').getAttribute('data-name-lines')).toBe('2');
    expect(getByTestId('attribution')).toBeTruthy();
    expect(getByTestId('scrubber')).toBeTruthy();
  });

  it('uses a dedicated byline column and fitted name on a three-column 13-inch landscape band', () => {
    const { getByTestId, getByText } = render(
      <WallChromeRegion
        region="band"
        mode="live"
        preview={preview}
        typeScale={typeScale}
        bandWidth={1270}
        compact={false}
        recentSenders={recentSenders}
      />,
    );

    expect(getByTestId('identity').getAttribute('data-show-attribution')).toBe('false');
    expect(getByTestId('identity').getAttribute('data-show-setter')).toBe('false');
    expect(getByTestId('identity').getAttribute('data-name-lines')).toBe('1');
    expect(getByText('Set by Taylor')).toBeTruthy();
    expect(getByTestId('attribution')).toBeTruthy();
    expect(getByTestId('state-strip').parentElement).toBe(getByTestId('attribution').parentElement);
    expect(getByTestId('state-strip').parentElement).not.toBe(getByTestId('identity').parentElement);
  });

  it('keeps the paired attribution inside a tall rail identity block', () => {
    const { getByTestId, queryByTestId } = render(
      <WallChromeRegion
        region="rail"
        mode="live"
        preview={preview}
        typeScale={typeScale}
        bandWidth={360}
        compact={false}
        recentSenders={recentSenders}
      />,
    );

    expect(getByTestId('identity').getAttribute('data-show-attribution')).toBe('true');
    expect(getByTestId('identity').getAttribute('data-show-setter')).toBe('true');
    expect(queryByTestId('attribution')).toBeNull();
  });
});
