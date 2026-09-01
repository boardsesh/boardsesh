import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { Session } from 'next-auth';
import { authOptions } from '../auth-options';

const { mockAdapterCreateUser, mockAdapterUpdateUser } = vi.hoisted(() => ({
  mockAdapterCreateUser: vi.fn(),
  mockAdapterUpdateUser: vi.fn(),
}));

// Mock server-only before any imports
vi.mock('server-only', () => ({}));

// Mock drizzle-orm query builder helpers (values are passed to mocked DB methods, so content is irrelevant)
vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ _type: 'and', args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ _type: 'eq', col, val })),
  isNull: vi.fn((col: unknown) => ({ _type: 'isNull', col })),
}));

// Adapter mutations stay visible so the OAuth rejection tests can prove that a
// missing-email callback stops before NextAuth's persistence boundary.
vi.mock('@auth/drizzle-adapter', () => ({
  DrizzleAdapter: vi.fn(() => ({
    createUser: mockAdapterCreateUser,
    updateUser: mockAdapterUpdateUser,
  })),
}));

// Mock OAuth providers — only present in the array; we test callbacks, not provider config
vi.mock('next-auth/providers/google', () => ({ default: vi.fn(() => ({ id: 'google' })) }));
vi.mock('next-auth/providers/apple', () => ({ default: vi.fn(() => ({ id: 'apple' })) }));
vi.mock('next-auth/providers/facebook', () => ({ default: vi.fn(() => ({ id: 'facebook' })) }));
// Preserve `id` and `authorize` so tests can retrieve them from authOptions.providers
vi.mock('next-auth/providers/credentials', () => ({
  default: vi.fn((opts: { id?: string; authorize?: unknown }) => ({
    id: opts.id ?? 'credentials',
    authorize: opts.authorize,
  })),
}));

// Mock native-oauth transfer verification
const mockVerifyNativeOAuthTransferToken = vi.fn();
vi.mock('../native-oauth-transfer', () => ({
  verifyNativeOAuthTransferToken: (...args: unknown[]) => mockVerifyNativeOAuthTransferToken(...args),
}));

// Mock bcrypt
const mockBcryptCompare = vi.fn();
vi.mock('bcryptjs', () => ({
  default: {
    compare: (...args: unknown[]) => mockBcryptCompare(...args),
  },
  compare: (...args: unknown[]) => mockBcryptCompare(...args),
}));

// --- DB mock ---
// We need to be able to swap return values per-test, so keep a mutable reference.
const mockDbUpdate = vi.fn();
const mockDbSet = vi.fn();
const mockDbUpdateWhere = vi.fn();
const mockDbSelect = vi.fn();
const mockDbFrom = vi.fn();
const mockDbWhere = vi.fn();
const mockDbLimit = vi.fn();

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    update: (...args: unknown[]) => mockDbUpdate(...args),
    select: (...args: unknown[]) => mockDbSelect(...args),
  }),
}));

vi.mock('@/app/lib/db/schema', () => ({
  users: {
    id: 'users.id',
    email: 'users.email',
    emailVerified: 'users.emailVerified',
  },
  accounts: {},
  sessions: {},
  verificationTokens: {},
  userCredentials: {
    userId: 'userCredentials.userId',
    passwordHash: 'userCredentials.passwordHash',
  },
  userProfiles: {},
}));

// Import after mocks are registered

// Helper to grab the signIn callback
type SignInParams = Parameters<NonNullable<NonNullable<typeof authOptions.callbacks>['signIn']>>[0];

async function callSignIn(params: Partial<SignInParams>) {
  const cb = authOptions.callbacks?.signIn;
  if (!cb) throw new Error('signIn callback not defined');
  return cb(params as SignInParams);
}

