// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, expect, it } from 'vitest';
import { pickBestGroupEntry, sumGroupTries, type GroupableEntry } from '../group-units';

const entry = (overrides: Partial<GroupableEntry> & { uuid: string }): GroupableEntry => ({
  status: 'attempt',
  climbedAt: '2026-06-20T10:00:00',
  attemptCount: 1,
  ...overrides,
});

describe('pickBestGroupEntry', () => {
  it('ranks flash over send over attempt regardless of order', () => {
    const items = [
      entry({ uuid: 'a', status: 'attempt', climbedAt: '2026-06-20T12:00:00' }),
      entry({ uuid: 's', status: 'send', climbedAt: '2026-06-20T11:00:00' }),
      entry({ uuid: 'f', status: 'flash', climbedAt: '2026-06-20T10:00:00' }),
    ];
    expect(pickBestGroupEntry(items).uuid).toBe('f');
    expect(pickBestGroupEntry([...items].reverse()).uuid).toBe('f');
  });

  it('breaks status ties by the latest entry', () => {
    const items = [
      entry({ uuid: 'early', status: 'send', climbedAt: '2026-06-20T09:00:00' }),
      entry({ uuid: 'late', status: 'send', climbedAt: '2026-06-20T18:30:00' }),
    ];
    expect(pickBestGroupEntry(items).uuid).toBe('late');
  });

  it('throws on an empty group (a group always has entries by construction)', () => {
    expect(() => pickBestGroupEntry([])).toThrow();
  });
});

describe('sumGroupTries', () => {
  it('sums tries across the day, flooring imported zeros at 1', () => {
    const items = [
      entry({ uuid: 'a', attemptCount: 3 }),
      entry({ uuid: 'b', attemptCount: 0 }), // imported zero → counts as 1
      entry({ uuid: 'c', attemptCount: 4 }),
    ];
    expect(sumGroupTries(items)).toBe(8);
  });
});

describe('pickBestGroupEntry tie-breaks', () => {
  it('prefers the LATEST entry when status and grade-richness tie', () => {
    const morningSend = { uuid: 'am', status: 'send' as const, climbedAt: '2026-06-15 09:00:00', attemptCount: 2 };
    const eveningSend = { uuid: 'pm', status: 'send' as const, climbedAt: '2026-06-15 18:00:00', attemptCount: 1 };
    // Robust to input order: newest-first and oldest-first both pick the evening send.
    expect(pickBestGroupEntry([eveningSend, morningSend]).uuid).toBe('pm');
    expect(pickBestGroupEntry([morningSend, eveningSend]).uuid).toBe('pm');
  });
});
