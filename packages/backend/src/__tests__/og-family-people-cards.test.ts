import { describe, expect, it } from 'vitest';
import { renderOgFamilyTextLayers } from '@boardsesh/board-render/og-family';
import {
  PROFILE_FALLBACK_NAME,
  RECAP_FALLBACK_NAME,
  SETTER_FALLBACK_NAME,
  buildGradeBars,
  buildProfileCardContent,
  buildRecapCardContent,
  buildSetterArt,
  buildSetterCardContent,
  compactCount,
  describeBoards,
  digestCard,
  effectiveHardestDifficulty,
  monogramLetter,
  recapLine,
  recapNameLine,
  resolveCardGrade,
  type ProfileStatsForCard,
} from '../services/og-family/card-model';
import type { SessionRecapRead } from '../services/og-family/session-recap';

const FONT = 'Noto Sans';
const stats: ProfileStatsForCard = {
  totalDistinctClimbs: 46,
  layoutStats: [
    {
      boardType: 'kilter',
      distinctClimbCount: 46,
      gradeCounts: [
        { grade: '20', count: 3 },
        { grade: '22', count: 5 },
      ],
    },
  ],
};
const hardest = {
  climbName: 'Maybe?',
  boardType: 'kilter',
  difficulty: 26 as number | null,
  consensusDifficulty: 27 as number | null,
  frames: 'p1r12',
  renderBoard: null,
};

const recap: SessionRecapRead = {
  sends: 2,
  flashes: 1,
  attempts: 0,
  capped: false,
  gradeRows: [{ difficulty: 22, flashes: 1, sends: 1 }],
  featured: {
    status: 'flash',
    climberName: 'Zara',
    climbName: 'Half Mast',
    boardType: 'kilter',
    angle: 40,
    difficulty: 22,
    frames: 'p1r12',
    renderBoard: null,
  },
  participants: [{ name: 'Zara', sends: 2 }],
  durationMinutes: 49,
};

describe('resolveCardGrade', () => {
  it('formats font/V from the difficulty id', () => {
    expect(resolveCardGrade('kilter', 27)?.label).toBe('7c+/V10');
    expect(resolveCardGrade('kilter', null)).toBeNull();
    expect(resolveCardGrade('kilter', 999)).toBeNull();
  });
});

describe('effectiveHardestDifficulty', () => {
  it('prefers the logged grade and rounds consensus when it falls back', () => {
    expect(effectiveHardestDifficulty({ difficulty: 22, consensusDifficulty: 28 })).toBe(22);
    expect(effectiveHardestDifficulty({ difficulty: null, consensusDifficulty: 25.5 })).toBe(26);
    expect(effectiveHardestDifficulty({ difficulty: null, consensusDifficulty: null })).toBeNull();
  });
});

describe('monogramLetter', () => {
  it('takes the first grapheme of any script, uppercased', () => {
    expect(monogramLetter('reuben')).toBe('R');
    expect(monogramLetter('иван')).toBe('И');
    expect(monogramLetter('田中')).toBe('田');
  });
  it('keeps a combined emoji whole', () => {
    expect(monogramLetter('🧗‍♀️ Zara')).toBe('🧗‍♀️');
  });
});

describe('compactCount', () => {
  it('keeps exact numbers under 100k and compacts above', () => {
    expect(compactCount(999)).toBe('999');
    expect(compactCount(23_559)).toBe('23,559');
    expect(compactCount(227_004)).toBe('227K');
    expect(compactCount(1_136_595)).toBe('1.1M');
    expect(compactCount(12_000_000)).toBe('12M');
  });

  it('rolls over to millions instead of printing 1000K', () => {
    expect(compactCount(999_499)).toBe('999K');
    expect(compactCount(999_500)).toBe('1M');
    expect(compactCount(999_999)).toBe('1M');
    expect(compactCount(1_000_000)).toBe('1M');
  });
});

describe('describeBoards', () => {
  it('names up to two boards and counts the rest', () => {
    expect(describeBoards(['kilter'])).toBe('Kilter');
    expect(describeBoards(['kilter', 'tension'])).toBe('Kilter and Tension');
    expect(describeBoards(['kilter', 'tension', 'moonboard'])).toBe('3 boards');
    expect(describeBoards(['kilter', 'kilter'])).toBe('Kilter');
  });
});

