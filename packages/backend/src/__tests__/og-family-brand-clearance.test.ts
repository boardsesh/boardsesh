import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  OG_FAMILY_ICON_SIZE,
  ogFamilyArtBounds,
  renderOgFamilyTextLayers,
  type OgFamilyCardContent,
} from '@boardsesh/board-render/og-family';
import { buildOgClimbCardContent } from '@boardsesh/board-render/og-card';
import {
  buildJoinCardContent,
  buildPlaylistCardContent,
  buildProfileCardContent,
  buildRecapCardContent,
  buildSetterCardContent,
  type BoardConfig,
} from '../services/og-family/card-model';
import {
  buildBoardCardContent,
  buildGymCardContent,
  buildSprayCardContent,
} from '../services/og-family/place-card-model';

/**
 * The app icon and the BOARDSESH wordmark sit in the bottom-right corner of every
 * family card. These cards are built by the real content builders at their most
 * crowded, so a builder that grows a row, a bar or an aside into that corner fails
 * here instead of on a link somebody pasted.
 */

type Rect = { left: number; top: number; width: number; height: number };

const FONT = 'Noto Sans';
const kilter: BoardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' };
const kilterArt = { ...kilter, frames: 'p1r12' };
const LONG = 'A really very long name somebody typed on their phone at the crag one evening';

const overlaps = (first: Rect, second: Rect) =>
  first.left < second.left + second.width &&
  second.left < first.left + first.width &&
  first.top < second.top + second.height &&
  second.top < first.top + first.height;

const cards: [string, OgFamilyCardContent][] = [
  [
    'playlist with a long name',
    buildPlaylistCardContent({
      name: LONG,
      boardName: 'kilter',
      climbCount: 1_117,
      summary: { p10Difficulty: 21, p90Difficulty: 26 },
      art: kilterArt,
      fontFamily: FONT,
    }),
  ],
  [
    'join with a long name',
    buildJoinCardContent({ name: LONG, board: { config: kilter, angle: 40 }, art: kilterArt, fontFamily: FONT }),
  ],
  [
    'profile with grade bars',
    buildProfileCardContent({
      displayName: 'jed kinross',
      avatar: null,
      hardest: {
        climbName: LONG,
        boardType: 'kilter',
        difficulty: 26,
        consensusDifficulty: 27,
        frames: 'p1r12',
        renderBoard: null,
      },
      stats: {
        totalDistinctClimbs: 4_612,
        layoutStats: [
          {
            boardType: 'kilter',
            distinctClimbCount: 4_612,
            gradeCounts: Array.from({ length: 18 }, (_unused, index) => ({ grade: String(10 + index), count: index })),
          },
        ],
      },
      art: kilterArt,
      fontFamily: FONT,
    }),
  ],
  [
    'setter with long lines',
    buildSetterCardContent({
      username: LONG,
      linkedDisplayName: null,
      avatar: null,
      hasLinkedAvatar: true,
      climbCount: 391,
      boardTypes: ['kilter', 'tension', 'moonboard'],
      totalAscents: 1_136_595,
      topClimb: {
        uuid: 'bell',
        name: LONG,
        boardType: 'kilter',
        layoutId: 1,
        frames: 'p1r12',
        ascensionist_count: 100_139,
        compatibleSizeIds: null,
        requiredSetIds: null,
      },
      art: kilterArt,
      fontFamily: FONT,
    }),
  ],
  [
    'recap with dots and an aside',
    buildRecapCardContent({
      recap: {
        sends: 212,
        flashes: 117,
        attempts: 412,
        capped: false,
        gradeRows: [{ difficulty: 22, flashes: 117, sends: 95 }],
        featured: {
          status: 'flash',
          climberName: LONG,
          climbName: LONG,
          boardType: 'kilter',
          angle: 40,
          difficulty: 22,
          frames: 'p1r12',
          renderBoard: null,
        },
        participants: [
          { name: LONG, sends: 120 },
          { name: 'Zara', sends: 92 },
        ],
        durationMinutes: 249,
      },
      art: kilterArt,
      fontFamily: FONT,
    }),
  ],
  [
    'gym with boards',
    buildGymCardContent({
      gym: {
        name: LONG,
        boardTypes: ['kilter', 'tension', 'moonboard'],
        boardSummaries: [
          { boardType: 'kilter', angle: 40 },
          { boardType: 'tension', angle: 40 },
          { boardType: 'moonboard', angle: 40 },
        ],
      },
      hasArt: true,
      fontFamily: FONT,
    }),
  ],
  [
    'gym with no boards, centred with no art',
    buildGymCardContent({ gym: { name: LONG, boardTypes: [], boardSummaries: [] }, hasArt: false, fontFamily: FONT }),
  ],
  [
    'board with a location',
    buildBoardCardContent({
      board: { name: LONG, boardType: 'kilter', ...kilter, angle: 40, locationName: LONG },
      config: kilter,
      hasArt: true,
      fontFamily: FONT,
    }),
  ],
  [
    'spray wall',
    buildSprayCardContent({ board: { name: LONG, angle: 40, locationName: LONG }, holdCount: 1_200, fontFamily: FONT }),
  ],
  [
    'right-to-left gym',
    buildGymCardContent({
      gym: {
        name: 'מרכז טיפוס הר הכרמל',
        boardTypes: ['kilter'],
        boardSummaries: [{ boardType: 'kilter', angle: 40 }],
      },
      hasArt: true,
      fontFamily: FONT,
    }),
  ],
  [
    'right-to-left spray wall',
    buildSprayCardContent({
      board: { name: 'صالة تسلق الجبل', angle: 25, locationName: null },
      holdCount: 1,
      fontFamily: FONT,
    }),
  ],
  [
    'climb card with a long setter',
    buildOgClimbCardContent({
      name: LONG,
      grade: '8a/V11',
      setter: LONG,
      angle: 40,
      boardLine: 'Touchstone · Dungeon Trainer · Full Size Commercial',
      fontFamily: FONT,
    })!,
  ],
  [
    'right-to-left climb card',
    buildOgClimbCardContent({
      name: 'מסלול לנגה נגה ואלומה',
      grade: 'V7',
      setter: 'تسلق',
      angle: 40,
      fontFamily: FONT,
    })!,
  ],
];

describe('the icon and wordmark corner', () => {
  it.each(cards)('stays clear of everything else on a %s card', async (_label, content) => {
    const { layers, brand } = await renderOgFamilyTextLayers(content);

    // The icon and the wordmark are the last two layers.
    const [icon, wordmark] = layers.slice(-2);
    expect((await sharp(icon.input).metadata()).width).toBe(OG_FAMILY_ICON_SIZE);
    expect(icon.left).toBe(brand.left);
    expect(wordmark.left).toBeGreaterThan(icon.left + OG_FAMILY_ICON_SIZE);

    for (const layer of layers.slice(0, -2)) {
      const { width, height } = await sharp(layer.input).metadata();
      const rect = { left: layer.left, top: layer.top, width, height };
      expect(overlaps(rect, brand), JSON.stringify(rect)).toBe(false);
    }
    const art = ogFamilyArtBounds(content.slot);
    if (art) expect(brand.left).toBeGreaterThanOrEqual(art.right);
    expect(brand.top + brand.height).toBeLessThanOrEqual(630);
  });
});
