// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { BoardDetailSheet } from '../BoardDetailSheet';
const state = vi.hoisted(() => ({ canReport: true }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  Platform: { OS: 'android' },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('../../Sheet', () => ({
  Sheet: ({ children, header, visible }: { children: ReactNode; header?: ReactNode; visible: boolean }) =>
    visible ? createElement('div', null, header, children) : null,
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Avatar', () => ({ Avatar: () => null }));
vi.mock('../../SheetTopBar', async () => (await import('../../../test/sheet-top-bar-stub')).sheetTopBarModule);
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));
vi.mock('../../../lib/spray/use-spray-moderation', () => ({
  useSprayModerationAccess: () => ({ canReport: state.canReport }),
}));
vi.mock('../board-detail-fields', () => ({
  getBoardDetailFields: () => ({ setNames: '', subLocation: undefined, sizeText: undefined }),
  isActiveBoard: () => false,
}));
vi.mock('../../spray-wall/ReportSprayWallSheet', () => ({
  ReportSprayWallSheet: ({ wallUuid, wallName }: { wallUuid: string; wallName: string }) =>
    createElement('div', { 'data-testid': 'report-target' }, `${wallUuid}:${wallName}`),
}));
vi.mock('../BoardShareSheet', () => ({
  BoardShareSheet: ({ wallName }: { wallName: string }) =>
    createElement('div', { 'data-testid': 'share-target' }, wallName),
}));
const wall = {
  uuid: 'wall-a',
  name: 'Crew wall',
  slug: 'crew-wall',
  angle: 40,
  boardType: 'spray',
  canEdit: false,
  isPublic: true,
  isUnlisted: false,
  totalAscents: 0,
  uniqueClimbers: 0,
  followerCount: 0,
} as unknown as UserBoard;
beforeEach(() => {
  state.canReport = true;
});
describe('BoardDetailSheet moderation handoff', () => {
  it('offers reporting to a signed-in non-editor and retains target after detail displacement', () => {
    const props = { onClose: vi.fn(), onSetActive: vi.fn() };
    const screen = render(<BoardDetailSheet board={wall} visible {...props} />);
    fireEvent.click(screen.getByLabelText('sprayModeration.reportTitle'));
    screen.rerender(<BoardDetailSheet board={null} visible={false} {...props} />);
    expect(screen.getByTestId('report-target').textContent).toBe('wall-a:Crew wall');
  });
  it('retains share target after the same coordinator displacement', () => {
    const props = { onClose: vi.fn(), onSetActive: vi.fn() };
    const screen = render(<BoardDetailSheet board={wall} visible {...props} />);
    fireEvent.click(screen.getByLabelText('mobile.boardDetail.spray.shareLink'));
    screen.rerender(<BoardDetailSheet board={null} visible={false} {...props} />);
    expect(screen.getByTestId('share-target').textContent).toBe('Crew wall');
  });
  it('hides reporting when authorization is missing and on catalogue boards', () => {
    state.canReport = false;
    const props = { onClose: vi.fn(), onSetActive: vi.fn() };
    const screen = render(<BoardDetailSheet board={wall} visible {...props} />);
    expect(screen.queryByLabelText('sprayModeration.reportTitle')).toBeNull();
    state.canReport = true;
    screen.rerender(<BoardDetailSheet board={{ ...wall, boardType: 'kilter' }} visible {...props} />);
    expect(screen.queryByLabelText('sprayModeration.reportTitle')).toBeNull();
  });
});
