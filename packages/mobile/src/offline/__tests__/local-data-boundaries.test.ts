import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// #6545: the sign-out wipes and the owner-stamp wipe are the only boundaries that
// remove downloaded data. A safe delete of downloaded rows has to go through one
// of these helpers (each bumps a purge epoch or is the wipe itself), so every
// caller is listed here with the reason it may run. A new caller fails this test
// until someone writes down why it is not a credential, privacy, reconnect or
// foreground cull: the pass this replaced (a root component that purged on a new
// token) would have shown up as one.
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const SCANNED = ['packages/mobile/src', 'packages/mobile/app', 'packages/shared/offline-sync/src'];
// `wipePreviousAccountLocalData` wraps the owner-stamp wipe (#6563), so a new
// caller of the wrapper (on a token refresh, say) has to show up here too.
const PURGE_CALL =
  /\b(beginGlobalPurge|beginScopePurge|setSigningOut|clearUserData|purgeLocalDataForSignOut|removeBoardScopeData|wipePreviousAccountLocalData)\(/g;

const EXPECTED: Record<string, number> = {
  // The owner-stamp wipe's one caller: rows stamped for another account.
  'packages/mobile/src/components/offline-sync-bridge.tsx': 1,
  // The two wipes' definitions.
  'packages/mobile/src/db/connection.ts': 2,
  // The owner-stamp wipe: its definition, plus beginGlobalPurge + clearUserData.
  'packages/mobile/src/offline/account-boundary.ts': 3,
  // The climber removes a board (scope purge + teardown) or taps Compact (global epoch).
  'packages/mobile/src/offline/remove-offline-board.ts': 3,
  // Sign-out: setSigningOut on/off around the explicit purge or the selective wipe.
  'packages/mobile/src/providers/auth-provider.tsx': 4,
  // The epoch helpers' definitions.
  'packages/shared/offline-sync/src/mutation-queue/drainer.ts': 3,
  // A spray wall the server retired: its scopes are purged before the rows go.
  'packages/shared/offline-sync/src/sync/pull-client.ts': 1,
  // removeBoardScopeData's definition.
  'packages/shared/offline-sync/src/sync/scope-teardown.ts': 1,
};

function countPurgeCalls(source: string): number {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('*') && !line.startsWith('//') && !line.startsWith('/*'))
    .reduce((total, line) => total + (line.match(PURGE_CALL)?.length ?? 0), 0);
}

function inventory(directory: string, found: Record<string, number> = {}): Record<string, number> {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') inventory(path, found);
    } else if (/\.tsx?$/.test(entry)) {
      const calls = countPurgeCalls(readFileSync(path, 'utf8'));
      if (calls > 0) found[relative(REPO_ROOT, path)] = calls;
    }
  }
  return found;
}

describe('local-data boundaries', () => {
  it('lists every caller that can purge or wipe downloaded data', () => {
    const found = {};
    for (const directory of SCANNED) inventory(join(REPO_ROOT, directory), found);
    expect(found).toEqual(EXPECTED);
  });

  it('counts a purge on a credential signal and ignores one in a comment', () => {
    const stray = 'subscribeToCredentialChanges(() => beginGlobalPurge());\n// beginGlobalPurge() in prose\n';
    expect(countPurgeCalls(stray)).toBe(1);
  });
});