describe('profile card content', () => {
  it('leads with the logged grade, in its colour', () => {
    const content = buildProfileCardContent({
      displayName: 'jed',
      avatar: null,
      hardest,
      stats,
      art: null,
      fontFamily: FONT,
    });

    expect(content.hero.runs[0]).toEqual({ text: '7c/V9', color: expect.any(String) });
    expect(content.hero.wrap).toBe(false);
    expect(content.rows.map((row) => row.runs[0].text)).toEqual(['Maybe?', 'Hardest of 46 climbs sent on Kilter']);
  });

  it('falls back to consensus only without a logged grade', () => {
    const content = buildProfileCardContent({
      displayName: 'jed',
      avatar: null,
      hardest: { ...hardest, difficulty: null },
      stats,
      art: null,
      fontFamily: FONT,
    });

    expect(content.hero.runs[0].text).toBe('7c+/V10');
  });

  it('calls an unnamed climber Climber and draws no monogram for that word', () => {
    const content = buildProfileCardContent({
      displayName: null,
      avatar: null,
      hardest,
      stats,
      art: null,
      fontFamily: FONT,
    });

    expect(content.identity?.name).toBe(PROFILE_FALLBACK_NAME);
    expect(content.identity?.avatar).toBeNull();
  });

  it('says one send logged for a single-send logbook', () => {
    const content = buildProfileCardContent({
      displayName: 'Line',
      avatar: null,
      hardest,
      stats: { ...stats, totalDistinctClimbs: 1 },
      art: null,
      fontFamily: FONT,
    });

    expect(content.rows.at(-1)?.runs[0].text).toBe('One send logged · Kilter');
  });

  it('says no sends logged yet in the hero', () => {
    const content = buildProfileCardContent({
      displayName: 'Ivan',
      avatar: null,
      hardest: null,
      stats: { totalDistinctClimbs: 0, layoutStats: [] },
      art: null,
      fontFamily: FONT,
    });

    expect(content.hero.runs[0].text).toBe('No sends logged yet');
  });

  it('keeps the count and bars when every send is on a hidden climb', () => {
    const content = buildProfileCardContent({
      displayName: 'Ivan',
      avatar: null,
      hardest: null,
      stats: { ...stats, totalDistinctClimbs: 12 },
      art: null,
      fontFamily: FONT,
    });

    expect(content.hero.runs[0].text).toBe('12 climbs sent');
    expect(content.bars?.length).toBeGreaterThan(0);
  });
});

describe('buildGradeBars', () => {
  it('fills the axis from easiest to hardest, empty grades included', () => {
    expect(buildGradeBars(stats).map((bar) => bar.value)).toEqual([3, 0, 5]);
  });
});

describe('digestCard', () => {
  it('keys on the picture digest, never the raw bytes', () => {
    const content = buildProfileCardContent({
      displayName: 'jed',
      avatar: { png: Buffer.from([1]), digest: 'abc' },
      hardest,
      stats,
      art: null,
      fontFamily: FONT,
    });
    const sameBytesNewDigest = {
      ...content,
      identity: {
        ...content.identity!,
        avatar: { kind: 'image' as const, png: Buffer.from([1]), digest: 'xyz' },
      },
    };

    expect(digestCard(null, content)).not.toBe(digestCard(null, sameBytesNewDigest));
    expect(digestCard(null, content)).toBe(digestCard(null, content));
  });
});

