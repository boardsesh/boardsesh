// @vitest-environment jsdom
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => async () => false }));
//
// The one sheet rule #5971 added: on your own climb (only a spray wall offers
// Report there) the sheet is for changing the grade, so it locks to grade and
// shows no Hide/Grade switch. Anyone else's climb keeps both, starting on Hide.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';

const profileState = vi.hoisted(() => ({ id: null as string | null }));

const { passthrough } = vi.hoisted(() => ({
  passthrough: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-native', () => ({
  View: passthrough,
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-haptics', () => ({ notificationAsync: vi.fn(), NotificationFeedbackType: { Success: 1, Error: 2 } }));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ children, header }: { children?: ReactNode; header?: ReactNode }) =>
    createElement('div', null, header, children),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../SheetTopBar', async () => (await import('../../../test/sheet-top-bar-stub')).sheetTopBarModule);
vi.mock('../../PressableSurface', () => ({ PressableSurface: passthrough }));
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({ selectedKey }: { selectedKey: string }) =>
    createElement('div', { 'data-testid': 'kind-switch', 'data-selected': selectedKey }),
}));
vi.mock('../../ClimbPreviewCard', () => ({ ClimbPreviewCard: () => null }));
vi.mock('../../grade', () => ({
  GradeSingleSelectRail: () => createElement('div', { 'data-testid': 'grade-rail' }),
}));
vi.mock('../../tick', () => ({ TickNoteField: () => null }));
vi.mock('../../../lib/graphql/hooks/use-report-climb', () => ({
  useReportClimb: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useGrades: () => ({ data: [] }),
  useProfile: () => ({ data: profileState.id ? { id: profileState.id } : undefined }),
}));
vi.mock('../../../lib/graphql/extract-error-message', () => ({ extractGraphqlMessage: () => null }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#666' },
    brandColors: { primaryFill: '#6D28D9', error: '#f00' },
  }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16, 6: 24 } }));
vi.mock('@boardsesh/analytics', () => ({ SHARED_EVENTS: { ClimbReported: 'Climb Reported' } }));

import { ReportClimbSheet } from '../ReportClimbSheet';

const climb = { uuid: 'climb-1', name: 'Garage project', difficulty: '6b/V4', userId: 'setter-1' } as unknown as Climb;

function renderSheet() {
  return render(
    createElement(ReportClimbSheet, {
      visible: true,
      climb,
      boardName: 'spray',
      layoutId: 1,
      sizeId: 1,
      setIds: '1',
      angle: 40,
      onClose: vi.fn(),
    }),
  );
}

beforeEach(() => {
  profileState.id = null;
});

describe('ReportClimbSheet on your own climb (#5971)', () => {
  it('locks to grade: no Hide/Grade switch, the grade rail shows', () => {
    profileState.id = 'setter-1';
    const { queryByTestId, getByTestId } = renderSheet();
    expect(queryByTestId('kind-switch')).toBeNull();
    expect(getByTestId('grade-rail')).toBeTruthy();
  });

  it('keeps both kinds, starting on Hide, on somebody else’s climb', () => {
    profileState.id = 'someone-else';
    const { getByTestId, queryByTestId } = renderSheet();
    expect(getByTestId('kind-switch').getAttribute('data-selected')).toBe('hide');
    expect(queryByTestId('grade-rail')).toBeNull();
  });
});
