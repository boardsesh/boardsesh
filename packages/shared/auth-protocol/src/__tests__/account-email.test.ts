import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_EMAIL_CANDIDATE_LIMIT,
  normalizeAccountEmail,
  resolveAccountEmail,
  soleAccount,
} from '../account-email';

// Synthetic fixtures only. Each row stands for what the lookup query returns.
const row = (id: string, email: string) => ({ id, email });

describe('normalizeAccountEmail', () => {
  it('trims, then lowercases, and keeps dots and plus suffixes', () => {
    expect(normalizeAccountEmail('  First.Last+Board@Example.TEST \t')).toBe('first.last+board@example.test');
  });
});

describe('resolveAccountEmail', () => {
  it('finds a mixed-case stored address typed exactly as stored', () => {
    const stored = row('a', 'Climber@Example.test');
    expect(resolveAccountEmail('Climber@Example.test', [stored])).toEqual({ kind: 'exact', rows: [stored] });
  });

  it('finds a mixed-case stored address typed in lowercase', () => {
    const stored = row('a', 'Climber@Example.test');
    expect(resolveAccountEmail('climber@example.test', [stored])).toEqual({ kind: 'normalized', rows: [stored] });
  });

  it('finds a lowercase stored address typed in capitals or with spaces', () => {
    const stored = row('a', 'climber@example.test');
    expect(resolveAccountEmail('  CLIMBER@EXAMPLE.TEST ', [stored]).kind).toBe('normalized');
  });

  it('prefers the exact row over a sibling in other capitals', () => {
    const exact = row('a', 'Shared@Example.test');
    const sibling = row('b', 'shared@example.test');
    expect(resolveAccountEmail('Shared@Example.test', [exact, sibling])).toEqual({ kind: 'exact', rows: [exact] });
    expect(resolveAccountEmail('shared@example.test', [exact, sibling])).toEqual({ kind: 'exact', rows: [sibling] });
  });

  it('refuses a typed form that no row stores exactly when several rows share it', () => {
    const rows = [row('a', 'Shared@Example.test'), row('b', 'shared@example.test')];
    expect(resolveAccountEmail('SHARED@EXAMPLE.TEST', rows)).toEqual({ kind: 'ambiguous', rows: [] });
  });

  it('returns every row storing the exact same text and leaves the choice to the caller', () => {
    const rows = [row('a', 'twin@example.test'), row('b', 'twin@example.test')];
    const resolution = resolveAccountEmail('twin@example.test', rows);
    expect(resolution).toEqual({ kind: 'exact', rows });
    expect(soleAccount(resolution)).toBeNull();
  });

  it('refuses more rows than the candidate limit, even with an exact one among them', () => {
    const rows = Array.from({ length: ACCOUNT_EMAIL_CANDIDATE_LIMIT + 1 }, (_unused, index) =>
      row(`id-${index}`, index === 0 ? 'many@example.test' : 'MANY@example.test'),
    );
    expect(resolveAccountEmail('many@example.test', rows).kind).toBe('ambiguous');
  });

  it('answers none when nothing matched', () => {
    expect(resolveAccountEmail('nobody@example.test', [])).toEqual({ kind: 'none', rows: [] });
  });

  it('treats a row the query found but the rule does not recognise as ambiguous, never as a match', () => {
    // SQL lower() and JavaScript toLowerCase() can disagree outside ASCII.
    expect(resolveAccountEmail('climber@example.test', [row('a', 'other@example.test')]).kind).toBe('ambiguous');
  });
});

describe('soleAccount', () => {
  it('names the one exact or one normalized row and nothing else', () => {
    const stored = row('a', 'Climber@Example.test');
    expect(soleAccount(resolveAccountEmail('Climber@Example.test', [stored]))).toBe(stored);
    expect(soleAccount(resolveAccountEmail('climber@example.test', [stored]))).toBe(stored);
    expect(soleAccount(resolveAccountEmail('x@example.test', []))).toBeNull();
    expect(
      soleAccount(resolveAccountEmail('X@EXAMPLE.TEST', [row('a', 'x@example.test'), row('b', 'X@example.test')])),
    ).toBeNull();
  });
});
