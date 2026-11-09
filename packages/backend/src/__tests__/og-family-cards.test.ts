import { describe, expect, it } from 'vitest';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { getDefaultRenderBoard } from '@boardsesh/board-config';
import { buildBoardRenderByteCacheKey, buildOgFamilyByteKey, buildOgFamilyPlaneKey } from '../services/board-render';
import {
  JOIN_FALLBACK_NAME,
  buildGradeBand,
  buildJoinCardContent,
  buildPlaylistArt,
  buildPlaylistCardContent,
  digestDrawnData,
  pickInviteName,
  resolveSessionBoard,
} from '../services/og-family/card-model';

const heroText = (content: { hero: { runs: readonly { text: string }[] } }) =>
  content.hero.runs.map((run) => run.text).join('');
const allText = (content: {
  hero: { runs: readonly { text: string }[] };
  rows: readonly { runs: readonly { text: string }[] }[];
}) => [heroText(content), ...content.rows.map((row) => row.runs.map((run) => run.text).join(''))].join('\n');

describe('playlist art', () => {
  it('lights the first climb on the dominant layout, and only that climb', () => {
    const art = buildPlaylistArt('kilter', [
      { layoutId: 8, frames: 'p3000r12' },
      { layoutId: 1, frames: 'p1r12p2r13' },
      { layoutId: 1, frames: 'p9r12' },
    ]);

    expect(art?.layoutId).toBe(1);
    expect(art?.frames).toBe('p1r12p2r13');
  });

  it('keeps a climb whole, however many holds it uses', () => {
    const frames = Array.from({ length: 120 }, (_unused, index) => `p${1000 + index}r12`).join('');

    expect(buildPlaylistArt('kilter', [{ layoutId: 1, frames }])?.frames).toBe(frames);
  });

  it('flattens a multi-frame climb so a hold it clears still shows', () => {
    const frames = buildPlaylistArt('kilter', [{ layoutId: 1, frames: 'p1r12p2r13,p3r14' }])?.frames;

    expect(frames?.match(/p\d+/g)).toEqual(['p1', 'p2', 'p3']);
  });

  it('skips a climb with no frames', () => {
    expect(
      buildPlaylistArt('kilter', [
        { layoutId: 1, frames: null },
        { layoutId: 1, frames: 'p5r12' },
      ])?.frames,
    ).toBe('p5r12');
  });

  it('has no art with no drawable climb', () => {
    expect(buildPlaylistArt('kilter', [])).toBeNull();
    expect(buildPlaylistArt('kilter', [{ layoutId: null, frames: 'p1r12' }])).toBeNull();
  });

  it('never draws a spray wall through the catalogue path', () => {
    expect(buildPlaylistArt('spray', [{ layoutId: 90001, frames: 'p501r1' }])).toBeNull();
  });
});

describe('default render boards', () => {
  it('resolves a default config for every board in the catalogue', () => {
    for (const board of SUPPORTED_BOARDS) {
      // A spray wall has no default: its identity IS its layout.
      if (board === 'spray') continue;
      const config = getDefaultRenderBoard(board, null);
      expect(config, board).not.toBeNull();
      expect(config?.setIds.length, board).toBeGreaterThan(0);
    }
  });
});

describe('grade band', () => {
  it('spans two grades as coloured runs', () => {
    const band = buildGradeBand('kilter', { p10Difficulty: 21, p90Difficulty: 26 });

    expect(band?.heroRuns.map((run) => run.text)).toEqual(['V5', '–', 'V9']);
    expect(band?.fontRuns.map((run) => run.text)).toEqual(['6c+', ' to ', '7c']);
  });

  it('collapses a band on one V grade to that grade', () => {
    expect(buildGradeBand('kilter', { p10Difficulty: 20, p90Difficulty: 21 })?.heroRuns.map((run) => run.text)).toEqual(
      ['V5'],
    );
  });

  it('uses the MoonBoard grade table on a MoonBoard list', () => {
    expect(
      buildGradeBand('moonboard', { p10Difficulty: 16, p90Difficulty: 16 })?.heroRuns.map((run) => run.text),
    ).toEqual(['V2']);
  });

  it('is absent for no summary, or a difficulty outside the table', () => {
    expect(buildGradeBand('kilter', null)).toBeNull();
    expect(buildGradeBand('kilter', { p10Difficulty: 1, p90Difficulty: 2 })).toBeNull();
  });
});

describe('playlist card content', () => {
  const art = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', frames: 'p1r12' };
  const base = {
    name: 'Benchmarks',
    boardName: 'kilter',
    climbCount: 117,
    art,
    fontFamily: 'Noto Sans',
  };

  it('puts the band in the hero and the count below it', () => {
    const content = buildPlaylistCardContent({ ...base, summary: { p10Difficulty: 21, p90Difficulty: 26 } });

    expect(heroText(content)).toBe('V5–V9');
    expect(allText(content)).toContain('117 climbs');
    expect(allText(content)).toContain('Benchmarks');
    expect(allText(content)).toContain('Kilter playlist');
  });

  it('sets the Font band directly under the hero at 40px or more', () => {
    const content = buildPlaylistCardContent({ ...base, summary: { p10Difficulty: 21, p90Difficulty: 26 } });
    const [fontBand] = content.rows;

    expect(fontBand.runs.map((run) => run.text).join('')).toBe('6c+ to 7c');
    // Pango renders at 96 dpi, so a point is 96/72 pixels.
    expect((fontBand.sizePt * 96) / 72).toBeGreaterThanOrEqual(40);
  });

  it('gives the hero to the count, in white, with no grades', () => {
    const content = buildPlaylistCardContent({ ...base, summary: null });

    expect(heroText(content)).toBe('117');
    expect(content.hero.wrap).toBe(false);
  });

  it('never writes a stale "now" claim', () => {
    const content = buildPlaylistCardContent({ ...base, summary: { p10Difficulty: 21, p90Difficulty: 26 } });

    expect(allText(content).toLowerCase()).not.toMatch(/on the wall now|climbing now/);
  });

  it('never puts the creator on the card', () => {
    const content = buildPlaylistCardContent({ ...base, name: 'Benchmarks', summary: null });

    expect(allText(content)).not.toMatch(/creator|by\s/i);
  });

  it('loses the art column when there is no board', () => {
    expect(buildPlaylistCardContent({ ...base, art: null, summary: null }).slot).toBe('none');
  });
});

