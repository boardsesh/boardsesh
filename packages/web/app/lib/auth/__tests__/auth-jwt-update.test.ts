import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock server-only
vi.mock('server-only', () => ({}));

// Mock DrizzleAdapter before auth-options imports it
vi.mock('@auth/drizzle-adapter', () => ({
  DrizzleAdapter: () => ({}),
}));

// Mock bcryptjs
vi.mock('bcryptjs', () => ({
  default: { compare: vi.fn() },
}));

// Mock native-oauth-transfer
vi.mock('@/app/lib/auth/native-oauth-transfer', () => ({
  verifyNativeOAuthTransferToken: vi.fn(),
}));

// Mock database
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockOnConflictDoNothing = vi.fn();

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
  }),
}));

vi.mock('@/app/lib/db/schema', () => ({
  users: { id: 'users.id', name: 'users.name', image: 'users.image', email: 'users.email', emailVerified: 'users.emailVerified' },
  accounts: { userId: 'accounts.userId', provider: 'accounts.provider' },
  sessions: {},
  verificationTokens: {},
  userProfiles: { userId: 'userProfiles.userId' },
  userCredentials: { userId: 'userCredentials.userId', passwordHash: 'userCredentials.passwordHash' },
}));

// Import after mocks
import { authOptions } from '../auth-options';

// Extract the jwt callback for testing
const jwtCallback = authOptions.callbacks!.jwt!;

beforeEach(() => {
  vi.clearAllMocks();
  // Setup chain: select().from().where().limit()
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ limit: mockLimit });
  mockInsert.mockReturnValue({ values: mockValues });
  mockValues.mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing });
});

describe('JWT callback', () => {
  it('persists user id on initial sign-in', async () => {
    const token = { sub: 'user-1' };
    const user = { id: 'user-1', email: 'test@example.com', name: 'Test', image: null };

    const result = await jwtCallback({
      token,
      user,
      trigger: undefined,
      account: null,
      profile: undefined,
      isNewUser: false,
      session: undefined,
    } as Parameters<typeof jwtCallback>[0]);

    expect(result.id).toBe('user-1');
    // Should NOT query DB on initial sign-in
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('refreshes name and image from DB when trigger is "update"', async () => {
    mockLimit.mockResolvedValue([{ name: 'Updated Name', image: 'https://example.com/avatar.jpg' }]);

    const token = { sub: 'user-1', name: null, picture: null };

    const result = await jwtCallback({
      token,
      user: undefined as unknown as Parameters<typeof jwtCallback>[0]['user'],
      trigger: 'update',
      account: null,
      profile: undefined,
      isNewUser: false,
      session: undefined,
    } as Parameters<typeof jwtCallback>[0]);

    expect(mockSelect).toHaveBeenCalled();
    expect(result.name).toBe('Updated Name');
    expect(result.picture).toBe('https://example.com/avatar.jpg');
  });

  it('does not query DB on regular token refresh (no trigger)', async () => {
    const token = { sub: 'user-1', name: 'Old Name' };

    const result = await jwtCallback({
      token,
      user: undefined as unknown as Parameters<typeof jwtCallback>[0]['user'],
      trigger: undefined,
      account: null,
      profile: undefined,
      isNewUser: false,
      session: undefined,
    } as Parameters<typeof jwtCallback>[0]);

    expect(mockSelect).not.toHaveBeenCalled();
    expect(result.name).toBe('Old Name');
  });

  it('handles missing user in DB gracefully during update', async () => {
    mockLimit.mockResolvedValue([]);

    const token = { sub: 'user-1', name: null, picture: null };

    const result = await jwtCallback({
      token,
      user: undefined as unknown as Parameters<typeof jwtCallback>[0]['user'],
      trigger: 'update',
      account: null,
      profile: undefined,
      isNewUser: false,
      session: undefined,
    } as Parameters<typeof jwtCallback>[0]);

    expect(mockSelect).toHaveBeenCalled();
    // Should not crash, name stays null
    expect(result.name).toBeNull();
  });

  it('does not query DB when trigger is "update" but token.sub is missing', async () => {
    const token = { name: null };

    const result = await jwtCallback({
      token,
      user: undefined as unknown as Parameters<typeof jwtCallback>[0]['user'],
      trigger: 'update',
      account: null,
      profile: undefined,
      isNewUser: false,
      session: undefined,
    } as Parameters<typeof jwtCallback>[0]);

    expect(mockSelect).not.toHaveBeenCalled();
    expect(result.name).toBeNull();
  });
});
