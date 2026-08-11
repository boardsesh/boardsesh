import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

const mockGetServerSession = vi.fn();
vi.mock('next-auth/next', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@/app/lib/auth/auth-options', () => ({ authOptions: {} }));

vi.mock('@/app/lib/db/schema', () => ({
  communityRoles: {
    id: 'community_roles.id',
    userId: 'community_roles.user_id',
    role: 'community_roles.role',
    boardType: 'community_roles.board_type',
  },
}));

// The `where` result is awaited directly, but it also answers `.limit()` so a
// regression back to the `.limit(1)` query fails on the assertion below rather
// than on a missing method.
let queuedRows: Array<{ role: string; boardType: string | null }> = [];
const mockLimit = vi.fn((count: number) => Promise.resolve(queuedRows.slice(0, count)));
const mockWhere = vi.fn(() => Object.assign(Promise.resolve(queuedRows), { limit: mockLimit }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({ select: mockSelect }),
}));

const { checkAdmin } = await import('../check-admin');

describe('checkAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue({ user: { id: 'user-1' } });
    queuedRows = [];
  });

  it('reports unauthenticated when there is no session user', async () => {
    mockGetServerSession.mockResolvedValue(null);

    expect(await checkAdmin()).toEqual({ authenticated: false });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('denies a board-scoped admin and flags the scope (issue #4232)', async () => {
    // The pre-fix query matched any `role = 'admin'` row with `.limit(1)`, so a
    // kilter-scoped admin came back `isAdmin: true` and got a page whose every
    // action failed against `requireAdmin(ctx)`.
    queuedRows = [{ role: 'admin', boardType: 'kilter' }];

    expect(await checkAdmin()).toEqual({
      authenticated: true,
      userId: 'user-1',
      isAdmin: false,
      boardScopedOnly: true,
    });
  });

  it('grants a globally scoped admin', async () => {
    queuedRows = [{ role: 'admin', boardType: null }];

    expect(await checkAdmin()).toEqual({
      authenticated: true,
      userId: 'user-1',
      isAdmin: true,
      boardScopedOnly: false,
    });
  });

  it('grants a user holding both a scoped and a global admin row', async () => {
    // The dropped `.limit(1)` matters here: whichever row the database returned
    // first used to decide the answer.
    queuedRows = [
      { role: 'admin', boardType: 'kilter' },
      { role: 'admin', boardType: null },
    ];

    const access = await checkAdmin();
    expect(access).toEqual({ authenticated: true, userId: 'user-1', isAdmin: true, boardScopedOnly: false });
  });

  it('denies a signed-in user with no admin rows without the scoped copy', async () => {
    queuedRows = [];

    expect(await checkAdmin()).toEqual({
      authenticated: true,
      userId: 'user-1',
      isAdmin: false,
      boardScopedOnly: false,
    });
  });

  it('selects role and board type for every admin row, unlimited', async () => {
    await checkAdmin();

    expect(mockSelect).toHaveBeenCalledWith({
      role: 'community_roles.role',
      boardType: 'community_roles.board_type',
    });
    expect(mockWhere).toHaveBeenCalledTimes(1);
    // A `.limit(1)` here would hide a second admin row from the scope check.
    expect(mockLimit).not.toHaveBeenCalled();
  });
});
