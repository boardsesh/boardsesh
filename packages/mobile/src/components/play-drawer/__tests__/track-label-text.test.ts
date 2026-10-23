import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { formatTrackLabel, MAX_TRACK_NAME_LENGTH } from '../track-label-text';

// Interpolates like the real catalog, so the assertions read as the header does.
const STRINGS: Record<string, string> = {
  'playView.track.from': 'From {{name}}',
  'playView.track.fromPosition': 'From {{name}} · {{position}} of {{total}}',
};
const t = ((key: string, values: Record<string, string>) =>
  (STRINGS[key] ?? key).replace(
    /\{\{(\w+)\}\}/g,
    (_, field: string) => values[field] ?? '',
  )) as unknown as TFunction<'session'>;

describe('formatTrackLabel', () => {
  it('says nothing for a hidden label', () => {
    expect(formatTrackLabel({ kind: 'hidden' }, t, 'en-US')).toBeNull();
  });

  it('names the list, with the count when there is one', () => {
    expect(formatTrackLabel({ kind: 'named', name: 'Projects' }, t, 'en-US')).toBe('From Projects');
    expect(formatTrackLabel({ kind: 'counted', name: 'Projects', position: 4, total: 1234 }, t, 'en-US')).toBe(
      'From Projects · 4 of 1,234',
    );
  });

  it('cuts a long name short so the count stays on the line', () => {
    const longName = 'My Winter Overhang Projects Circuit';
    const label = formatTrackLabel({ kind: 'counted', name: longName, position: 4, total: 23 }, t, 'en-US');
    expect(label).toBe('From My Winter Overhang Proj\u2026 · 4 of 23');
    const printedName = label?.slice('From '.length, label.indexOf(' · '));
    expect(Array.from(printedName ?? '')).toHaveLength(MAX_TRACK_NAME_LENGTH);
  });

  it('never splits a character in two', () => {
    const name = `${'a'.repeat(MAX_TRACK_NAME_LENGTH - 2)}\u{1F9D7}\u{1F9D7}\u{1F9D7}`;
    const label = formatTrackLabel({ kind: 'named', name }, t, 'en-US') ?? '';
    expect(label).toBe(`From ${'a'.repeat(MAX_TRACK_NAME_LENGTH - 2)}\u{1F9D7}\u2026`);
  });

  it('prints a name that fits as it is', () => {
    const name = 'b'.repeat(MAX_TRACK_NAME_LENGTH);
    expect(formatTrackLabel({ kind: 'named', name }, t, 'en-US')).toBe(`From ${name}`);
  });
});
