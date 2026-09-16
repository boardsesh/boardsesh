// Every React surface that reads the spray registry must also subscribe to it.
//
// `getBoardRenderData` answers `null` for a wall this session has not got, and a
// component that gates on that answer returns BEFORE it mounts anything holding
// a registry subscription. So when the wall lands, `notify()` has nothing to
// re-render: the component's props have not moved, its `useMemo` holds, and it
// sits on a placeholder for the rest of the session.
//
// `useSprayWallToken` is the fix — one call above the memo, which both requests
// the wall and subscribes to it. This guard exists because the failure is
// invisible in review: the code reads correctly, and on the eight catalogue
// boards it behaves correctly too. It only breaks on a board type that did not
// exist when the surface was written.
//
// Adding a new board surface? Call the hook. Genuinely exempt? Add it below with
// the reason, not a bare path.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_ROOTS = [join(__dirname, '..'), join(__dirname, '..', '..', 'app')];

/**
 * Modules that read `getBoardRenderData` and legitimately do not call
 * `useSprayWallToken`, each with the reason it cannot be the bug above.
 */
const EXEMPT: Record<string, string> = {
  'src/lib/board-details.ts': 'Defines it. Already folds `sprayCacheToken` into its own memo key.',
  'src/lib/background-image-cache.ts': 'Not React. Called from the render hook, which subscribes for it.',
  'src/lib/create-board-holds.ts': 'Not React. Calls `ensureSprayWallLoaded` itself and keys its memo on the token.',
  'src/lib/playlists/playlist-climb-render-board.ts':
    'Not React. Calls `ensureSprayWallLoaded` itself and keys its memo on the token.',
  'src/hooks/use-native-climb-render.ts':
    'Subscribes with its own `useSyncExternalStore` over `sprayCacheToken` — the hook would be a second one.',
  'src/providers/bluetooth-provider.tsx': 'LED control. A spray wall has no LEDs, so no wall reaches it.',
  'src/components/ble/DeviceCard.tsx': 'LED control. A spray wall has no LEDs, so no wall reaches it.',
};

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === '.expo') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

/**
 * An IMPORT of `getBoardRenderData`, not a mention of it. Half the modules that
 * name it only do so in a comment pointing at the contract, and those cannot
 * read the registry at all.
 */
const IMPORTS_RENDER_DATA = /import\s*\{[^}]*\bgetBoardRenderData\b[^}]*\}\s*from/;

function repoRelative(absolutePath: string): string {
  return absolutePath.slice(absolutePath.indexOf('/packages/mobile/') + '/packages/mobile/'.length);
}

describe('spray render surfaces', () => {
  it('subscribe to the registry wherever they read it synchronously', () => {
    const offenders: string[] = [];

    for (const root of SOURCE_ROOTS) {
      for (const file of walk(root)) {
        const source = readFileSync(file, 'utf8');
        if (!IMPORTS_RENDER_DATA.test(source)) continue;

        const relative = repoRelative(file);
        if (relative in EXEMPT) continue;
        if (source.includes('useSprayWallToken')) continue;

        offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the exemption list honest', () => {
    // An exemption for a file that no longer reads the registry is an exemption
    // that will silently cover the next module moved to that path.
    const stale = Object.keys(EXEMPT).filter((relative) => {
      const source = readFileSync(join(__dirname, '..', '..', relative), 'utf8');
      return !IMPORTS_RENDER_DATA.test(source) && !relative.endsWith('board-details.ts');
    });

    expect(stale).toEqual([]);
  });
});
