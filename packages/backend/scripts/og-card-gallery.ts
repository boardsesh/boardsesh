/**
 * Render every share card (`/og/*`) from fixed sample content, with no database,
 * and write them beside an `index.html` contact sheet.
 *
 *   cd packages/backend && vp exec tsx scripts/og-card-gallery.ts [outDir]
 *
 * Each card goes through the same card-model builder and renderer the live
 * endpoint uses, so a layout change shows up here exactly as it will in a chat
 * preview. The sample climbs are spread across the whole board on purpose: a
 * card that crops its art cuts holds off the edge, and that is easy to see.
 *
 * `scripts/fetch-og-samples.sh` is the other half: it fetches the real endpoints
 * of a running dev stack, against real rows.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLedPlacements } from '@boardsesh/board-constants/led-placements';
import type { OgFamilyCardContent } from '@boardsesh/board-render/og-family';
import type { OgFamilyArtSpec } from '../src/services/board-render';
import type { BoardName } from '@boardsesh/shared-schema';
import type { RecapFeaturedTick, SessionRecapRead } from '../src/services/og-family/session-recap';

const here = dirname(fileURLToPath(import.meta.url));
process.env.BOARD_IMAGES_ROOT ??= resolve(here, '../../web/public');

const outDir = resolve(process.argv[2] ?? join(here, '../../../tmp/og-gallery'));
const FONT = 'Noto Sans';

/**
 * A climb that touches both side walls: every `stride`-th placement of the board,
 * so the lit holds span its full width. Role codes cycle start, hand, foot, finish.
 */
function spreadFrames(boardName: BoardName, layoutId: number, sizeId: number, roles: readonly number[]): string {
  const placements = Object.keys(getLedPlacements(boardName, layoutId, sizeId))
    .map(Number)
    .sort((first, second) => first - second);
  const picks = 10;
  const stride = Math.max(1, Math.floor(placements.length / picks));
  return Array.from({ length: picks }, (_, index) => placements[index * stride])
    .filter((placement) => placement !== undefined)
    .map((placement, index) => `p${placement}r${roles[index % roles.length]}`)
    .join('');
}

const KILTER = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,20' };
const TENSION = { boardName: 'tension' as const, layoutId: 10, sizeId: 10, setIds: '12,13,14,15' };
const KILTER_ROLES = [12, 13, 13, 15, 14] as const;
const TENSION_ROLES = [5, 6, 6, 8, 7] as const;