describe('authOptions.callbacks.signIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default DB chain: update().set().where() resolves
    mockDbUpdate.mockReturnValue({ set: mockDbSet });
    mockDbSet.mockReturnValue({ where: mockDbUpdateWhere });
    mockDbUpdateWhere.mockResolvedValue(undefined);

    // Default DB chain: select().from().where().limit() resolves to empty
    mockDbSelect.mockReturnValue({ from: mockDbFrom });
    mockDbFrom.mockReturnValue({ where: mockDbWhere });
    mockDbWhere.mockReturnValue({ limit: mockDbLimit });
    mockDbLimit.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // -------------------------------------------------------------------------
  // OAuth provider paths
  // -------------------------------------------------------------------------

  describe('OAuth profiles without an email', () => {
    it.each(['google', 'apple', 'facebook'] as const)(
      'rejects %s before any database create or update',
      async (provider) => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await callSignIn({
          user: { id: `${provider}-profile-id`, email: null, name: 'No Email' },
          account: { provider, type: 'oauth', providerAccountId: `${provider}-account-id` },
        });

        expect(result).toBe('/auth/error?error=OAuthEmailRequired');
        expect(mockDbUpdate).not.toHaveBeenCalled();
        expect(mockDbSelect).not.toHaveBeenCalled();
        expect(mockAdapterCreateUser).not.toHaveBeenCalled();
        expect(mockAdapterUpdateUser).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toEqual({
          event: 'oauth_sign_in_rejected',
          provider,
          error_code: 'OAuthEmailRequired',
        });

        warnSpy.mockRestore();
      },
    );

    it.each([undefined, '', '   '])('also rejects a non-usable email value (%s)', async (email) => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await callSignIn({
        user: { id: 'google-profile-id', email, name: 'No Email' },
        account: { provider: 'google', type: 'oauth', providerAccountId: 'google-account-id' },
      });

      expect(result).toBe('/auth/error?error=OAuthEmailRequired');
      expect(mockDbUpdate).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('allow-lists provider names before writing structured telemetry', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await callSignIn({
        user: { id: 'unknown-profile-id', email: null },
        account: {
          provider: 'attacker@example.com',
          type: 'oauth',
          providerAccountId: 'identifier-that-must-not-be-logged',
        },
      });

      const telemetry = String(warnSpy.mock.calls[0]?.[0]);
      expect(JSON.parse(telemetry)).toEqual({
        event: 'oauth_sign_in_rejected',
        provider: 'unknown',
        error_code: 'OAuthEmailRequired',
      });
      expect(telemetry).not.toContain('attacker@example.com');
      expect(telemetry).not.toContain('identifier-that-must-not-be-logged');
      expect(telemetry).not.toContain('unknown-profile-id');

      warnSpy.mockRestore();
    });

    it.each(['google', 'apple', 'facebook'] as const)(
      'keeps an existing linked %s account working when the raw provider profile omits email',
      async (provider) => {
        const result = await callSignIn({
          // NextAuth resolves a linked account before signIn and supplies the
          // stored user here; the raw provider profile may omit email later.
          user: { id: 'linked-user', email: 'stored@example.com', name: 'Linked' },
          account: { provider, type: 'oauth', providerAccountId: `${provider}-linked-id` },
          profile: { sub: `${provider}-profile-id` },
        });

        expect(result).toBe(true);
        expect(mockDbUpdate).toHaveBeenCalledTimes(1);
        expect(mockDbSet).toHaveBeenCalledWith({ emailVerified: expect.any(Date) });
      },
    );
  });

  describe('OAuth provider (google)', () => {
    it('marks email as verified for new user and returns true', async () => {
      const result = await callSignIn({
        user: { id: 'user-1', email: 'user@example.com', name: 'Test' },
        account: { provider: 'google', type: 'oauth', providerAccountId: 'g-123' },
      });

      expect(result).toBe(true);
      expect(mockDbUpdate).toHaveBeenCalledTimes(1);
      expect(mockDbSet).toHaveBeenCalledWith({ emailVerified: expect.any(Date) });
    });

    it('skips DB update when user has no id', async () => {
      const result = await callSignIn({
        user: { id: '', email: 'user@example.com', name: 'Test', emailVerified: null },
        account: { provider: 'google', type: 'oauth', providerAccountId: 'g-456' },
      });

      expect(result).toBe(true);
      expect(mockDbUpdate).not.toHaveBeenCalled();
    });

    it('returns true even when DB update throws (best-effort)', async () => {
      mockDbUpdateWhere.mockRejectedValue(new Error('DB exploded'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await callSignIn({
        user: { id: 'user-1', email: 'user@example.com' },
        account: { provider: 'google', type: 'oauth', providerAccountId: 'g-789' },
      });

      expect(result).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith('Failed to mark email as verified during OAuth sign-in:', expect.any(Error));
      warnSpy.mockRestore();
    });

    it('includes isNull condition so already-verified emails are not re-updated', async () => {
      const { isNull } = await import('drizzle-orm');

      await callSignIn({
        user: { id: 'user-1', email: 'user@example.com' },
        account: { provider: 'google', type: 'oauth', providerAccountId: 'g-101' },
      });

      expect(isNull).toHaveBeenCalledWith('users.emailVerified');
    });
  });

  describe('OAuth provider (apple)', () => {
    it('marks email as verified and returns true', async () => {
      const result = await callSignIn({
        user: { id: 'user-2', email: 'apple@example.com' },
        account: { provider: 'apple', type: 'oauth', providerAccountId: 'a-123' },
      });

      expect(result).toBe(true);
      expect(mockDbUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe('OAuth provider (facebook)', () => {
    it('marks email as verified and returns true', async () => {
      const result = await callSignIn({
        user: { id: 'user-3', email: 'fb@example.com' },
        account: { provider: 'facebook', type: 'oauth', providerAccountId: 'fb-123' },
      });

      expect(result).toBe(true);
      expect(mockDbUpdate).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // native-oauth path (transfer token)
  // -------------------------------------------------------------------------

  describe('native-oauth provider', () => {
    it('returns true without any DB operations', async () => {
      const result = await callSignIn({
        user: { id: 'user-1', email: 'user@example.com' },
        account: { provider: 'native-oauth', type: 'credentials', providerAccountId: 'no-123' },
      });

      expect(result).toBe(true);
      expect(mockDbUpdate).not.toHaveBeenCalled();
      expect(mockDbSelect).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // credentials (email/password) path
  // -------------------------------------------------------------------------

  describe('credentials provider', () => {
    it('returns false when user has no email', async () => {
      const result = await callSignIn({
        user: { id: 'user-1' },
        account: { provider: 'credentials', type: 'credentials', providerAccountId: 'cred-123' },
      });

      expect(result).toBe(false);
    });

    it('returns true when email verification is disabled (default)', async () => {
      // EMAIL_VERIFICATION_ENABLED not set → disabled
      mockDbLimit.mockResolvedValue([{ id: 'user-1', email: 'user@example.com', emailVerified: null }]);

      const result = await callSignIn({
        user: { id: 'user-1', email: 'user@example.com' },
        account: { provider: 'credentials', type: 'credentials', providerAccountId: 'cred-123' },
      });

      expect(result).toBe(true);
    });

    it('returns true when email verification enabled and email is verified', async () => {
      vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'true');
      mockDbLimit.mockResolvedValue([{ id: 'user-1', email: 'user@example.com', emailVerified: new Date() }]);

      const result = await callSignIn({
        user: { id: 'user-1', email: 'user@example.com' },
        account: { provider: 'credentials', type: 'credentials', providerAccountId: 'cred-123' },
      });

      expect(result).toBe(true);
    });

    it('returns redirect URL when email verification enabled and email is not verified', async () => {
      vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'true');
      mockDbLimit.mockResolvedValue([{ id: 'user-1', email: 'user@example.com', emailVerified: null }]);

      const result = await callSignIn({
        user: { id: 'user-1', email: 'user@example.com' },
        account: { provider: 'credentials', type: 'credentials', providerAccountId: 'cred-123' },
      });

      expect(result).toBe('/auth/verify-request?error=EmailNotVerified');
    });

    it('returns true when email verification enabled but user not found in DB', async () => {
      vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'true');
      mockDbLimit.mockResolvedValue([]); // user not found

      const result = await callSignIn({
        user: { id: 'user-1', email: 'user@example.com' },
        account: { provider: 'credentials', type: 'credentials', providerAccountId: 'cred-123' },
      });

      // No existingUser[0] — condition is skipped → allow sign in
      expect(result).toBe(true);
    });

    it('returns true when EMAIL_VERIFICATION_ENABLED is not "true" (e.g. "false")', async () => {
      vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'false');
      mockDbLimit.mockResolvedValue([{ id: 'user-1', email: 'user@example.com', emailVerified: null }]);

      const result = await callSignIn({
        user: { id: 'user-1', email: 'user@example.com' },
        account: { provider: 'credentials', type: 'credentials', providerAccountId: 'cred-123' },
      });

      expect(result).toBe(true);
    });
  });
});

// =============================================================================
// session callback — issue #3304: display name must not stay stuck at the
// sign-in-time JWT value after a Settings edit
// =============================================================================

type SessionParams = Parameters<NonNullable<NonNullable<typeof authOptions.callbacks>['session']>>[0];
type SessionResult = Session;

async function callSession(params: Partial<SessionParams>): Promise<SessionResult> {
  const cb = authOptions.callbacks?.session;
  if (!cb) throw new Error('session callback not defined');
  return (await cb(params as SessionParams)) as SessionResult;
}

describe('authOptions.callbacks.session', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default DB chain: select().from().where().limit() resolves to empty
    mockDbSelect.mockReturnValue({ from: mockDbFrom });
    mockDbFrom.mockReturnValue({ where: mockDbWhere });
    mockDbWhere.mockReturnValue({ limit: mockDbLimit });
    mockDbLimit.mockResolvedValue([]);
  });

  // The session callback now reads the avatar/display name off the JWT (the
  // `jwt` callback keeps them fresh), so it must NOT query the DB — that's the
  // whole point of the perf change. Assert that below, and drive the display
  // fields from token claims here.
  it('overrides session.user.name with the JWT-cached displayName without hitting the DB', async () => {
    const result = await callSession({
      session: { user: { id: 'user-1', name: 'speedywalker8392', email: 'user@example.com' }, expires: '2099-01-01' },
      token: { sub: 'user-1', profileDisplayName: 'jojo' },
    });

    expect(result.user?.name).toBe('jojo');
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('leaves session.user.name unchanged when the JWT has no cached displayName', async () => {
    const result = await callSession({
      session: { user: { id: 'user-1', name: 'speedywalker8392' }, expires: '2099-01-01' },
      token: { sub: 'user-1' },
    });

    expect(result.user?.name).toBe('speedywalker8392');
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('leaves session.user.name unchanged when the cached displayName is null', async () => {
    const result = await callSession({
      session: { user: { id: 'user-1', name: 'speedywalker8392' }, expires: '2099-01-01' },
      token: { sub: 'user-1', profileAvatarUrl: 'https://cdn.example.com/avatar.jpg', profileDisplayName: null },
    });

    expect(result.user?.name).toBe('speedywalker8392');
  });

  it('leaves session.user.name unchanged when the cached displayName is an empty string (clearing does not live-revert to the auto-generated handle)', async () => {
    const result = await callSession({
      session: { user: { id: 'user-1', name: 'speedywalker8392' }, expires: '2099-01-01' },
      token: { sub: 'user-1', profileAvatarUrl: null, profileDisplayName: '' },
    });

    expect(result.user?.name).toBe('speedywalker8392');
  });

  it('overrides session.user.image with the JWT-cached avatarUrl when present (regression guard)', async () => {
    const result = await callSession({
      session: { user: { id: 'user-1', name: 'speedywalker8392', image: 'old.png' }, expires: '2099-01-01' },
      token: { sub: 'user-1', profileAvatarUrl: 'https://cdn.example.com/avatar.jpg' },
    });

    expect(result.user?.image).toBe('https://cdn.example.com/avatar.jpg');
  });

  it('sets session.user.id from token.sub', async () => {
    const result = await callSession({
      session: { user: { id: 'user-99', name: 'speedywalker8392' }, expires: '2099-01-01' },
      token: { sub: 'user-42' },
    });

    expect(result.user?.id).toBe('user-42');
  });

  it('exposes the stable login generation from the JWT', async () => {
    const result = await callSession({
      session: {
        user: { id: 'user-1', name: 'speedywalker8392' },
        authSessionId: 'old-login',
        expires: '2099-01-01',
      },
      token: { sub: 'user-1', authSessionId: 'login-generation-1' },
    });

    expect(result.authSessionId).toBe('login-generation-1');
  });
});

type JwtParams = Parameters<NonNullable<NonNullable<typeof authOptions.callbacks>['jwt']>>[0];

async function callJwt(params: Partial<JwtParams>) {
  const callback = authOptions.callbacks?.jwt;
  if (!callback) throw new Error('jwt callback not defined');
  return callback(params as JwtParams);
}

describe('authOptions.callbacks.jwt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default DB chain: select().from().where().limit() resolves to empty so the
    // profile-claim refresh below doesn't throw when a test doesn't care about it.
    mockDbSelect.mockReturnValue({ from: mockDbFrom });
    mockDbFrom.mockReturnValue({ where: mockDbWhere });
    mockDbWhere.mockReturnValue({ limit: mockDbLimit });
    mockDbLimit.mockResolvedValue([]);
  });

  it('preserves an existing login generation through cookie refreshes', async () => {
    const result = await callJwt({ token: { sub: 'user-1', authSessionId: 'login-generation-1' } });

    expect(result.authSessionId).toBe('login-generation-1');
  });

  it('seeds preexisting JWTs from their standard jti', async () => {
    const result = await callJwt({ token: { sub: 'user-1', jti: 'existing-jti' } });

    expect(result.authSessionId).toBe('existing-jti');
  });

  it('creates a login generation when the JWT has no prior identifier', async () => {
    const result = await callJwt({ token: { sub: 'user-1' } });

    expect(result.authSessionId).toEqual(expect.any(String));
    expect(result.authSessionId).not.toBe('');
  });

  // Profile-claim caching (the perf change): the jwt callback fetches
  // avatar/display name and stamps them on the token so the session callback
  // reads them for free.
  it('caches userProfiles avatar/displayName onto the token on a first (uncached) read', async () => {
    mockDbLimit.mockResolvedValue([{ avatarUrl: 'https://cdn.example.com/a.jpg', displayName: 'jojo' }]);

    const result = await callJwt({ token: { sub: 'user-1' } });

    expect(mockDbSelect).toHaveBeenCalledTimes(1);
    expect(result.profileAvatarUrl).toBe('https://cdn.example.com/a.jpg');
    expect(result.profileDisplayName).toBe('jojo');
    expect(result.profileClaimsRefreshedAt).toEqual(expect.any(Number));
  });

  it('caches null claims (not undefined) at sign-in when the new user has no profile row yet', async () => {
    // events.createUser inserts an empty userProfiles row for OAuth users, but a
    // brand-new credentials user can reach the jwt callback before any row
    // exists — the query returns []. Cache null so the session callback falls
    // back to the provider-supplied name/image instead of re-querying forever.
    mockDbLimit.mockResolvedValue([]);

    const result = await callJwt({ token: { sub: 'new-user' }, user: { id: 'new-user', email: 'new@example.com' } });

    expect(mockDbSelect).toHaveBeenCalledTimes(1);
    expect(result.profileAvatarUrl).toBeNull();
    expect(result.profileDisplayName).toBeNull();
    expect(result.profileClaimsRefreshedAt).toEqual(expect.any(Number));
  });

  it('does NOT re-query the DB when the cached claims are still within the TTL', async () => {
    const result = await callJwt({
      token: {
        sub: 'user-1',
        authSessionId: 'login-1',
        profileAvatarUrl: 'https://cdn.example.com/a.jpg',
        profileDisplayName: 'jojo',
        profileClaimsRefreshedAt: Date.now(),
      },
    });

    expect(mockDbSelect).not.toHaveBeenCalled();
    // Cached claims survive untouched.
    expect(result.profileDisplayName).toBe('jojo');
  });

  it('re-queries the DB when the cached claims have aged past the TTL', async () => {
    mockDbLimit.mockResolvedValue([{ avatarUrl: null, displayName: 'renamed' }]);

    const result = await callJwt({
      token: {
        sub: 'user-1',
        authSessionId: 'login-1',
        profileDisplayName: 'stale',
        // 6 minutes ago — past the 5-minute TTL.
        profileClaimsRefreshedAt: Date.now() - 6 * 60 * 1000,
      },
    });

    expect(mockDbSelect).toHaveBeenCalledTimes(1);
    expect(result.profileDisplayName).toBe('renamed');
    expect(result.profileAvatarUrl).toBeNull();
  });

  it('force-refreshes on an explicit session update() even when the cache is fresh', async () => {
    mockDbLimit.mockResolvedValue([{ avatarUrl: null, displayName: 'edited-just-now' }]);

    const result = await callJwt({
      token: {
        sub: 'user-1',
        authSessionId: 'login-1',
        profileDisplayName: 'old',
        profileClaimsRefreshedAt: Date.now(),
      },
      trigger: 'update',
    });

    expect(mockDbSelect).toHaveBeenCalledTimes(1);
    expect(result.profileDisplayName).toBe('edited-just-now');
  });

  it('keeps the previously cached claims when the profile refresh query throws', async () => {
    mockDbLimit.mockRejectedValue(new Error('DB exploded'));

    const result = await callJwt({
      token: {
        sub: 'user-1',
        authSessionId: 'login-1',
        profileDisplayName: 'kept',
        profileClaimsRefreshedAt: Date.now() - 6 * 60 * 1000,
      },
    });

    // Refresh failed → prior claims stand, and the token read still succeeds.
    expect(result.profileDisplayName).toBe('kept');
    expect(result.authSessionId).toBe('login-1');
  });
});

// =============================================================================
// CredentialsProvider authorize — email/password
// =============================================================================

// We need to reach into the providers array to grab the authorize function.
// authOptions.providers is typed as Provider[], but the CredentialsProvider
// object exposes an `authorize` method.

type CredentialProviderLike = {
  id?: string;
  authorize?: (credentials: Record<string, string> | undefined) => Promise<{
    id: string;
    email: string | null;
    name: string | null;
    image: string | null;
  } | null>;
};

function getEmailCredentialsProvider(): CredentialProviderLike {
  const providers = authOptions.providers as CredentialProviderLike[];
  // The email/password provider is the one without an explicit id ('credentials' is the default)
  // In the actual implementation it's the last one added and has no explicit id override.
  // We identify it by checking which authorize function queries userCredentials (password hash).
  // For test purposes, just grab the provider at the expected index.
  // providers: [native-oauth, email-password] (OAuth providers absent in test env)
  const emailProvider = providers.find((p) => p.id === undefined || p.id === 'credentials');
  if (!emailProvider) throw new Error('Could not find email credentials provider');
  return emailProvider;
}

function getNativeOAuthProvider(): CredentialProviderLike {
  const providers = authOptions.providers as CredentialProviderLike[];
  const nativeProvider = providers.find((p) => (p as { id?: string }).id === 'native-oauth');
  if (!nativeProvider) throw new Error('Could not find native-oauth provider');
  return nativeProvider;
}

describe('CredentialsProvider.authorize — email/password', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockDbSelect.mockReturnValue({ from: mockDbFrom });
    mockDbFrom.mockReturnValue({ where: mockDbWhere });
    mockDbWhere.mockReturnValue({ limit: mockDbLimit });
    mockDbLimit.mockResolvedValue([]);
  });

  it('returns null when credentials are missing', async () => {
    const provider = getEmailCredentialsProvider();
    const result = await provider.authorize?.(undefined);
    expect(result).toBeNull();
  });

  it('returns null when email is missing', async () => {
    const provider = getEmailCredentialsProvider();
    const result = await provider.authorize?.({ password: 'pass' });
    expect(result).toBeNull();
  });

  it('returns null when password is missing', async () => {
    const provider = getEmailCredentialsProvider();
    const result = await provider.authorize?.({ email: 'user@example.com' });
    expect(result).toBeNull();
  });

  it('returns null when user is not found', async () => {
    // First select (users lookup) → empty
    mockDbLimit.mockResolvedValue([]);

    const provider = getEmailCredentialsProvider();
    const result = await provider.authorize?.({ email: 'notfound@example.com', password: 'pass' });
    expect(result).toBeNull();
  });

  it('returns null when user has no password (OAuth-only account)', async () => {
    // First select (users) → user found; second select (userCredentials) → empty
    mockDbLimit
      .mockResolvedValueOnce([{ id: 'user-1', email: 'user@example.com', name: 'Test', image: null }])
      .mockResolvedValueOnce([]);

    const provider = getEmailCredentialsProvider();
    const result = await provider.authorize?.({
      email: 'user@example.com',
      password: 'mypassword',
    });
    expect(result).toBeNull();
  });

  it('returns null when password is incorrect', async () => {
    mockDbLimit
      .mockResolvedValueOnce([{ id: 'user-1', email: 'user@example.com', name: 'Test', image: null }])
      .mockResolvedValueOnce([{ userId: 'user-1', passwordHash: '$2a$12$hashed' }]);
    mockBcryptCompare.mockResolvedValue(false);

    const provider = getEmailCredentialsProvider();
    const result = await provider.authorize?.({ email: 'user@example.com', password: 'wrongpass' });
    expect(result).toBeNull();
  });

  it('returns user object when credentials are valid', async () => {
    const user = { id: 'user-1', email: 'user@example.com', name: 'Test User', image: null };
    mockDbLimit
      .mockResolvedValueOnce([user])
      .mockResolvedValueOnce([{ userId: 'user-1', passwordHash: '$2a$12$hashed' }]);
    mockBcryptCompare.mockResolvedValue(true);

    const provider = getEmailCredentialsProvider();
    const result = await provider.authorize?.({
      email: 'user@example.com',
      password: 'correctpass',
    });

    expect(result).toEqual({
      id: 'user-1',
      email: 'user@example.com',
      name: 'Test User',
      image: null,
    });
    expect(mockBcryptCompare).toHaveBeenCalledWith('correctpass', '$2a$12$hashed');
  });
});

// =============================================================================
// CredentialsProvider authorize — native-oauth (transfer token)
// =============================================================================

describe('CredentialsProvider.authorize — native-oauth', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockDbSelect.mockReturnValue({ from: mockDbFrom });
    mockDbFrom.mockReturnValue({ where: mockDbWhere });
    mockDbWhere.mockReturnValue({ limit: mockDbLimit });
    mockDbLimit.mockResolvedValue([]);
  });

  it('returns null when transferToken is missing', async () => {
    const provider = getNativeOAuthProvider();
    const result = await provider.authorize?.(undefined);
    expect(result).toBeNull();
  });

  it('returns null when transferToken is empty string', async () => {
    const provider = getNativeOAuthProvider();
    const result = await provider.authorize?.({ transferToken: '' });
    expect(result).toBeNull();
  });

  it('returns null when token verification fails', async () => {
    mockVerifyNativeOAuthTransferToken.mockReturnValue(null);

    const provider = getNativeOAuthProvider();
    const result = await provider.authorize?.({ transferToken: 'invalid.token' });
    expect(result).toBeNull();
  });

  it('returns null when user not found in DB', async () => {
    mockVerifyNativeOAuthTransferToken.mockReturnValue({ userId: 'user-99', nextPath: '/' });
    mockDbLimit.mockResolvedValue([]);

    const provider = getNativeOAuthProvider();
    const result = await provider.authorize?.({ transferToken: 'valid.token' });
    expect(result).toBeNull();
  });

  it('returns user object when token is valid and user exists', async () => {
    const user = { id: 'user-1', email: 'user@example.com', name: 'Test', image: '/img.png' };
    mockVerifyNativeOAuthTransferToken.mockReturnValue({ userId: 'user-1', nextPath: '/feed' });
    mockDbLimit.mockResolvedValue([user]);

    const provider = getNativeOAuthProvider();
    const result = await provider.authorize?.({ transferToken: 'valid.token' });

    expect(result).toEqual({
      id: 'user-1',
      email: 'user@example.com',
      name: 'Test',
      image: '/img.png',
    });
  });
});

// =============================================================================
// redirect callback — cross-subdomain sign-in/sign-out resolution
// =============================================================================

type RedirectParams = Parameters<NonNullable<NonNullable<typeof authOptions.callbacks>['redirect']>>[0];

async function callRedirect(params: RedirectParams): Promise<string> {
  const callback = authOptions.callbacks?.redirect;
  if (!callback) throw new Error('redirect callback not defined');
  return callback(params);
}

describe('authOptions.callbacks.redirect', () => {
  // NEXT_PUBLIC_APP_URL is unset in tests, so the app allow-list resolves to its
  // prod default (https://app.boardsesh.com).
  const BASE_URL = 'https://www.boardsesh.com';

  it('prefixes a relative url with baseUrl (NextAuth default)', async () => {
    expect(await callRedirect({ url: '/app', baseUrl: BASE_URL })).toBe(`${BASE_URL}/app`);
  });

  it('returns a same-origin (www) url unchanged', async () => {
    expect(await callRedirect({ url: `${BASE_URL}/app/play`, baseUrl: BASE_URL })).toBe(`${BASE_URL}/app/play`);
  });

  it('keeps a same-origin url when NEXTAUTH_URL (baseUrl) carries a trailing slash', async () => {
    // A trailing-slash NEXTAUTH_URL makes baseUrl `https://www.boardsesh.com/`,
    // which never equals `new URL(url).origin` — a literal string compare would
    // wrongly collapse this same-origin redirect to the base and strip the path.
    expect(await callRedirect({ url: `${BASE_URL}/app/play`, baseUrl: `${BASE_URL}/` })).toBe(`${BASE_URL}/app/play`);
  });

  it('allows the standalone app origin so a cross-subdomain sign-out confirms', async () => {
    const appCallback = 'https://app.boardsesh.com/app';
    expect(await callRedirect({ url: appCallback, baseUrl: BASE_URL })).toBe(appCallback);
  });

  it('allows a numbered app preview origin', async () => {
    const previewCallback = 'https://7.app.boardsesh.com/app';
    expect(await callRedirect({ url: previewCallback, baseUrl: BASE_URL })).toBe(previewCallback);
  });

  it('coerces a disallowed cross-origin url to baseUrl (open-redirect guard)', async () => {
    expect(await callRedirect({ url: 'https://evil.com/app', baseUrl: BASE_URL })).toBe(BASE_URL);
  });

  it('coerces a look-alike suffix origin to baseUrl', async () => {
    expect(await callRedirect({ url: 'https://app.boardsesh.com.evil.com/app', baseUrl: BASE_URL })).toBe(BASE_URL);
  });
});

// =============================================================================
// Shared .boardsesh.com session cookie (cross-subdomain auth)
// =============================================================================
//
// The cookie block is resolved at module load from the env, so each case stubs
// the env, resets the module registry, and re-imports authOptions to read the
// freshly-resolved cookies.

describe('authOptions.cookies — shared .boardsesh.com domain', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadCookies() {
    const { authOptions: freshOptions } = await import('../auth-options');
    return freshOptions.cookies;
  }

  it('scopes the session token to .boardsesh.com on the production www host (Lax, Secure, __Secure- prefix)', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.com');
    vi.stubEnv('AUTH_COOKIE_DOMAIN', '');
    vi.resetModules();
    const cookies = await loadCookies();

    expect(cookies?.sessionToken?.name).toBe('__Secure-next-auth.session-token');
    expect(cookies?.sessionToken?.options.domain).toBe('.boardsesh.com');
    expect(cookies?.sessionToken?.options.sameSite).toBe('lax');
    expect(cookies?.sessionToken?.options.secure).toBe(true);
    expect(cookies?.sessionToken?.options.httpOnly).toBe(true);
  });

  it('scopes the OAuth-flow cookies to the same parent domain', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.com');
    vi.stubEnv('AUTH_COOKIE_DOMAIN', '');
    vi.resetModules();
    const cookies = await loadCookies();

    expect(cookies?.callbackUrl?.options.domain).toBe('.boardsesh.com');
    expect(cookies?.state?.options.domain).toBe('.boardsesh.com');
    expect(cookies?.nonce?.options.domain).toBe('.boardsesh.com');
    expect(cookies?.pkceCodeVerifier?.options.domain).toBe('.boardsesh.com');
  });

  it('honours an AUTH_COOKIE_DOMAIN override', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    // Stubbed (not merely left ambient) so vi.unstubAllEnvs restores it after
    // applyCanonicalAuthUrl writes the canonical origin into it on import.
    vi.stubEnv('NEXTAUTH_URL', '');
    vi.stubEnv('AUTH_COOKIE_DOMAIN', '.staging.boardsesh.com');
    vi.resetModules();
    const cookies = await loadCookies();

    expect(cookies?.sessionToken?.options.domain).toBe('.staging.boardsesh.com');
    expect(cookies?.callbackUrl?.options.domain).toBe('.staging.boardsesh.com');
  });

  it('sets NO cookie domain on a Vercel preview — secure context, but not the prod host', async () => {
    // isSecureCookieContext() is true whenever VERCEL_URL is set, but a
    // `Domain=.boardsesh.com` Set-Cookie from a *.vercel.app response is
    // rejected by the browser. The domain must key on the serving host, not on
    // the secure flag, or preview logins silently never store a cookie.
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('VERCEL_URL', 'boardsesh-abc123-marcodejonghs-projects.vercel.app');
    vi.stubEnv('NEXTAUTH_URL', '');
    vi.stubEnv('AUTH_COOKIE_DOMAIN', '');
    vi.resetModules();
    const cookies = await loadCookies();

    expect(cookies?.sessionToken?.name).toBe('__Secure-next-auth.session-token');
    expect(cookies?.sessionToken?.options.secure).toBe(true);
    expect(cookies?.sessionToken?.options.domain).toBeUndefined();
    expect(cookies?.callbackUrl?.options.domain).toBeUndefined();
  });

  it('sets NO cookie domain on a homelab preview host running unmerged PR code', async () => {
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('NEXTAUTH_URL', 'https://42.preview.boardsesh.com');
    vi.stubEnv('AUTH_COOKIE_DOMAIN', '');
    vi.resetModules();
    const cookies = await loadCookies();

    // Secure context (https NEXTAUTH_URL) — but host-only, so a preview
    // login/sign-out can never write or delete the domain-wide prod cookie.
    expect(cookies?.sessionToken?.name).toBe('__Secure-next-auth.session-token');
    expect(cookies?.sessionToken?.options.domain).toBeUndefined();
  });

  it('sets NO cookie domain on localhost/dev — the cookie stays host-only', async () => {
    // Force a non-secure context: no production Vercel env, no https NEXTAUTH_URL,
    // no Vercel URL. A Domain attribute on `localhost` is invalid and would drop
    // the cookie, so it must be undefined here.
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
    vi.stubEnv('AUTH_COOKIE_DOMAIN', '');
    vi.resetModules();
    const cookies = await loadCookies();

    expect(cookies?.sessionToken?.name).toBe('next-auth.session-token');
    expect(cookies?.sessionToken?.options.domain).toBeUndefined();
    expect(cookies?.sessionToken?.options.secure).toBe(false);
    expect(cookies?.callbackUrl?.options.domain).toBeUndefined();
  });
});

