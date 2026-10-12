// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { BoardDetailSheet } from '../BoardDetailSheet';
const state = vi.hoisted(() => ({
  canReport: true,
  profileId: 'viewer-1' as string | undefined,
  audience: undefined as string | undefined,
  privacyResourceIds: [] as (string | undefined)[],
}));
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
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: unknown) => styles,
    hairlineWidth: 1,
  },
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
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({ systemColors: {} }),
}));
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
vi.mock('../HomeBoardShareSheet', () => ({
  HomeBoardShareSheet: ({ target, boardName }: { target: { kind: string }; boardName: string }) =>
    createElement('div', { 'data-testid': 'home-share-target' }, `${target.kind}:${boardName}`),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: state.profileId ? { id: state.profileId } : undefined }),
}));
vi.mock('../../../lib/graphql/hooks/use-resource-privacy', () => ({
  useResourcePrivacy: (_kind: string, resourceId?: string) => {
    state.privacyResourceIds.push(resourceId);
    return { data: resourceId && state.audience ? { audience: state.audience } : undefined };
  },
}));
vi.mock('../../../lib/env', () => ({ WEB_BASE_URL: 'https://www.boardsesh.com' }));
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
  state.profileId = 'viewer-1';
  state.audience = undefined;
  state.privacyResourceIds = [];
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

const homeBoard = {
  uuid: 'home-a',
  name: 'Garage board',
  slug: 'garage-board',
  angle: 40,
  boardType: 'kilter',
  ownerId: 'viewer-1',
  isPublic: false,
  isUnlisted: false,
  totalAscents: 0,
  uniqueClimbers: 0,
  followerCount: 0,
} as unknown as UserBoard;

describe('BoardDetailSheet home board share row', () => {
  const props = { onClose: vi.fn(), onSetActive: vi.fn() };

  it("offers the owner an Invite-only board's invite link", () => {
    state.audience = 'invite_only';
    const screen = render(<BoardDetailSheet board={homeBoard} visible {...props} />);
    fireEvent.click(screen.getByLabelText('mobile.boardDetail.share.shareLink'));
    expect(screen.getByTestId('home-share-target').textContent).toBe('invite:Garage board');
  });

  it('offers no row for an Only-me board', () => {
    state.audience = 'only_me';
    const screen = render(<BoardDetailSheet board={homeBoard} visible {...props} />);
    expect(screen.queryByLabelText('mobile.boardDetail.share.shareLink')).toBeNull();
  });

  it("never asks for someone else's board audience, and offers them no row on a private board", () => {
    state.profileId = 'stranger';
    state.audience = 'followers';
    const screen = render(<BoardDetailSheet board={homeBoard} visible {...props} />);
    expect(screen.queryByLabelText('mobile.boardDetail.share.shareLink')).toBeNull();
    expect(state.privacyResourceIds.every((resourceId) => resourceId === undefined)).toBe(true);
  });

  it("offers anyone a Public board's plain link", () => {
    state.profileId = 'stranger';
    const screen = render(<BoardDetailSheet board={{ ...homeBoard, isPublic: true }} visible {...props} />);
    fireEvent.click(screen.getByLabelText('mobile.boardDetail.share.shareLink'));
    expect(screen.getByTestId('home-share-target').textContent).toBe('plain:Garage board');
  });
});