describe('invite card content', () => {
  it('names the crew when nobody is nameable', () => {
    expect(pickInviteName([{ userId: null, username: '', isLeader: true }])).toBeNull();
    const content = buildJoinCardContent({ name: null, board: null, art: null, fontFamily: 'Noto Sans' });

    expect(heroText(content).replace('\n', ' ')).toBe(`Join ${JOIN_FALLBACK_NAME}`);
  });

  it('prefers the leader, skipping anyone the roster masked', () => {
    expect(
      pickInviteName([
        { userId: null, username: '', isLeader: false },
        { userId: 'first', username: 'Morgan', isLeader: false },
        { userId: 'leader', username: 'Alex', isLeader: true },
      ]),
    ).toBe('Alex');
  });

  it('uses a roster name when no leader is nameable', () => {
    expect(
      pickInviteName([
        { userId: null, username: '', isLeader: true },
        { userId: 'first', username: 'Morgan', isLeader: false },
      ]),
    ).toBe('Morgan');
  });

  it('takes the narrow slot with art and the centred one without', () => {
    const board = { config: { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,20' }, angle: 40 };
    const withArt = buildJoinCardContent({
      name: 'Alex',
      board,
      art: { ...board.config, frames: '' },
      fontFamily: 'Noto Sans',
    });
    const withoutArt = buildJoinCardContent({ name: 'Alex', board: null, art: null, fontFamily: 'Noto Sans' });

    expect(withArt.slot).toBe('narrow');
    expect(withoutArt.slot).toBe('none');
  });

  it('keeps the hero floor above the board line', () => {
    const board = { config: { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,20' }, angle: 40 };
    const content = buildJoinCardContent({
      name: 'A',
      board,
      art: { ...board.config, frames: '' },
      fontFamily: 'Noto Sans',
    });

    expect(content.hero.minPt).toBeGreaterThan(content.rows[0].sizePt);
  });

  it('draws a board line and JOIN pill with no "climbing now" claim', () => {
    const board = { config: { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,20' }, angle: 40 };
    const content = buildJoinCardContent({
      name: 'Alex',
      board,
      art: { ...board.config, frames: '' },
      fontFamily: 'Noto Sans',
    });

    expect(heroText(content).replace('\n', ' ')).toBe('Join Alex');
    expect(content.pill?.text).toBe('JOIN');
    expect(allText(content)).toContain('Kilter at 40°');
    expect(allText(content).toLowerCase()).not.toMatch(/on the wall now|climbing now/);
  });
});

describe('session board path', () => {
  const named = { boardType: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13', angle: 35 };

  it('parses the /b/<slug> form against the looked-up board, taking the angle from the path', () => {
    expect(resolveSessionBoard('/b/some-board/40', named)).toEqual({
      config: { boardName: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13' },
      angle: 40,
    });
  });

  it('falls back to the board angle for a bare /b/<slug>', () => {
    expect(resolveSessionBoard('/b/some-board', named)?.angle).toBe(35);
  });

  it('answers no board for a /b/<slug> it cannot resolve', () => {
    expect(resolveSessionBoard('/b/some-board', null)).toBeNull();
  });

  it('parses the geometry form, with or without a leading slash', () => {
    for (const path of ['/kilter/1/10/1,20/30', 'kilter/1/10/1,20/30']) {
      expect(resolveSessionBoard(path, null)).toEqual({
        config: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' },
        angle: 30,
      });
    }
  });

  it('treats an empty or unparseable path as no board', () => {
    expect(resolveSessionBoard('', null)).toBeNull();
  });
});

describe('cache keys', () => {
  it('namespaces a family byte key so it cannot collide with a climb card key', () => {
    const climbKey = buildBoardRenderByteCacheKey({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      frames: 'p1r12',
      format: 'jpeg',
      thumbnail: false,
      includeBackground: true,
      dimBackground: 0,
      isOgVariant: true,
    });

    expect(buildOgFamilyByteKey('playlist', 'digest')).not.toBe(climbKey);
    expect(buildOgFamilyByteKey('playlist', 'digest')).toMatch(/^og-family:/);
    expect(climbKey).not.toMatch(/^og-family/);
  });

  it('keys a family plane apart from the climb :og base key', () => {
    const paths = ['images/kilter/product_sizes_layouts_sets/36-1.webp'];
    const planeKey = buildOgFamilyPlaneKey(paths, 500, 602);
    const climbBaseKey = `${paths.join('|')}:500x602:og`;

    expect(planeKey).not.toBe(climbBaseKey);
    expect(planeKey).toMatch(/^og-family-plane:/);
  });

  it('changes when anything drawn changes', () => {
    const base = { art: null, summary: { p10Difficulty: 18, p90Difficulty: 20 } };
    expect(digestDrawnData(base)).not.toBe(
      digestDrawnData({ ...base, summary: { p10Difficulty: 18, p90Difficulty: 21 } }),
    );
  });
});
