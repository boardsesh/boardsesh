// A username and a password go over the wire here, so the board type has to be
// an Aurora board before anything is constructed.
//
// `HOST_BASES` / `API_HOSTS` / `WEB_HOSTS` are `Record<AuroraBoardName, string>`.
// A code-driven board type indexes them to `undefined`, and
// `AuroraClimbingClient` builds `this.baseURL = \`${HOST_BASES[boardName]}.com\``
// — i.e. `undefined.com`, a real registered domain — then POSTs the submitted
// credentials to `https://undefined.com/sessions`.
//
// This predates `spray`: `moonboard` and `woods` have been accepted by
// `BoardNameSchema` since they joined `SUPPORTED_BOARDS`, and neither has a
// `HOST_BASES` row. All three are closed by the same two guards — the
// Aurora-only Zod enum at the edge, and `assertAuroraBoard` in the service for
// anything that reaches it another way.

import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';

process.env.AURORA_CREDENTIALS_SECRET = process.env.AURORA_CREDENTIALS_SECRET ?? 'test-aurora-secret';

/** Counts CONSTRUCTIONS, not just calls: building the client is what resolves the host. */
const clientConstructed = vi.fn();
const signInMock = vi.fn();

vi.mock('@boardsesh/aurora-sync/api', async (importOriginal) => ({
  // The guard under test comes from the real module — mocking it would test the
  // mock. Only the client is replaced, so "was it constructed?" stays meaningful.
  ...(await importOriginal<typeof import('@boardsesh/aurora-sync/api')>()),
  AuroraClimbingClient: class {
    constructor(options: unknown) {
      clientConstructed(options);
    }
    signIn = signInMock;
  },
  isAuroraRequestError: () => false,
}));

const { saveAuroraCredential } = await import('../services/aurora-credentials');
const { SaveAuroraCredentialInputSchema, AuroraBoardNameSchema } = await import('../validation/schemas');

/** Every board that has no Aurora account behind it. */
const NON_AURORA_BOARDS = ['spray', 'woods', 'moonboard'];

beforeEach(() => {
  clientConstructed.mockClear();
  signInMock.mockClear();
});

describe('SaveAuroraCredentialInputSchema', () => {
  it.each(NON_AURORA_BOARDS)('rejects boardType "%s" at the edge', (boardType) => {
    const parsed = SaveAuroraCredentialInputSchema.safeParse({
      boardType,
      username: 'climber@example.com',
      password: 'hunter2',
    });
    expect(parsed.success).toBe(false);
  });

  it('still accepts a real Aurora board', () => {
    const parsed = SaveAuroraCredentialInputSchema.safeParse({
      boardType: 'tension',
      username: 'climber@example.com',
      password: 'hunter2',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts every Aurora board and nothing else', () => {
    expect(AuroraBoardNameSchema.safeParse('soill').success).toBe(true);
    expect(AuroraBoardNameSchema.safeParse('spray').success).toBe(false);
  });
});

describe('saveAuroraCredential', () => {
  it.each(NON_AURORA_BOARDS)('refuses "%s" without constructing the client', async (boardType) => {
    await expect(
      saveAuroraCredential({
        userId: 'guard-test-user',
        // The cast is the bug this guards: every caller reaches the service
        // through one, so the parameter type is a claim rather than a check.
        boardType: boardType as 'tension',
        username: 'climber@example.com',
        password: 'hunter2',
      }),
    ).rejects.toThrow(/not an Aurora board/);

    // The whole point: no client, so no host resolution and no request.
    expect(clientConstructed).not.toHaveBeenCalled();
    expect(signInMock).not.toHaveBeenCalled();
  });
});
