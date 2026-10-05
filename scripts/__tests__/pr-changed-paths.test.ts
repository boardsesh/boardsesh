import { describe, expect, it } from 'vitest';
import { parseChangedPaths } from '../lib/pr-changed-paths';

describe('parseChangedPaths', () => {
  it('reads one path per line', () => {
    expect(parseChangedPaths('docs/a.md\npackages/shared/offline-sync/src/db/migrations.ts\n')).toEqual([
      'docs/a.md',
      'packages/shared/offline-sync/src/db/migrations.ts',
    ]);
  });

  it('drops blank lines and surrounding whitespace, and tolerates CRLF', () => {
    expect(parseChangedPaths('  docs/a.md  \r\n\r\n\tdocs/b.md\r\n')).toEqual(['docs/a.md', 'docs/b.md']);
  });

  it('keeps a path with spaces in it whole', () => {
    expect(parseChangedPaths('docs/my file.md\n')).toEqual(['docs/my file.md']);
  });

  it('reads an empty or missing listing as no paths', () => {
    expect(parseChangedPaths('')).toEqual([]);
    expect(parseChangedPaths('\n\n')).toEqual([]);
    expect(parseChangedPaths(undefined)).toEqual([]);
  });
});
