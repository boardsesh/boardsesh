// @vitest-environment jsdom
//
// Where a notification tap lands. The proposal branch is the part worth pinning:
// it is the only row type that opens a screen rather than the play drawer, it
// must reach the SAME root `/moderation` modal whichever tab the bell was tapped
// in (the feed is one root route now, not a copy per tab stack), and it must
// fall back to the climb the moment the `climb-moderation-kill` flag closes the
// feed. Marking the group read happens BEFORE any of that, so a flag flip can
// never leave a row unread.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { GroupedNotification } from '@boardsesh/shared-schema';

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
const markGroupMutate = vi.hoisted(() => vi.fn());
const openPlayDrawer = vi.hoisted(() => vi.fn());
const openClimbInPlayDrawer = vi.hoisted(() => vi.fn());
const openCommentThread = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  moderationEnabled: true,
}));

vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
}));
vi.mock('../../../lib/graphql/hooks/use-notifications', () => ({
  useMarkGroupAsRead: () => ({ mutate: markGroupMutate }),
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({
    data: { boardType: 'kilter', angle: 45, layoutId: 8, sizeId: 25, setIds: '1,20' },
  }),
}));
vi.mock('../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => ({ openPlayDrawer }) }));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useClimbModerationEnabled: () => state.moderationEnabled,
}));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer }));

import { useNotificationNavigation } from '../use-notification-navigation';

function makeNotification(overrides: Partial<GroupedNotification> = {}): GroupedNotification {
  return {
    uuid: 'group-1',
    type: 'proposal_on_your_climb',
    entityType: null,
    entityId: null,
    actorCount: 1,
    actors: [],
    commentBody: null,
    climbName: 'Test Climb',
    climbUuid: 'climb-1',
    boardType: 'kilter',
    climbLayoutId: 8,
    climbAngle: 40,
    proposalUuid: 'proposal-1',
    proposalType: 'hide',
    setterUsername: null,
    gymName: null,
    isRead: false,
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  } as GroupedNotification;
}

function tap(notification: GroupedNotification) {
  const { result } = renderHook(() => useNotificationNavigation(openCommentThread));
  result.current(notification);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useNotificationNavigation proposal rows', () => {
  beforeEach(() => {
    routerMock.push.mockReset();
    markGroupMutate.mockReset();
    openClimbInPlayDrawer.mockReset();
    state.moderationEnabled = true;
  });

  it('opens the moderation feed on the proposal, carrying the climb coordinates', () => {
    tap(makeNotification());

    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/moderation',
      params: { proposalUuid: 'proposal-1', climbUuid: 'climb-1', boardType: 'kilter' },
    });
    expect(openClimbInPlayDrawer).not.toHaveBeenCalled();
  });

  it('pushes the ROOT modal, never a tab-scoped copy', () => {
    // The regression this guards: a `(tabs)/…` push from the Home bell lands
    // beneath the player when the drawer is open, and the reader taps nothing.
    tap(makeNotification());

    const [{ pathname }] = routerMock.push.mock.calls[0] as [{ pathname: string }];
    expect(pathname).toBe('/moderation');
    expect(pathname).not.toContain('(tabs)');
  });

  it('routes every proposal_* type to the feed, not just the setter row', () => {
    tap(makeNotification({ type: 'proposal_approved', proposalUuid: 'proposal-9' }));

    expect(routerMock.push).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ proposalUuid: 'proposal-9' }) }),
    );
  });

  it('omits climb params a bare proposal row does not carry', () => {
    tap(makeNotification({ type: 'proposal_vote', climbUuid: null, boardType: null }));

    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/moderation',
      params: { proposalUuid: 'proposal-1' },
    });
  });

  it('opens the climb when the row carries no proposal', () => {
    tap(makeNotification({ proposalUuid: null }));

    expect(routerMock.push).not.toHaveBeenCalled();
    expect(openClimbInPlayDrawer).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ref', climbUuid: 'climb-1', boardType: 'kilter' }),
      expect.anything(),
    );
  });

  it('opens the climb when the kill flag closes the feed', () => {
    state.moderationEnabled = false;
    tap(makeNotification());

    expect(routerMock.push).not.toHaveBeenCalled();
    expect(openClimbInPlayDrawer).toHaveBeenCalledWith(
      expect.objectContaining({ climbUuid: 'climb-1' }),
      expect.anything(),
    );
  });

  it('marks the group read before routing, and only when it is unread', () => {
    const unread = makeNotification();
    tap(unread);
    expect(markGroupMutate).toHaveBeenCalledWith(unread);

    markGroupMutate.mockReset();
    tap(makeNotification({ isRead: true }));
    expect(markGroupMutate).not.toHaveBeenCalled();
  });

  it('still marks read when the flag is off and the row has no climb to open', () => {
    state.moderationEnabled = false;
    const orphan = makeNotification({ proposalUuid: 'proposal-1', climbUuid: null, boardType: null });
    tap(orphan);

    expect(markGroupMutate).toHaveBeenCalledWith(orphan);
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(openClimbInPlayDrawer).not.toHaveBeenCalled();
  });
});
