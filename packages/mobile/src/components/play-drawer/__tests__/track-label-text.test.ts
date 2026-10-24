import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { formatTrackLabelParts } from '../track-label-text';

// Interpolates like the real catalog, so the assertions read as the top bar does.
const STRINGS: Record<string, string> = {
  'playView.track.position': '{{position}} of {{total}}',
  'playView.track.playingFromAria': 'Playing from {{name}}',
  'playView.track.playingFromPositionAria': 'Playing from {{name}}, {{position}} of {{total}}',
};
const t = ((key: string, values: Record<string, string>) =>
  (STRINGS[key] ?? key).replace(
    /\{\{(\w+)\}\}/g,
    (_, field: string) => values[field] ?? '',
  )) as unknown as TFunction<'session'>;

describe('formatTrackLabelParts', () => {
  it('says nothing for a hidden label', () => {
    expect(formatTrackLabelParts({ kind: 'hidden' }, t, 'en-US')).toBeNull();
  });

  it('names the list with no count when the count is not known', () => {
    expect(formatTrackLabelParts({ kind: 'named', name: 'Projects' }, t, 'en-US')).toEqual({
      name: 'Projects',
      count: null,
      accessibilityLabel: 'Playing from Projects',
    });
  });

  it('keeps the count apart from the name, grouped for the language', () => {
    expect(formatTrackLabelParts({ kind: 'counted', name: 'Projects', position: 4, total: 1234 }, t, 'en-US')).toEqual({
      name: 'Projects',
      count: '4 of 1,234',
      accessibilityLabel: 'Playing from Projects, 4 of 1,234',
    });
  });

  // The layout cuts a long name; the text never does, so VoiceOver reads it
  // whole and the count is never what gets lost (#6664's "1 of 29,18…").
  it('hands a long name over whole', () => {
    const name = 'Winter crimp ladder, 40° only, no dynos please, and a 100-character name to be sure of it';
    const parts = formatTrackLabelParts({ kind: 'counted', name, position: 1, total: 29182 }, t, 'en-US');
    expect(parts?.name).toBe(name);
    expect(parts?.count).toBe('1 of 29,182');
    expect(parts?.accessibilityLabel).toBe(`Playing from ${name}, 1 of 29,182`);
  });
});