async function main() {
  const service = await import('../src/services/board-render');
  const cards = await import('../src/services/og-family/card-model');
  const places = await import('../src/services/og-family/place-card-model');
  await service.initBoardRenderer();
  await service.waitForBoardRenderWarmup();

  const kilterArt: OgFamilyArtSpec = {
    ...KILTER,
    frames: spreadFrames('kilter', KILTER.layoutId, KILTER.sizeId, KILTER_ROLES),
  };
  const tensionArt: OgFamilyArtSpec = {
    ...TENSION,
    frames: spreadFrames('tension', TENSION.layoutId, TENSION.sizeId, TENSION_ROLES),
  };

  const featured: RecapFeaturedTick = {
    boardType: 'tension',
    difficulty: 22,
    climbName: 'Anything',
    climberName: 'Marco',
    status: 'send',
    angle: 40,
    frames: null,
    renderBoard: null,
  };
  const recap: SessionRecapRead = {
    sends: 6,
    flashes: 3,
    attempts: 14,
    capped: false,
    gradeRows: [
      { difficulty: 22, sends: 1, flashes: 0 },
      { difficulty: 21, sends: 1, flashes: 2 },
      { difficulty: 20, sends: 1, flashes: 1 },
    ],
    featured,
    participants: [{ name: 'Marco', sends: 6 }],
    durationMinutes: 68,
  };
  const crewRecap: SessionRecapRead = {
    ...recap,
    featured: { ...featured, climbName: 'The Long Name Of A Very Hard Problem On The Wall' },
    participants: [
      { name: 'Marco', sends: 4 },
      { name: 'Daniel Comber-Todd', sends: 2 },
    ],
  };

  const samples: { name: string; art: OgFamilyArtSpec | null; content: OgFamilyCardContent }[] = [
    {
      name: 'session-recap',
      art: tensionArt,
      content: cards.buildRecapCardContent({ recap, art: tensionArt, fontFamily: FONT }),
    },
    {
      name: 'session-recap-crew',
      art: kilterArt,
      content: cards.buildRecapCardContent({ recap: crewRecap, art: kilterArt, fontFamily: FONT }),
    },
    {
      name: 'session-join',
      art: kilterArt,
      content: cards.buildJoinCardContent({
        name: 'Daniel Comber-Todd',
        board: { config: KILTER, angle: 40 },
        art: kilterArt,
        fontFamily: FONT,
      }),
    },
    {
      name: 'playlist',
      art: kilterArt,
      content: cards.buildPlaylistCardContent({
        name: 'Tuesday crimps',
        boardName: 'kilter',
        climbCount: 42,
        summary: { p10Difficulty: 16, p90Difficulty: 22 },
        art: kilterArt,
        fontFamily: FONT,
      }),
    },
    {
      name: 'profile',
      art: kilterArt,
      content: cards.buildProfileCardContent({
        displayName: 'Marco',
        avatar: null,
        hardest: {
          climbName: 'Anything',
          boardType: 'kilter',
          difficulty: 24,
          consensusDifficulty: null,
          frames: kilterArt.frames,
          renderBoard: null,
        },
        stats: {
          totalDistinctClimbs: 312,
          layoutStats: [
            {
              boardType: 'kilter',
              distinctClimbCount: 312,
              gradeCounts: ['V2', 'V3', 'V4', 'V5', 'V6', 'V7'].map((grade, index) => ({
                grade,
                count: 10 + index * 7,
              })),
            },
          ],
        },
        art: kilterArt,
        fontFamily: FONT,
      }),
    },
    {
      name: 'setter',
      art: tensionArt,
      content: cards.buildSetterCardContent({
        username: 'setterperson',
        linkedDisplayName: 'Setter Person',
        avatar: null,
        hasLinkedAvatar: false,
        climbCount: 87,
        boardTypes: ['tension'],
        totalAscents: 1532,
        topClimb: null,
        art: tensionArt,
        fontFamily: FONT,
      }),
    },
    {
      name: 'board',
      art: { ...KILTER, frames: '' },
      content: places.buildBoardCardContent({
        board: {
          boardType: 'kilter',
          ...KILTER,
          name: 'Garage wall',
          angle: 40,
          locationName: 'Amsterdam',
        },
        config: KILTER,
        hasArt: true,
        fontFamily: FONT,
      }),
    },
    {
      name: 'gym',
      art: { ...TENSION, frames: '' },
      content: places.buildGymCardContent({
        gym: {
          name: 'Boulderhal Sterk',
          boardTypes: ['kilter', 'tension'],
          boardSummaries: [
            { boardType: 'kilter', angle: 40 },
            { boardType: 'tension', angle: 35 },
          ],
        },
        hasArt: true,
        fontFamily: FONT,
      }),
    },
  ];

  await mkdir(outDir, { recursive: true });
  for (const sample of samples) {
    const result = await service.renderOgFamilyArt({
      cacheKey: service.buildOgFamilyByteKey('gallery', `${sample.name}-${Date.now()}`),
      art: sample.art,
      content: sample.content,
    });
    await writeFile(join(outDir, `${sample.name}.jpg`), result.buffer);
    console.log(`wrote ${sample.name}.jpg`);
  }

  const climb = await service.renderOgClimb({
    ...tensionArt,
    format: 'jpeg',
    card: { name: 'Anything', grade: '7a/V6', setter: 'Marco', angle: 40, boardLine: 'Tension · 12 x 12' },
  });
  await writeFile(join(outDir, 'climb.jpg'), climb.buffer);
  console.log('wrote climb.jpg');

  const names = ['climb', ...samples.map((sample) => sample.name)];
  const html = `<!doctype html><meta charset="utf-8"><title>OG cards</title>
<style>body{background:#111;color:#ddd;font:14px system-ui;margin:24px}figure{margin:0 0 32px}img{width:600px;display:block;border:1px solid #333}
.row{display:flex;gap:24px;align-items:flex-start}.crop{width:315px;height:315px;overflow:hidden;position:relative;border:1px solid #333}
.crop img{position:absolute;left:-142px;top:0;width:600px;border:0}</style>
${names
  .map(
    (name) =>
      `<figure><figcaption>${name}</figcaption><div class="row"><img src="${name}.jpg"><div class="crop" title="square search crop"><img src="${name}.jpg"></div></div></figure>`,
  )
  .join('\n')}`;
  await writeFile(join(outDir, 'index.html'), html);
  console.log(`gallery: ${join(outDir, 'index.html')}`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
