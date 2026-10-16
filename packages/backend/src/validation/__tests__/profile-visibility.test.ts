import { describe, expect, it } from 'vite-plus/test';
import { UpdateProfileInputSchema } from '../schemas/users';

// The backend test database declares these columns as `text`, not the
// PostgreSQL enum production uses, so a wrong-cased or invented value reaches
// the write and succeeds in tests while failing on a real database. Zod is the
// only place that difference is caught, which makes these assertions the guard
// against a schema regression rather than a restatement of the type.
describe('UpdateProfileInputSchema visibility fields', () => {
  it('accepts each of the three legal choices on both columns', () => {
    for (const choice of ['public', 'anonymous', 'off'] as const) {
      expect(UpdateProfileInputSchema.safeParse({ leaderboardVisibility: choice }).success).toBe(true);
      expect(UpdateProfileInputSchema.safeParse({ gymScreenVisibility: choice }).success).toBe(true);
    }
  });

  it('rejects a wrong-cased value rather than letting it reach the column', () => {
    expect(UpdateProfileInputSchema.safeParse({ leaderboardVisibility: 'ANONYMOUS' }).success).toBe(false);
    expect(UpdateProfileInputSchema.safeParse({ gymScreenVisibility: 'Off' }).success).toBe(false);
  });

  it('rejects a value outside the set, including one that reads like an opt-out', () => {
    expect(UpdateProfileInputSchema.safeParse({ leaderboardVisibility: 'hidden' }).success).toBe(false);
    expect(UpdateProfileInputSchema.safeParse({ leaderboardVisibility: null }).success).toBe(false);
  });

  // Omission is how a client edits one setting without touching the other, so
  // it has to stay valid — the resolver writes only the keys that arrive.
  it('leaves both out without complaint', () => {
    expect(UpdateProfileInputSchema.safeParse({ displayName: 'Quiet Climber' }).success).toBe(true);
  });
});
