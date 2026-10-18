import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Names and the Redis channel prefix that belonged to the removed broadcast. */
const REMOVED = [
  'publishPrivacyChanged',
  'subscribePrivacy',
  'createPrivacyAwareIterator',
  'invalidateApnsPrivacy',
  'refreshApnsPrivacy',
  'boardsesh:privacy:',
];

function backendSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : backendSourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('privacy broadcast stays removed (#6406)', () => {
  // Privacy changes are not broadcast: every read is authorized when it is
  // made and live streams recheck access on each event. A new publisher, a
  // wake or the old Redis channel coming back would reintroduce the fleet-wide
  // refetch that caused #6343 and #6329.
  it('no backend source publishes, subscribes to or wakes on a privacy broadcast', () => {
    const files = backendSourceFiles(SOURCE_ROOT);
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return REMOVED.filter((name) => source.includes(name)).map((name) => `${relative(SOURCE_ROOT, file)}: ${name}`);
    });
    expect(found).toEqual([]);
  });
});
