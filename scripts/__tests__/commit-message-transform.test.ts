import { describe, it, expect } from 'vitest';
import {
  parseConventional,
  validateCommitSubject,
  isSkippedSubject,
  MAX_SUBJECT_LENGTH,
} from '../lib/commit-message-transform';

describe('parseConventional', () => {
  it('parses type, scope, breaking marker, and description', () => {
    expect(parseConventional('feat(mobile): add changelog screen')).toEqual({
      type: 'feat',
      scope: 'mobile',
      breaking: false,
      description: 'add changelog screen',
    });
    expect(parseConventional('fix: stop the drift')).toEqual({
      type: 'fix',
      scope: null,
      breaking: false,
      description: 'stop the drift',
    });
    expect(parseConventional('feat(web)!: drop the legacy route')).toEqual({
      type: 'feat',
      scope: 'web',
      breaking: true,
      description: 'drop the legacy route',
    });
  });

  it('returns null for subjects that are not type: description shaped', () => {
    expect(parseConventional('just a plain subject')).toBeNull();
    expect(parseConventional('feat add a thing')).toBeNull();
    expect(parseConventional('feat():no space')).toBeNull();
  });
});

describe('isSkippedSubject', () => {
  it('skips merge, revert, and autosquash subjects', () => {
    expect(isSkippedSubject('Merge pull request #1 from x/y')).toBe(true);
    expect(isSkippedSubject('Revert "feat(mobile): thing"')).toBe(true);
    expect(isSkippedSubject('fixup! feat(mobile): thing')).toBe(true);
    expect(isSkippedSubject('squash! fix: thing')).toBe(true);
  });

  it('does not skip ordinary commits', () => {
    expect(isSkippedSubject('feat(mobile): thing')).toBe(false);
  });
});

describe('validateCommitSubject', () => {
  it('accepts valid types with and without a scope', () => {
    expect(validateCommitSubject('feat(mobile): add screen').ok).toBe(true);
    expect(validateCommitSubject('chore: bump deps').ok).toBe(true);
    expect(validateCommitSubject('refactor(backend): tidy resolver').ok).toBe(true);
  });

  it('accepts a breaking-change marker', () => {
    const result = validateCommitSubject('feat(web)!: drop legacy route');
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown type', () => {
    const result = validateCommitSubject('feet(mobile): typo type');
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('Unknown type'))).toBe(true);
  });

  it('rejects an unknown scope but allows no scope', () => {
    expect(validateCommitSubject('fix(nonsense): thing').ok).toBe(false);
    expect(validateCommitSubject('fix: thing').ok).toBe(true);
  });

  it('rejects a non-conventional subject', () => {
    const result = validateCommitSubject('just did some stuff');
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('Conventional Commit'))).toBe(true);
  });

  it('rejects an empty subject', () => {
    expect(validateCommitSubject('   ').ok).toBe(false);
  });

  it('enforces the max subject length', () => {
    const longDescription = 'x'.repeat(MAX_SUBJECT_LENGTH);
    const result = validateCommitSubject(`feat(mobile): ${longDescription}`);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('under'))).toBe(true);
  });

  it('treats skipped subjects (merge/revert/autosquash) as valid', () => {
    expect(validateCommitSubject('Merge branch main').ok).toBe(true);
    expect(validateCommitSubject('Revert "feat: x"').ok).toBe(true);
    expect(validateCommitSubject('fixup! feat(mobile): x').ok).toBe(true);
  });
});
