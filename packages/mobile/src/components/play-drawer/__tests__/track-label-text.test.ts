import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import enSession from '@boardsesh/i18n/locales/en-US/session.json';
import esSession from '@boardsesh/i18n/locales/es/session.json';
import frSession from '@boardsesh/i18n/locales/fr/session.json';
import deSession from '@boardsesh/i18n/locales/de/session.json';
import itSession from '@boardsesh/i18n/locales/it/session.json';
import {
  formatBrowseCaption,
  formatThenParts,
  formatTrackLabelParts,
  MAX_CAPTION_NAME_LENGTH,
  printedThen,
  spokenCaption,
} from '../track-label-text';

// Interpolates like the real catalog, so the assertions read as the top bar does.
const STRINGS: Record<string, string> = {
  'playView.track.position': '{{position}} of {{total}}',
  'playView.track.playingFromAria': 'Playing from {{name}}',
  'playView.track.playingFromPositionAria': 'Playing from {{name}}, {{position}} of {{total}}',
  'playView.track.upNext': 'Up next',
  'playView.track.upNextPositionAria': 'Up next, {{position}} of {{total}}',
  'playView.track.then': 'then {{name}}',
  'playView.track.upNextThenAria': 'Up next, then {{name}}',
  'playView.track.upNextPositionThenAria': 'Up next, {{position}} of {{total}}, then {{name}}',
  'playView.wallState.previewNotOnWall': 'Preview · not on the wall',
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

  // A queued climb playing in the middle of a list (#6777): the queue's name,
  // never the list's, and its place in the stretch of Up next.
  it('says Up next and where the climb sits in it', () => {
    expect(
      formatTrackLabelParts(
        { kind: 'upNext', listName: 'Search results', count: { position: 1, total: 3 }, thenListName: null },
        t,
        'en-US',
      ),
    ).toEqual({ name: 'Up next', count: '1 of 3', thenTail: null, accessibilityLabel: 'Up next, 1 of 3' });
  });

  it('says Up next alone when the stretch cannot be counted', () => {
    expect(
      formatTrackLabelParts({ kind: 'upNext', listName: null, count: null, thenListName: null }, t, 'en-US'),
    ).toEqual({
      name: 'Up next',
      count: null,
      thenTail: null,
      accessibilityLabel: 'Up next',
    });
  });

  // The then-signposts: "Up next · 2 of 4 · then Projects" while the list
  // carries on after Up next. The count and "then" are their own pieces, so
  // the layout can cut the list's name and nothing else.
  it('adds "then Projects" after the count, and says it', () => {
    expect(
      formatTrackLabelParts(
        { kind: 'upNext', listName: 'Projects', count: { position: 2, total: 4 }, thenListName: 'Projects' },
        t,
        'en-US',
      ),
    ).toEqual({
      name: 'Up next',
      count: '2 of 4',
      thenTail: { before: 'then ', name: 'Projects', after: '' },
      accessibilityLabel: 'Up next, 2 of 4, then Projects',
    });
  });

  it('says "then" with no count when the stretch cannot be counted', () => {
    const parts = formatTrackLabelParts(
      { kind: 'upNext', listName: 'Projects', count: null, thenListName: 'Projects' },
      t,
      'en-US',
    );
    expect(parts?.thenTail).toEqual({ before: 'then ', name: 'Projects', after: '' });
    expect(parts?.accessibilityLabel).toBe('Up next, then Projects');
  });

  it('never adds "then" to a list climb', () => {
    expect(
      formatTrackLabelParts({ kind: 'counted', name: 'Projects', position: 7, total: 20 }, t, 'en-US')?.thenTail,
    ).toBeUndefined();
  });
});

describe('formatThenParts', () => {
  it('splits around the name wherever the language puts it', () => {
    const suffixT = ((key: string, values: Record<string, string> = {}) =>
      key === 'playView.track.then' ? `${values.name} danach` : key) as unknown as TFunction<'session'>;
    expect(formatThenParts('Projekte', suffixT)).toEqual({ before: '', name: 'Projekte', after: ' danach' });
  });

  it('keeps the whole sentence before the name when a translation lost it', () => {
    const lostT = (() => 'then') as unknown as TFunction<'session'>;
    expect(formatThenParts('Projects', lostT)).toEqual({ before: 'then ', name: 'Projects', after: '' });
  });

  it.each([
    ['en-US', enSession],
    ['es', esSession],
    ['fr', frSession],
    ['de', deSession],
    ['it', itSession],
  ])('prints the %s catalog sentence whole, with only the name apart', (_locale, catalog) => {
    const template = catalog.playView.track.then;
    const catalogT = ((_key: string, values: Record<string, string> = {}) =>
      template.replace('{{name}}', values.name ?? '')) as unknown as TFunction<'session'>;
    const parts = formatThenParts('Projects', catalogT);
    expect(printedThen(parts)).toBe(template.replace('{{name}}', 'Projects'));
    expect(parts.before).not.toContain('Projects');
    expect(parts.name).toBe('Projects');
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

  it('tells a solo climber the preview is not on the wall', () => {
    expect(formatBrowseCaption({ kind: 'preview' }, t)).toBe('Preview · not on the wall');
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
    expect(formatBrowseCaption({ kind: 'preview' }, t, { sharesLine: true })).toBe('Preview · not on the wall');
  });
});

// The "·" is for the eye: a screen reader would say "middle dot".
describe('spokenCaption', () => {
  it('reads the separator as a comma', () => {
    expect(spokenCaption('Preview · not on the wall')).toBe('Preview, not on the wall');
    expect(spokenCaption('Only you see this · the wall is on Crimp Ladder')).toBe(
      'Only you see this, the wall is on Crimp Ladder',
    );
  });

  it('leaves a caption with no separator, and a dot inside a word, alone', () => {
    expect(spokenCaption('Only you see this')).toBe('Only you see this');
    expect(spokenCaption('Only you see this · the wall is on A·B')).toBe('Only you see this, the wall is on A·B');
  });

  it.each([
    ['en-US', enSession],
    ['es', esSession],
    ['fr', frSession],
    ['de', deSession],
    ['it', itSession],
  ])('reads the %s preview caption with no dot', (_locale, catalog) => {
    const caption = catalog.playView.wallState.previewNotOnWall;
    expect(caption).toContain(' · ');
    expect(spokenCaption(caption)).not.toContain('·');
  });

  // The then-signposts' second-line captions ride the same line and are read the same way.
  it.each([
    ['en-US', enSession],
    ['es', esSession],
    ['fr', frSession],
    ['de', deSession],
    ['it', itSession],
  ])('reads the %s signpost captions with no dot', (_locale, catalog) => {
    const {
      previewUpNextWaiting_one: noteOne,
      previewUpNextWaiting_other: noteOther,
      upNextFirst_one: one,
      upNextFirst_other: other,
    } = catalog.playView.track;
    // The note reads like the caption it stands in for: "Preview · …".
    for (const note of [noteOne, noteOther]) expect(note).toContain(' · ');
    for (const caption of [noteOne, noteOther, one, other]) expect(spokenCaption(caption)).not.toContain('·');
  });
});
