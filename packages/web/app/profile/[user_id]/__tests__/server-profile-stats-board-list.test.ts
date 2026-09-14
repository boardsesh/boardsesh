// The SSR prefetch and the client hook must fan their per-board `userTicks`
// requests out over the SAME list of boards.
//
// They did not: `server-profile-stats.ts` read the board-PICKER list while
// `use-profile-data.ts` reads `BOARD_TYPES`, so a board the picker does not
// offer (spray always, MoonBoard whenever its flag is off) was absent from the
// server payload and then fetched on the client — first paint missing those
// ascents, and the lifetime totals jumping on hydration.
//
// Asserted by reading the two modules rather than by rendering: the fan-out is a
// list, and the bug is the two lists disagreeing.

import { describe, expect, it } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD_TYPES } from '@boardsesh/profile-stats';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { SUPPORTED_BOARDS as PICKER_BOARDS } from '@boardsesh/board-config';

const PROFILE_DIR = join(import.meta.dirname, '..');
const serverSource = readFileSync(join(PROFILE_DIR, 'server-profile-stats.ts'), 'utf-8');
const clientSource = readFileSync(join(PROFILE_DIR, 'hooks', 'use-profile-data.ts'), 'utf-8');

describe('the profile tick fan-out', () => {
  it('uses the same board list on the server as on the client', () => {
    expect(serverSource).toContain('BOARD_TYPES.map((boardType) => ticksFn(userId, boardType))');
    expect(clientSource).toContain('BOARD_TYPES.map(');
  });

  it('never fans out over the board-picker list', () => {
    // `@/app/lib/board-data`'s SUPPORTED_BOARDS is the picker list. Importing it
    // here is the bug, whatever it is then called.
    expect(serverSource).not.toContain("from '@/app/lib/board-data'");
  });

  it('covers boards the picker deliberately withholds', () => {
    const missingFromPicker = [...SUPPORTED_BOARDS].filter((boardName) => !PICKER_BOARDS.includes(boardName));
    expect(missingFromPicker).toContain('spray');
    for (const boardName of missingFromPicker) {
      expect(BOARD_TYPES, boardName).toContain(boardName);
    }
  });
});
