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
});
