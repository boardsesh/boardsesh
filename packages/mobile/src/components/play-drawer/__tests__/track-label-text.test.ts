import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { formatBrowseCaption, formatTrackLabelParts, MAX_CAPTION_NAME_LENGTH } from '../track-label-text';

// Interpolates like the real catalog, so the assertions read as the top bar does.
const STRINGS: Record<string, string> = {
  'playView.track.position': '{{position}} of {{total}}',
  'playView.track.playingFromAria': 'Playing from {{name}}',
  'playView.track.playingFromPositionAria': 'Playing from {{name}}, {{position}} of {{total}}',
  'playView.wallState.previewNotLit': 'Preview, not lit',
  'playView.wallState.onlyYouSeeThis': 'Only you see this',
  'playView.wallState.onlyYouSeeThisWallOn': 'Only you see this · the wall is on {{name}}',
};
const t = ((key: string, values: Record<string, string> = {}) =>
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

describe('formatBrowseCaption', () => {
  it('says nothing when there is nothing to say', () => {
    expect(formatBrowseCaption(null, t)).toBeNull();
  });

  it('tells a solo climber the preview is not lit', () => {
    expect(formatBrowseCaption({ kind: 'preview' }, t)).toBe('Preview, not lit');
  });

  it('tells a crew the look is private, and names the climb on the wall', () => {
    expect(formatBrowseCaption({ kind: 'crew', wallClimbName: null }, t)).toBe('Only you see this');
    expect(formatBrowseCaption({ kind: 'crew', wallClimbName: '   ' }, t)).toBe('Only you see this');
    expect(formatBrowseCaption({ kind: 'crew', wallClimbName: 'Crimp Ladder' }, t)).toBe(
      'Only you see this · the wall is on Crimp Ladder',
    );
  });

  it('cuts a long wall climb name short', () => {
    const caption = formatBrowseCaption({ kind: 'crew', wallClimbName: 'Crimpladder Overhangtraverse Project' }, t);
    expect(caption).toBe('Only you see this · the wall is on Crimpladder Overhangtra\u2026');
    const printedName = caption?.slice('Only you see this · the wall is on '.length) ?? '';
    expect(Array.from(printedName)).toHaveLength(MAX_CAPTION_NAME_LENGTH);
  });

  it('drops the wall climb name under a list or a workout stage, so the short form fits the top bar', () => {
    const caption = formatBrowseCaption({ kind: 'crew', wallClimbName: 'Crimpladder Overhangtraverse Project' }, t, {
      sharesLine: true,
    });
    expect(caption).toBe('Only you see this');
  });

  it('keeps the solo preview words under a list or a workout stage', () => {
    expect(formatBrowseCaption({ kind: 'preview' }, t, { sharesLine: true })).toBe('Preview, not lit');
  });
});