describe('setter card content', () => {
  const base = {
    username: 'KilterStudio',
    linkedDisplayName: null,
    avatar: null,
    hasLinkedAvatar: false,
    climbCount: 391,
    boardTypes: ['kilter'],
    topClimb: {
      uuid: 'bell',
      name: 'Bell of the Wall',
      boardType: 'kilter',
      layoutId: 1,
      frames: 'p1r12',
      ascensionist_count: 100_139,
      compatibleSizeIds: null,
      requiredSetIds: null,
    },
    art: null,
    fontFamily: FONT,
  };

  it('leads with compact sends, unit beside it, and names the climb count', () => {
    const content = buildSetterCardContent({ ...base, totalAscents: 1_136_595 });

    expect(content.hero.runs.map((run) => run.text).join('')).toBe('1.1M sends');
    expect(content.rows.map((row) => row.runs[0].text)).toEqual([
      'on 391 climbs they set',
      'Most sent: Bell of the Wall',
    ]);
  });

  it('takes the climb count as the hero under ten sends', () => {
    const content = buildSetterCardContent({ ...base, climbCount: 4, totalAscents: 9 });

    expect(content.hero.runs.map((run) => run.text).join('')).toBe('4 climbs');
    expect(content.rows[0].runs[0].text).toBe('set on Kilter');
  });

  it('crosses over exactly at ten sends', () => {
    expect(buildSetterCardContent({ ...base, climbCount: 4, totalAscents: 10 }).hero.runs[0].text).toBe('10');
  });

  it('does not claim a climb is most sent with no sends on it', () => {
    const content = buildSetterCardContent({
      ...base,
      climbCount: 1,
      totalAscents: 0,
      topClimb: { ...base.topClimb, ascensionist_count: 0 },
    });

    expect(content.rows.map((row) => row.runs[0].text).join('\n')).not.toContain('Most sent');
  });

  it('prefers the linked account name over the Aurora username', () => {
    const content = buildSetterCardContent({ ...base, linkedDisplayName: 'Real Name', totalAscents: 50 });

    expect(content.identity?.name).toBe('Real Name');
  });

  it('draws the monogram when the linked avatar will not load, and nothing for no linked avatar', () => {
    expect(buildSetterCardContent({ ...base, hasLinkedAvatar: true, totalAscents: 50 }).identity?.avatar).toMatchObject(
      { kind: 'monogram', letter: 'K' },
    );
    expect(buildSetterCardContent({ ...base, hasLinkedAvatar: false, totalAscents: 50 }).identity?.avatar).toBeNull();
  });

  it.each([
    ['a whitespace-only username', '   ', null, SETTER_FALLBACK_NAME],
    ['a username of only invisible characters', '\u200B\u200B', '', SETTER_FALLBACK_NAME],
    ['a blank linked name over a real username', 'KilterStudio', '   ', 'KilterStudio'],
  ])('renders through the real text path for %s', async (_label, username, linkedDisplayName, expected) => {
    const content = buildSetterCardContent({ ...base, username, linkedDisplayName, totalAscents: 100 });

    expect(content.identity?.name).toBe(expected);
    await expect(renderOgFamilyTextLayers(content)).resolves.toBeDefined();
  });

  it('never lights a climb it cannot draw', () => {
    expect(buildSetterArt({ ...base.topClimb, boardType: 'spray', layoutId: 1 })).toBeNull();
    expect(buildSetterArt(null)).toBeNull();
  });
});

