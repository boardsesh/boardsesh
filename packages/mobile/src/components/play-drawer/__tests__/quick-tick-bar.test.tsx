// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { logbookClimbAngleKey, type LogbookEntry } from '@boardsesh/board-react';

// QuickTickBar's `hasPriorHistory` decides flash vs send (deriveAscentType).
// It must read the prebuilt O(1) `logbookByClimbAngle` Map, NOT scan the raw
// `logbook` array. We prove this with a board whose `logbook` array is EMPTY
// (an array scan returns false → "flash") while the Map HAS an entry for this
// climb+angle (→ "send"). The save-button label is the observable.

const CLIMB_UUID = 'climb-1';
const ANGLE = 40;

const boardState = vi.hoisted(() => ({
  current: null as unknown,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) =>
    createElement('button', { 'data-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('@gorhom/bottom-sheet', () => ({ BottomSheetTextInput: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span') }));
vi.mock('../InlineStarPicker', () => ({ InlineStarPicker: () => null }));
vi.mock('../InlineTriesPicker', () => ({ InlineTriesPicker: () => null }));
vi.mock('../../grade', () => ({ GradeSingleSelectRail: () => null }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: { primary: '#6D28D9' } }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({ useGrades: () => ({ data: [] }) }));
vi.mock('@boardsesh/board-config', () => ({ toBoardName: (name: string) => name }));
vi.mock('@boardsesh/analytics', () => ({ SHARED_EVENTS: {} }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
// QuickTickBar reads board-presence flags; mock the provider so the test doesn't
// pull in its ws-client → expo-secure-store chain (un-mockable native module).
vi.mock('../../../providers/board-presence-provider', () => ({
  useBoardPresenceControls: () => ({ enabled: false, boardId: null }),
}));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSuccess: vi.fn(), hapticError: vi.fn() }));
vi.mock('../../../theme/colors', () => ({ brandColors: { success: '#047857' } }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: {} }));
vi.mock('../../../theme/tokens', () => ({ spacing: new Proxy({}, { get: () => 0 }) }));

// The board provider: an EMPTY logbook array (so an array scan finds nothing)
// plus a populated `logbookByClimbAngle` Map (the correct O(1) index).
vi.mock('@boardsesh/board-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/board-react')>();
  return {
    ...actual,
    useOptionalBoardProvider: () => boardState.current,
    useSaveTick: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

import { QuickTickBar } from '../QuickTickBar';

function renderBar() {
  return render(
    createElement(QuickTickBar, {
      climbUuid: CLIMB_UUID,
      boardName: 'kilter',
      angle: ANGLE,
      isMirror: false,
      isBenchmark: false,
      onDismiss: vi.fn(),
    }),
  );
}

describe('QuickTickBar hasPriorHistory', () => {
  it('reads the logbookByClimbAngle index, not the raw logbook array', () => {
    const tick = { climb_uuid: CLIMB_UUID, angle: ANGLE } as unknown as LogbookEntry;
    boardState.current = {
      // Empty array: a `.some()` scan would return false → "flash".
      logbook: [],
      // Map index HAS history at this climb+angle → should resolve to "send".
      logbookByClimbAngle: new Map<string, LogbookEntry[]>([[logbookClimbAngleKey(CLIMB_UUID, ANGLE), [tick]]]),
      getLogbook: vi.fn(),
    };

    const { container } = renderBar();
    const labels = Array.from(container.querySelectorAll('[data-label]')).map((node) =>
      node.getAttribute('data-label'),
    );
    // deriveAscentType(true, 1) === 'send', so the log-ascent button is labelled
    // for a send, not a flash. The array scan would have produced 'flash'.
    expect(labels).toContain('playView.tickBar.logAscentAria');
    const sendButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === 'playView.tickBar.sendSaveLabel',
    );
    const flashButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === 'playView.tickBar.flashSaveLabel',
    );
    expect(sendButton).toBeTruthy();
    expect(flashButton).toBeUndefined();
  });

  it('falls back to "send" (history assumed) when there is no board provider', () => {
    boardState.current = null;
    const { container } = renderBar();
    const flashButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === 'playView.tickBar.flashSaveLabel',
    );
    expect(flashButton).toBeUndefined();
  });
});
