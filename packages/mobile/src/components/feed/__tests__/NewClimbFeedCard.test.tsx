// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ActivityFeedItem } from '@boardsesh/shared-schema';
import { NewClimbFeedCard } from '../NewClimbFeedCard';

const mocks = vi.hoisted(() => ({ push: vi.fn(), open: vi.fn(), thumbnail: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { setter: string }) => (params ? `${key}:${params.setter}` : key),
  }),
}));
vi.mock('react-native', () => ({
  Platform: {
    OS: 'android',
    select: (options: { android?: unknown; default?: unknown }) => options.android ?? options.default,
  },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
vi.mock('../../Card', () => ({ Card: ({ children }: { children?: ReactNode }) => <section>{children}</section> }));
vi.mock('../../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => <span>{children}</span> }));
vi.mock('../../ClimbListThumbnail', () => ({
  ClimbListThumbnail: (props: unknown) => {
    mocks.thumbnail(props);
    return <div />;
  },
}));
vi.mock('../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => ({ openPlayDrawer: vi.fn() }) }));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (grade: string) => grade }),
}));
vi.mock('../../../lib/format-relative-time', () => ({ formatRelativeTime: () => '1d' }));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: mocks.open }));

const climb: ActivityFeedItem = {
  id: 'climb:new',
  type: 'new_climb',
  entityType: 'climb',
  entityId: 'new',
  climbUuid: 'new',
  climbName: 'Fresh holds',
  setterUsername: 'accountless',
  actorId: null,
  boardType: 'woods',
  layoutId: 1,
  frames: 'p1r1',
  angle: 40,
  difficultyName: 'V4',
  renderBoard: { layoutId: 1, sizeId: 1, setIds: [1] },
  createdAt: '2026-09-01T12:00:00Z',
};
beforeEach(() => {
  vi.clearAllMocks();
});

describe('NewClimbFeedCard', () => {
  it('uses the resolved small board and opens a full-climb reference preview', () => {
    const { getByRole, getByText } = render(<NewClimbFeedCard climb={climb} />);
    expect(getByText('V4 · 40°')).not.toBeNull();
    expect(mocks.thumbnail).toHaveBeenCalledWith(expect.objectContaining({ boardName: 'woods', sizeId: 1 }));
    fireEvent.click(getByRole('button', { name: /Fresh holds/ }));
    expect(mocks.open).toHaveBeenCalledWith(
      { kind: 'ref', climbUuid: 'new', boardType: 'woods', layoutId: 1, sizeId: 1, setIds: '1', angle: 40 },
      expect.anything(),
      { preview: true },
    );
  });
  it('opens the setter playlist without requiring a Boardsesh account', () => {
    const { getByRole } = render(<NewClimbFeedCard climb={climb} />);
    fireEvent.click(getByRole('button', { name: 'authors.setBy:accountless' }));
    expect(mocks.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/setter/[username]',
      params: { username: 'accountless' },
    });
  });
});