// =============================================================================
// Canonical auth URL (issue #4227)
// =============================================================================

describe('auth-options module side effect — canonical NEXTAUTH_URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('rewrites a loopback NEXTAUTH_URL before the cookie config is built', async () => {
    // The production state behind #4227: NEXTAUTH_URL points at localhost, so
    // next-auth built redirect_uri=http://localhost:3000/api/auth/callback/google
    // and sessionCookieDomain() returned undefined.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('AUTH_COOKIE_DOMAIN', '');
    vi.resetModules();

    const { authOptions: freshOptions } = await import('../auth-options');

    expect(process.env.NEXTAUTH_URL).toBe('https://www.boardsesh.com');
    // …and the shared-cookie design comes back with it.
    expect(freshOptions.cookies?.sessionToken?.options.domain).toBe('.boardsesh.com');
    expect(freshOptions.cookies?.sessionToken?.name).toBe('__Secure-next-auth.session-token');
  });

  it('leaves a localhost NEXTAUTH_URL alone in local dev', async () => {
    vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('BASE_URL', '');
    vi.stubEnv('AUTH_COOKIE_DOMAIN', '');
    vi.resetModules();

    await import('../auth-options');

    expect(process.env.NEXTAUTH_URL).toBe('http://localhost:3000');
  });
});
