// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, expect, it } from 'vitest';

import { parseAuroraExportJson } from '../aurora-import';

void describe('parseAuroraExportJson', () => {
  it('does not warn for generic layout names on matching board imports', () => {
    const parsed = parseAuroraExportJson(
      {
        user: { username: 'setter' },
        climbs: [{ name: 'Warmup', layout: 'Original Layout' }],
      },
      'tension',
    );

    expect(parsed.boardMismatchLayoutName).toBeUndefined();
  });

  it('warns when the export layout clearly belongs to another board', () => {
    const parsed = parseAuroraExportJson(
      {
        user: { username: 'setter' },
        climbs: [{ name: 'Warmup', layout: 'Kilter Board Original' }],
      },
      'tension',
    );

    expect(parsed.boardMismatchLayoutName).toBe('Kilter Board Original');
  });

  // #3301: merged-shape attempts (is_ascent=false) still sit in `ascents`, so
  // the preview must count them as attempts, not sends. The data passthrough is
  // untouched — the server does the authoritative reclassification.
  it('counts is_ascent=false records in the preview as attempts, not sends', () => {
    const parsed = parseAuroraExportJson(
      {
        user: { username: 'setter' },
        ascents: [
          { climb: 'A', angle: 40, count: 1, stars: 3, climbed_at: 't', created_at: 't', grade: '7a' },
          { climb: 'B', angle: 40, count: 4, climbed_at: 't', created_at: 't', is_ascent: false },
        ],
        attempts: [{ climb: 'C', angle: 40, count: 2, climbed_at: 't', created_at: 't' }],
      },
      'tension',
    );

    expect(parsed.preview.ascents).toBe(1);
    expect(parsed.preview.attempts).toBe(2);
    // Data is passed through untouched — both records still live in `ascents`.
    expect(parsed.data.ascents).toHaveLength(2);
    expect(parsed.data.attempts).toHaveLength(1);
  });

  it('counts a pure legacy Kilter export unchanged', () => {
    const parsed = parseAuroraExportJson(
      {
        user: { username: 'setter' },
        ascents: [{ climb: 'A', angle: 40, count: 1, stars: 3, climbed_at: 't', created_at: 't', grade: '7a' }],
        attempts: [{ climb: 'C', angle: 40, count: 2, climbed_at: 't', created_at: 't' }],
      },
      'kilter',
    );

    expect(parsed.preview.ascents).toBe(1);
    expect(parsed.preview.attempts).toBe(1);
  });
});
