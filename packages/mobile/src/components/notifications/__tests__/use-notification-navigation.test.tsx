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
  directoryReportsEnabled: true,
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
  useDirectoryReportsEnabled: () => state.directoryReportsEnabled,
}));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer }));
const explainDirectoryNotice = vi.hoisted(() => vi.fn());
vi.mock('../explain-directory-notice', () => ({ explainDirectoryNotice }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

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
  state.directoryReportsEnabled = true;
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

describe('bug report reply navigation', () => {
  it('opens its report and marks the notification read', () => {
    tap(makeNotification({ type: 'app_feedback_reply', entityId: '42', entityType: null }));
    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/bug-reports/[id]', params: { id: '42' } });
    expect(markGroupMutate).toHaveBeenCalledOnce();
    expect(openClimbInPlayDrawer).not.toHaveBeenCalled();
  });

  it('ignores malformed report ids instead of opening an unrelated climb', () => {
    tap(makeNotification({ type: 'app_feedback_reply', entityId: '../settings', entityType: null }));
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(openClimbInPlayDrawer).not.toHaveBeenCalled();
  });
});

describe('useNotificationNavigation owner comment rows', () => {
  // The rows an item's owner gets for a comment on it (#6385) open that item's
  // thread, never the climb, even when the row carries a climb to draw.
  it.each([
    { type: 'comment_on_session', threadEntityType: 'session', threadEntityId: 'session-1' },
    { type: 'comment_on_climb', threadEntityType: 'climb', threadEntityId: 'climb-1' },
    { type: 'comment_on_playlist', threadEntityType: 'playlist_climb', threadEntityId: 'playlist-1:climb-1' },
    { type: 'comment_on_board', threadEntityType: 'board', threadEntityId: 'board-1' },
    { type: 'comment_on_gym', threadEntityType: 'gym', threadEntityId: 'gym-1' },
  ] as const)('opens the $threadEntityType thread for $type', ({ type, threadEntityType, threadEntityId }) => {
    const notification = makeNotification({
      type,
      entityType: threadEntityType,
      entityId: threadEntityId,
      threadEntityType,
      threadEntityId,
      proposalUuid: null,
      proposalType: null,
    });
    tap(notification);
    expect(markGroupMutate).toHaveBeenCalledWith(notification);
    expect(openCommentThread).toHaveBeenCalledWith(threadEntityType, threadEntityId);
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(openClimbInPlayDrawer).not.toHaveBeenCalled();
  });
});

describe('useNotificationNavigation spray imports', () => {
  it.each([
    { resetOf: null, params: { wallUuid: 'wall-1', versionId: '123' } },
    { resetOf: 'wall-0', params: { resetOf: 'wall-0' } },
  ])('opens the completed import with resetOf=$resetOf', ({ resetOf, params }) => {
    const notification = makeNotification({
      type: 'spray_wall_detection_completed',
      sprayWallUuid: 'wall-1',
      sprayVersionId: '123',
      sprayResetOfWallUuid: resetOf,
      actorCount: 0,
      actors: [],
    });
    tap(notification);
    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/boards/spray/new', params });
    expect(markGroupMutate).toHaveBeenCalledWith(notification);
    expect(openClimbInPlayDrawer).not.toHaveBeenCalled();
  });

  it('opens My Boards when the completed photo is no longer accessible', () => {
    tap(makeNotification({ type: 'spray_wall_detection_completed', sprayWallUuid: null, sprayVersionId: null }));
    expect(routerMock.push).toHaveBeenCalledWith('/boards');
    expect(openClimbInPlayDrawer).not.toHaveBeenCalled();
  });
});

describe('directory notice navigation', () => {
  const directoryNotice = {
    targetKind: 'board' as const,
    boardUuid: 'board-1',
    boardName: 'Crux Kilter',
    boardType: 'kilter',
    gymUuid: 'gym-1',
    gymName: 'Crux',
    reportUuid: 'report-1',
    reason: 'wrong_setup' as const,
    outcome: null,
    resolvedByRole: null,
    resolutionNote: null,
    actorRole: null,
    isReminder: false,
    recipientIsCreator: true,
  };

  it('opens the review sheet on a report about your board', () => {
    tap(makeNotification({ type: 'board_report_opened', entityType: 'board', entityId: 'board-1', directoryNotice }));
    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/boards', params: { board: 'board-1', review: '1' } });
  });

  it('opens the board, offering to ask the gym to list it again, after staff took it off', () => {
    tap(
      makeNotification({
        type: 'board_removed_from_gym',
        entityType: 'board',
        entityId: 'board-1',
        directoryNotice: { ...directoryNotice, actorRole: 'gym_staff' },
      }),
    );
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards',
      params: { board: 'board-1', details: '1', relistGymUuid: 'gym-1', relistGym: 'Crux' },
    });
  });

  it("never offers a relist after a moderator's removal, which the gym's staff can't undo", () => {
    tap(
      makeNotification({
        type: 'board_removed_from_gym',
        entityType: 'board',
        entityId: 'board-1',
        directoryNotice: { ...directoryNotice, actorRole: 'moderator' },
      }),
    );
    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/boards', params: { board: 'board-1', details: '1' } });
  });

  it('opens the plain board, with no review sheet or relist, while the flag is off', () => {
    state.directoryReportsEnabled = false;
    tap(makeNotification({ type: 'board_report_opened', entityType: 'board', entityId: 'board-1', directoryNotice }));
    tap(
      makeNotification({
        type: 'board_removed_from_gym',
        entityType: 'board',
        entityId: 'board-1',
        directoryNotice: { ...directoryNotice, actorRole: 'gym_staff' },
      }),
    );
    expect(routerMock.push.mock.calls).toEqual([
      [{ pathname: '/boards', params: { board: 'board-1', details: '1' } }],
      [{ pathname: '/boards', params: { board: 'board-1', details: '1' } }],
    ]);
  });

  it('explains a deleted board instead of opening it', () => {
    tap(makeNotification({ type: 'board_deleted_by_staff', directoryNotice }));
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(explainDirectoryNotice).toHaveBeenCalledWith(
      { kind: 'explain', explanation: 'board_deleted', name: 'Crux Kilter' },
      expect.any(Function),
    );
  });

  it('opens the gym editor for staff on a gym report', () => {
    tap(
      makeNotification({
        type: 'gym_report_opened',
        entityType: 'gym',
        entityId: 'gym-1',
        directoryNotice: { ...directoryNotice, targetKind: 'gym', boardUuid: null, boardName: null },
      }),
    );
    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/gyms/edit', params: { gymUuid: 'gym-1' } });
  });

  it("opens the gym's page on the denial card when we couldn't confirm a claim", () => {
    tap(
      makeNotification({
        type: 'gym_claim_denied',
        entityType: 'gym',
        entityId: 'gym-1',
        directoryNotice: { ...directoryNotice, targetKind: 'gym', boardUuid: null, boardName: null },
      }),
    );
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/gyms/[gym]',
      params: { gym: 'gym-1', claim: 'denied' },
    });
    expect(explainDirectoryNotice).not.toHaveBeenCalled();
  });

  it('explains a claim denial that lost its gym', () => {
    tap(makeNotification({ type: 'gym_claim_denied', gymName: 'Crux' }));
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(explainDirectoryNotice).toHaveBeenCalledWith(
      { kind: 'explain', explanation: 'claim_denied', name: 'Crux' },
      expect.any(Function),
    );
  });

  it('marks a gym report outcome read without opening anything', () => {
    tap(makeNotification({ type: 'gym_report_resolved', entityType: 'gym', entityId: 'gym-1' }));
    expect(markGroupMutate).toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(openClimbInPlayDrawer).not.toHaveBeenCalled();
  });
});

describe('useNotificationNavigation gym claims', () => {
  it('opens the gym page on the root stack when a claim comes through', () => {
    tap(
      makeNotification({
        type: 'gym_claim_approved',
        entityType: 'gym',
        entityId: 'gym-uuid-1',
        gymName: 'Crux',
        climbUuid: null,
        proposalUuid: null,
      }),
    );
    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/gyms/[gym]', params: { gym: 'gym-uuid-1' } });
    expect(openClimbInPlayDrawer).not.toHaveBeenCalled();
  });
});