describe('recap card content', () => {
  it('writes the plain sentence for each shape of session', () => {
    expect(recapLine({ sends: 17, flashes: 17, capped: false })).toBe('17 sends, all flashed');
    expect(recapLine({ sends: 3, flashes: 2, capped: false })).toBe('3 sends, 2 flashed');
    expect(recapLine({ sends: 2, flashes: 0, capped: false })).toBe('2 sends');
    expect(recapLine({ sends: 1, flashes: 1, capped: false })).toBe('Flashed it');
    expect(recapLine({ sends: 1, flashes: 0, capped: false })).toBe('1 send');
    expect(recapLine({ sends: 0, flashes: 0, capped: false })).toBe('Still projecting');
    expect(recapLine({ sends: 1000, flashes: 900, capped: true })).toBe('1,000+ sends logged');
  });

  it('names the sole climber, or A climber when unknown', () => {
    expect(recapNameLine([{ name: 'Zara', sends: 2 }])).toBe('Zara');
    expect(recapNameLine([{ name: null, sends: 2 }])).toBe(RECAP_FALLBACK_NAME);
    expect(recapNameLine([])).toBe(RECAP_FALLBACK_NAME);
  });

  it('counts a crew honestly, named or masked', () => {
    expect(
      recapNameLine([
        { name: 'Zara', sends: 2 },
        { name: null, sends: 1 },
        { name: 'Sam', sends: 1 },
      ]),
    ).toBe('Zara + 2 others');
    expect(
      recapNameLine([
        { name: 'Zara', sends: 2 },
        { name: 'Sam', sends: 1 },
      ]),
    ).toBe('Zara + 1 other');
    expect(
      recapNameLine([
        { name: null, sends: 2 },
        { name: null, sends: 1 },
      ]),
    ).toBe('2 climbers');
  });

  it('draws flashes filled and sends hollow, hardest first, and keeps the true total', () => {
    const content = buildRecapCardContent({ recap, art: null, fontFamily: FONT });

    expect(content.dots?.total).toBe(2);
    expect(content.dots?.dots.map((dot) => dot.filled)).toEqual([true, false]);
  });

  it('keeps an ungraded send hollow and an ungraded flash filled', () => {
    const content = buildRecapCardContent({
      recap: { ...recap, sends: 2, flashes: 1, gradeRows: [], featured: { ...recap.featured!, difficulty: null } },
      art: null,
      fontFamily: FONT,
    });

    expect(content.dots?.dots.map((dot) => dot.filled)).toEqual([true, false]);
  });

  it('draws an ungraded non-flash send hollow when every send is a plain send', () => {
    const content = buildRecapCardContent({
      recap: { ...recap, sends: 1, flashes: 0, gradeRows: [], featured: { ...recap.featured!, difficulty: null } },
      art: null,
      fontFamily: FONT,
    });

    expect(content.dots?.dots.map((dot) => dot.filled)).toEqual([false]);
  });

  it('draws a card with no featured climb when every send was on a hidden climb', async () => {
    const content = buildRecapCardContent({
      recap: { ...recap, featured: null, gradeRows: [] },
      art: null,
      fontFamily: FONT,
    });

    expect(content.aside).toBeUndefined();
    await expect(renderOgFamilyTextLayers(content)).resolves.toBeDefined();
  });

  it('never claims a dot beyond the list it kept', () => {
    const big: SessionRecapRead = {
      ...recap,
      sends: 200,
      flashes: 100,
      gradeRows: [{ difficulty: 22, flashes: 100, sends: 100 }],
    };
    const content = buildRecapCardContent({ recap: big, art: null, fontFamily: FONT });

    expect(content.dots?.total).toBe(200);
    expect(content.dots?.dots.length).toBeLessThanOrEqual(60);
  });

  it('credits the climb and, in a crew session, its climber', () => {
    const solo = buildRecapCardContent({
      recap,
      art: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', frames: 'p1r12' },
      fontFamily: FONT,
    });
    expect(solo.aside).toEqual({
      eyebrow: 'HARDEST SEND',
      title: 'Half Mast',
      lines: ['Flashed', 'Kilter at 40°', '49 min session'],
    });

    const crew = buildRecapCardContent({
      recap: {
        ...recap,
        participants: [
          { name: 'Zara', sends: 2 },
          { name: 'Sam', sends: 1 },
        ],
      },
      art: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', frames: 'p1r12' },
      fontFamily: FONT,
    });
    expect(crew.aside?.lines[0]).toBe('Flashed by Zara');
  });

  it('never names a credit it was not given', () => {
    const crew = buildRecapCardContent({
      recap: {
        ...recap,
        featured: { ...recap.featured!, climberName: null },
        participants: [
          { name: 'Zara', sends: 2 },
          { name: 'Sam', sends: 1 },
        ],
      },
      art: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', frames: 'p1r12' },
      fontFamily: FONT,
    });

    expect(crew.aside?.lines[0]).toBe('Flashed');
  });

  it('makes the sentence the hero when no grade resolves', () => {
    const content = buildRecapCardContent({
      recap: { ...recap, featured: { ...recap.featured!, difficulty: null } },
      art: null,
      fontFamily: FONT,
    });

    expect(content.hero.runs[0].text).toBe('2 sends, 1 flashed');
    expect(content.rows).toEqual([]);
  });
});
