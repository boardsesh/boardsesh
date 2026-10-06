import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  anchorAt as stageAnchorAt,
  backgroundAt,
  closerPose,
  footageAt as stageFootageAt,
  orthoPath,
  mixOklab,
  projectPoint as stageProjectPoint,
  spring,
} from '../../marketing/showcase-video/anim.mjs';
import {
  SHOWCASE_TAKE_IDS,
  SHOWCASE_WEB_POSTER_DIR,
  SHOWCASE_WEB_VIDEO_DIR,
  anchorAt,
} from '../lib/showcase-video/contract';
import {
  PLACEHOLDER_SCREEN,
  SHOWCASE_CANVAS,
  SHOWCASE_CHOREO,
  SHOWCASE_PERSPECTIVE,
  SHOWCASE_PLACEHOLDER_TAKES,
  SHOWCASE_POSES,
  SHOWCASE_LIGHT_ROLE_COLORS,
  SHOWCASE_STAGE_COPY,
  SHOWCASE_STAGE_LIGHT,
  SHOWCASE_WEB_MAX_BYTES,
  SHOWCASE_CALLOUT_LAYOUT,
  SHOWCASE_SCENE_STAGING,
  SHOWCASE_WEB_LITE,
  SHOWCASE_WEB_POSTER_FRAME,
  isFlatFrame,
  webBitrateFor,
  webRotation,
  anchorOnScreen,
  buildBoardRenderUrl,
  buildClimbSearchRequest,
  calloutLabelCssPx,
  calloutTimings,
  footageAt,
  localAtFootage,
  applyAnchorShifts,
  segmentsLength,
  takeSegments,
  SHOWCASE_TAKE_EDITS,
  marksNeeded,
  resolveTakeEdit,
  pickPlaceholderClimb,
  boardTakeLabel,
  buildMasterArgs,
  buildMezzanineArgs,
  buildPlaceholderFootageArgs,
  buildWebMp4PassArgs,
  buildWebmPassArgs,
  calloutSlots,
  contrastRatio,
  countWords,
  footageFrameIndex,
  layoutPortraitPills,
  layoutSceneCallouts,
  parseHeadline,
  parseRenderArgs,
  pileupArrivalFrames,
  placeholderAnchorsFile,
  ISLAND_LAYOUT,
  SHOWCASE_DRAWN_PLACEHOLDER_MARKER,
  islandOverlaySvg,
  pickPlaceholderClimbs,
  planBoards,
  planLeaders,
  SHOWCASE_PILEUP,
  prepareAnchorsFile,
  projectPhonePoint,
  readingBudgetReport,
  readingBudgetMet,
  formatReadingBudgetTable,
  calloutReadingFrames,
  SHOWCASE_CALLOUT_SETTLE_FRAMES,
  SHOWCASE_MAX_TAIL_HOLD_FRAMES,
  withoutDonationLine,
  captionReadingFrames,
  readingBudgetFrames,
  SHOWCASE_CAPTION_BAR,
  type ResolvedTakeEdit,
  type TakeEdit,
  resolveSceneCallouts,
  sceneCalloutCopy,
  screenToCanvas,
  stillFramesForScene,
  webCutSeconds,
  workoutTickFrames,
  type ShowcaseCopy,
} from '../lib/showcase-video/render';
import { SHOWCASE_TARGETS, SHOWCASE_TARGET_NAMES } from '../lib/showcase-video/targets';
import {
  SHOWCASE_SCENES,
  SHOWCASE_TOTAL_FRAMES,
  resolveTimeline,
  type ShowcaseScene,
} from '../lib/showcase-video/timeline';
import type { ShowcaseTakeId } from '../lib/showcase-video/contract';

/**
 * The marks of the recording the edit was tuned on (work/marks/*.json), seconds.
 * `spray` has no recording yet: its marks and length are what its flow should
 * give (the retired light take's rhythm, less the bulb tap). Replace them with
 * the real ones after the first spray recording.
 */
const RECORDED_MARKS: Partial<Record<ShowcaseTakeId, Record<string, number>>> = {
  spray: { 'next-1': 2.7, 'next-2': 5.6 },
  wall: { 'sheet-open': 5.438, 'history-shown': 10.242 },
  crew: {
    'invite-closed': 4.591,
    'queue-open': 8.384,
    'row-landed': 10.981,
    'crew-added': 12.09,
    'play-next-menu': 17.66,
  },
  workouts: { 'pyramid-picked': 2.954, 'rest-armed': 6.959, 'rest-pill': 11.189, started: 17.177 },
  'lock-screen': { home: 4.149, 'island-expanded': 10.077, 'next-tapped': 12.859 },
  log: { scrolled: 5.005, 'filter-kilter': 10.252, 'filter-tension': 17.871 },
};
const RECORDED_FRAMES: Partial<Record<ShowcaseTakeId, number>> = {
  spray: 330,
  wall: 504,
  crew: 766,
  workouts: 721,
  'lock-screen': 588,
  log: 716,
};

/** The marks each take's flow raises, from the table in docs/showcase-video.md. */
const DOCUMENTED_MARKS: Partial<Record<ShowcaseTakeId, readonly string[]>> = {
  spray: ['next-1', 'next-2'],
  wall: ['sheet-open', 'history-shown'],
  crew: ['invite-closed', 'queue-open', 'crew-added', 'row-landed', 'play-next-menu'],
  workouts: ['pyramid-picked', 'rest-armed', 'rest-pill', 'started'],
  'lock-screen': ['home', 'island-expanded', 'next-tapped'],
  log: ['scrolled', 'filter-kilter', 'filter-tension'],
};

function resolvedEdit(takeId: ShowcaseTakeId) {
  const edit = SHOWCASE_TAKE_EDITS[takeId];
  const marks = RECORDED_MARKS[takeId];
  const frames = RECORDED_FRAMES[takeId];
  const scene = SHOWCASE_SCENES.find((candidate) => candidate.takes.includes(takeId));
  if (!edit || !marks || !frames || !scene) throw new Error(`no edit for ${takeId}`);
  return resolveTakeEdit(takeId, edit, marks, scene.endFrame - scene.startFrame, frames);
}

const copy = JSON.parse(readFileSync(SHOWCASE_STAGE_COPY, 'utf8')) as ShowcaseCopy;
const sceneOf = (id: string) => {
  const scene = SHOWCASE_SCENES.find((candidate) => candidate.id === id);
  if (!scene) throw new Error(`no scene ${id}`);
  return scene;
};

describe('screenToCanvas', () => {
  const canvas = SHOWCASE_CANVAS['16x9'];
  const flat = SHOWCASE_POSES['16x9'].CALLOUT;

  it('maps the full screen to the 402x874 screen box of the flat CALLOUT phone', () => {
    const rect = screenToCanvas({ x: 0, y: 0, width: 440, height: 956 }, PLACEHOLDER_SCREEN, flat, canvas);
    // Phone centred at (1090, 540): 428x900 body, 13 px of rim + bezel.
    expect(rect.x).toBeCloseTo(1090 - 214 + 13);
    expect(rect.y).toBeCloseTo(540 - 450 + 13);
    expect(rect.width).toBeCloseTo(402);
    expect(rect.height).toBeCloseTo(874);
  });

  it('agrees with the stage copy of the projection on tilted, scaled and off-centre poses', () => {
    const projection = { perspective: SHOWCASE_PERSPECTIVE, originX: canvas.width / 2, originY: canvas.height / 2 };
    for (const pose of Object.values(SHOWCASE_POSES['16x9'])) {
      for (const [x, y] of [
        [0, 0],
        [-201, -437],
        [150, 300],
      ]) {
        const node = projectPhonePoint(pose, x, y, canvas);
        const browser = stageProjectPoint(pose, x, y, projection);
        expect(node.x).toBeCloseTo(browser.x, 6);
        expect(node.y).toBeCloseTo(browser.y, 6);
      }
    }
  });

  it('shrinks the far side of a phone turned away from the viewer', () => {
    const tilted = SHOWCASE_POSES['16x9'].HERO_TILT;
    const left = projectPhonePoint({ ...tilted, rx: 0, rz: 0 }, -200, 0, canvas);
    const right = projectPhonePoint({ ...tilted, rx: 0, rz: 0 }, 200, 0, canvas);
    // rotateY(+14deg) pushes the right edge back, so it lands closer to the centre than the left edge.
    expect(tilted.cx - left.x).toBeGreaterThan(right.x - tilted.cx);
  });
});

describe('anchors', () => {
  const samples = [
    { t: 0, x: 1, y: 1, width: 10, height: 10 },
    { t: 2, x: 5, y: 5, width: 10, height: 10 },
  ];

  it('resolves samples the same way in Node and in the stage', () => {
    for (const t of [-1, 0, 1.9, 2, 9]) expect(stageAnchorAt(samples, t)).toEqual(anchorAt(samples, t));
  });

  it('calls an anchor on screen only when most of it is', () => {
    expect(anchorOnScreen({ x: 10, y: 10, width: 50, height: 50 }, PLACEHOLDER_SCREEN)).toBe(true);
    expect(anchorOnScreen({ x: 420, y: 10, width: 50, height: 50 }, PLACEHOLDER_SCREEN)).toBe(false);
    expect(anchorOnScreen({ x: 10, y: 1000, width: 50, height: 50 }, PLACEHOLDER_SCREEN)).toBe(false);
    expect(anchorOnScreen(null, PLACEHOLDER_SCREEN)).toBe(false);
  });

  it('skips a callout whose anchor the take never reports, with a warning', () => {
    const crew = sceneOf('crew');
    const file = placeholderAnchorsFile('crew', {
      source: { kind: 'still', file: 'queue.webp' },
      anchors: { 'play-next': { x: 10, y: 400, width: 300, height: 80 } },
    });
    const { callouts, warnings } = resolveSceneCallouts(crew, file, sceneCalloutCopy(copy, 'crew'));
    expect(callouts).toEqual(['play-next']);
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toMatch(/invite-qr/);
  });

  it('skips a callout whose anchor is off screen', () => {
    const wall = sceneOf('wall');
    const file = placeholderAnchorsFile('wall', {
      source: { kind: 'still', file: 'wall-status.webp' },
      anchors: {
        'board-history-button': { x: 500, y: 20, width: 40, height: 20 },
        'now-on-wall': { x: 132, y: 81, width: 230, height: 35 },
        'wall-history': { x: 8, y: 181, width: 424, height: 24 },
      },
    });
    const { callouts, warnings } = resolveSceneCallouts(wall, file, sceneCalloutCopy(copy, 'wall'));
    expect(callouts).toEqual(['now-on-wall', 'wall-history']);
    expect(warnings[0]).toMatch(/off screen/);
  });

  it('plays a take without an edit from one second in, and clamps at the ends', () => {
    const boards = sceneOf('boards');
    expect(takeSegments(boards)).toEqual([[30, 30 + boards.endFrame - boards.startFrame]]);
    expect(footageFrameIndex(boards, boards.startFrame, 400)).toBe(30);
    // The loop closer reads the board takes just before the cut's end, as the frames before frame 0.
    expect(footageFrameIndex(boards, boards.startFrame - 1, 400)).toBe(29);
    expect(footageFrameIndex(boards, boards.startFrame - 100, 400)).toBe(0);
    expect(footageFrameIndex(boards, 10_000, 400)).toBe(399);
  });
});

describe('callout layout', () => {
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

  it('uses the storyboard pill slots, sliding them down for boxes low on the screen', () => {
    expect(calloutSlots(2)).toEqual([420, 660]);
    expect(calloutSlots(3)).toEqual([360, 540, 720]);
    expect(calloutSlots(0)).toEqual([]);
    expect(calloutSlots(3, 300)).toEqual([360, 540, 720]);
    expect(calloutSlots(3, 900)).toEqual([540, 720, 900]);
  });

  it('staggers leader gutters so stacked leaders never overlap', () => {
    const plans = planLeaders([rect(900, 270, 60, 40), rect(1260, 350, 30, 40), rect(890, 440, 400, 80)]);
    expect(plans.every((plan) => plan.exit === 'side')).toBe(true);
    expect(new Set(plans.map((plan) => plan.gutterX)).size).toBe(3);
    plans.forEach((plan) => expect(plan.gutterX).toBeLessThanOrEqual(1340));
    expect(plans.map((plan) => plan.slotY)).toEqual([360, 540, 720]);
  });

  it('keeps a lone leader on the nominal gutter', () => {
    expect(planLeaders([rect(1100, 480, 100, 40)])[0]).toMatchObject({ exit: 'side', gutterX: 1340, slotY: 540 });
  });

  it('sends a row of buttons up on risers instead of through each other', () => {
    // The lock screen's Live Activity row, in callout order: next (right), relight (left), mirror.
    const row = [rect(1210, 820, 90, 60), rect(1080, 820, 60, 60), rect(1145, 820, 60, 60)];
    const plans = planLeaders(row);
    // The rightmost button has a clear run to the gutter; the other two rise.
    expect(plans.map((plan) => plan.exit)).toEqual(['side', 'top', 'top']);
    // The leftmost riser takes the highest lane, so the risers never cross.
    expect(plans[1].laneY).toBeLessThan(plans[2].laneY);
    expect(plans[2].laneY).toBeLessThan(820);
  });

  it('alternates 9:16 pills left and right and keeps same-side pills apart', () => {
    const pills = layoutPortraitPills([rect(300, 800, 40, 40), rect(700, 820, 40, 40), rect(300, 830, 40, 40)], {
      width: 1080,
      height: 1920,
    });
    expect(pills.map((pill) => pill.side)).toEqual(['left', 'right', 'left']);
    expect(pills[2].y - pills[0].y).toBeGreaterThanOrEqual(76);
    expect(pills.every((pill) => pill.exit === 'side')).toBe(true);
  });

  it('stacks a 9:16 pill above a row of boxes when neither side is clear', () => {
    const pills = layoutPortraitPills([rect(460, 1000, 60, 60), rect(530, 1000, 60, 60), rect(600, 1000, 60, 60)], {
      width: 1080,
      height: 1920,
    });
    expect(pills[0]).toMatchObject({ side: 'left', exit: 'side' });
    expect(pills[1].exit).toBe('top');
    expect(pills[1].y).toBeLessThan(1000);
    expect(pills[2]).toMatchObject({ side: 'right', exit: 'side' });
  });

  it('lays out every placeholder callout in both formats', () => {
    for (const format of ['16x9', '9x16'] as const) {
      for (const scene of SHOWCASE_SCENES) {
        if (scene.callouts.length === 0) continue;
        const take = scene.takes[0];
        const file = placeholderAnchorsFile(take, SHOWCASE_PLACEHOLDER_TAKES[take]);
        const labels = sceneCalloutCopy(copy, scene.id);
        const callouts = layoutSceneCallouts(format, scene, scene.callouts, file, labels);
        expect(callouts.map((callout) => callout.role)).toEqual(['start', 'hand', 'finish'].slice(0, callouts.length));
        callouts.forEach((callout) => expect(callout.label).toBe(labels[callout.name]));
      }
    }
  });

  it('darkens the role hues on lavender scenes to at least 3:1', () => {
    for (const color of Object.values(SHOWCASE_LIGHT_ROLE_COLORS)) {
      expect(contrastRatio(color, SHOWCASE_STAGE_LIGHT), color).toBeGreaterThanOrEqual(3);
    }
    // The LED hues they replace would not pass.
    expect(contrastRatio('#4DF5FD', SHOWCASE_STAGE_LIGHT)).toBeLessThan(3);
  });
});

describe('donation line', () => {
  it("says who pays for Boardsesh in the homepage's words, and never claims tax relief or perks", () => {
    const marketing = JSON.parse(
      readFileSync(new URL('../../packages/shared/i18n/locales/en-US/marketing.json', import.meta.url), 'utf8'),
    ) as unknown;
    const proofNoCount = JSON.stringify(marketing).match(/"proofNoCount":"([^"]+)"/)?.[1] ?? '';
    const donation = copy.outro.donation ?? '';
    expect(donation).toBe('Paid for by the climbers who use it.');
    expect(proofNoCount.toLowerCase()).toContain(donation.replace(/\.$/, '').toLowerCase());
    expect(donation).not.toMatch(/tax|deduct|perk|reward/i);
    expect(copy.outro.pill).toContain('iOS & Android');
  });

  it('is on by default; --no-donation-line drops it and skips the web encodes', () => {
    expect(parseRenderArgs([])).toMatchObject({ donationLine: true, skipWeb: false });
    expect(parseRenderArgs(['--no-donation-line'])).toMatchObject({ donationLine: false, skipWeb: true });
    const storeCopy = withoutDonationLine(copy);
    expect(storeCopy.outro.donation).toBeUndefined();
    expect(storeCopy.outro.pill).toBe(copy.outro.pill);
    const outro = sceneOf('outro');
    const [withLine] = readingBudgetReport(copy, [outro]);
    const [without] = readingBudgetReport(storeCopy, [outro]);
    expect(withLine.headlineWords - without.headlineWords).toBe(8);
    expect(readingBudgetMet(withLine)).toBe(true);
  });
});

describe('every render target on the recorded takes', () => {
  const available = new Set(SHOWCASE_TAKE_IDS);
  const editsFor = (scenes: readonly ShowcaseScene[]) => {
    const edits: Partial<Record<ShowcaseTakeId, ResolvedTakeEdit>> = {};
    for (const scene of scenes) {
      for (const takeId of scene.takes) {
        const edit = SHOWCASE_TAKE_EDITS[takeId];
        const marks = RECORDED_MARKS[takeId];
        const frames = RECORDED_FRAMES[takeId];
        if (!edit || !marks || !frames) continue;
        edits[takeId] = resolveTakeEdit(takeId, edit, marks, scene.endFrame - scene.startFrame, frames);
      }
    }
    return edits;
  };

  it('meets the reading budget in every motion target, callouts included, at its own scene lengths', () => {
    for (const name of SHOWCASE_TARGET_NAMES) {
      const target = SHOWCASE_TARGETS[name];
      if (target.layout !== 'motion') continue;
      const timeline = resolveTimeline(available, target.scenes);
      const targetCopy = target.donationLine ? copy : withoutDonationLine(copy);
      for (const report of readingBudgetReport(targetCopy, timeline.scenes, editsFor(timeline.scenes))) {
        expect(readingBudgetMet(report), `${name}/${report.sceneId}\n${formatReadingBudgetTable([report])}`).toBe(true);
      }
    }
  });

  it('cuts every App Preview clip inside its take, with time to read its caption', () => {
    const target = SHOWCASE_TARGETS['app-store'];
    for (const clip of target.clips) {
      const marks = RECORDED_MARKS[clip.take];
      const frames = RECORDED_FRAMES[clip.take];
      if (!marks || !frames) throw new Error(`no recording for ${clip.take}`);
      const edit = resolveTakeEdit(clip.take, { segments: clip.segments }, marks, clip.frames, frames);
      expect(edit.warnings, clip.take).toEqual([]);
      expect(segmentsLength(edit.segments), clip.take).toBe(clip.frames);
      const words = countWords(copy.appStore.captions[clip.caption]);
      expect(words, clip.caption).toBeLessThanOrEqual(SHOWCASE_CAPTION_BAR.maxWords);
      expect(captionReadingFrames(clip.frames), clip.caption).toBeGreaterThanOrEqual(readingBudgetFrames(words) + 30);
    }
  });
});

describe('reading budget', () => {
  it('counts words, not punctuation', () => {
    expect(countWords('Free, no ads. iOS & Android.')).toBe(5);
    expect(countWords('Your spray\nwall, *too.*'.replace(/\*/g, ''))).toBe(4);
  });

  const recordedEdits = Object.fromEntries(
    (Object.keys(SHOWCASE_TAKE_EDITS) as ShowcaseTakeId[]).map((takeId) => [takeId, resolvedEdit(takeId)]),
  ) as Partial<Record<ShowcaseTakeId, ResolvedTakeEdit>>;

  it('gives every scene at least 0.3 s per visible word, headline and callouts together', () => {
    const reports = readingBudgetReport(copy, SHOWCASE_SCENES, recordedEdits);
    console.info(`reading budget (recorded marks):\n${formatReadingBudgetTable(reports)}`);
    for (const report of reports) {
      expect(report.words, report.sceneId).toBe(report.headlineWords + report.calloutWords);
      expect(report.haveFrames, `${report.sceneId}: ${report.words} words`).toBeGreaterThanOrEqual(report.needFrames);
    }
    const wall = reports.find((report) => report.sceneId === 'wall');
    expect(wall).toMatchObject({ headlineWords: 5, calloutWords: 10, words: 15 });
  });

  it('keeps every callout fully settled for max(1.6 s, 0.45 s a word) before anything exits', () => {
    expect(calloutReadingFrames(2)).toBe(48);
    expect(calloutReadingFrames(5)).toBe(68);
    expect(SHOWCASE_CALLOUT_SETTLE_FRAMES).toBe(20);
    for (const report of readingBudgetReport(copy, SHOWCASE_SCENES, recordedEdits)) {
      const scene = sceneOf(report.sceneId);
      expect(
        report.callouts.map((callout) => callout.name),
        report.sceneId,
      ).toEqual(scene.callouts);
      for (const callout of report.callouts) {
        const label = `${report.sceneId}/${callout.name}: settled ${callout.settledFrames} of ${callout.needFrames}`;
        expect(callout.settledFrames, label).toBeGreaterThanOrEqual(callout.needFrames);
        expect(readingBudgetMet(report), report.sceneId).toBe(true);
      }
    }
  });

  it('staggers callout entrances at least half a second apart', () => {
    expect(SHOWCASE_CHOREO.calloutStagger).toBeGreaterThanOrEqual(15);
    for (const report of readingBudgetReport(copy, SHOWCASE_SCENES, recordedEdits)) {
      report.callouts.slice(1).forEach((callout, index) => {
        expect(
          callout.enter - report.callouts[index].enter,
          `${report.sceneId}/${callout.name}`,
        ).toBeGreaterThanOrEqual(15);
      });
    }
  });

  it('flags a callout that leaves before it has been read', () => {
    const spray = sceneOf('spray');
    const short = { ...spray, endFrame: spray.startFrame + 90 };
    const [report] = readingBudgetReport(copy, [short]);
    expect(readingBudgetMet(report)).toBe(false);
    expect(formatReadingBudgetTable([report])).toContain('SHORT');
  });

  it('parses the accent word and forced line breaks', () => {
    expect(parseHeadline('Every board.\nOne *app.*')).toEqual([
      [
        { text: 'Every', accent: false },
        { text: 'board.', accent: false },
      ],
      [
        { text: 'One', accent: false },
        { text: 'app.', accent: true },
      ],
    ]);
  });

  it('has copy for every callout the storyboard asks for', () => {
    for (const scene of SHOWCASE_SCENES) {
      for (const name of scene.callouts) expect(sceneCalloutCopy(copy, scene.id)[name], name).toBeTruthy();
    }
  });
});

describe('stills', () => {
  it('leads each sheet with the settled frame and covers the loop seam', () => {
    const boards = sceneOf('boards');
    expect(stillFramesForScene(boards)[0]).toEqual({
      // Before the side phones start to sink.
      frame: boards.endFrame - SHOWCASE_PILEUP.exitFromEnd - 2,
      label: 'settled',
    });
    expect(stillFramesForScene(boards).map((still) => still.label)).toEqual(
      expect.arrayContaining(['crowding', 'squeeze']),
    );
    const outro = stillFramesForScene(sceneOf('outro')).map((still) => still.frame);
    expect(outro).toContain(SHOWCASE_TOTAL_FRAMES - 1);
    expect(outro).toContain(0);
    for (const scene of SHOWCASE_SCENES) {
      for (const still of stillFramesForScene(scene)) {
        expect(still.frame).toBeGreaterThanOrEqual(0);
        expect(still.frame).toBeLessThan(SHOWCASE_TOTAL_FRAMES);
      }
    }
  });

  it('puts the settled frame inside the settle window', () => {
    const crew = sceneOf('crew');
    const settled = stillFramesForScene(crew)[0].frame;
    expect(settled).toBeLessThan(crew.endFrame - SHOWCASE_CHOREO.settleEndFromEnd);
    expect(settled).toBeGreaterThan(crew.startFrame + 60);
  });
});

describe('encoding', () => {
  it('keeps every web file under check-large-files without an allowlist entry', () => {
    expect(SHOWCASE_WEB_MAX_BYTES).toBe(1_900_000);
    expect(SHOWCASE_WEB_LITE.maxWebmBytes).toBeLessThanOrEqual(SHOWCASE_WEB_MAX_BYTES);
    expect(SHOWCASE_WEB_LITE.maxMp4Bytes).toBeLessThanOrEqual(SHOWCASE_WEB_MAX_BYTES);
    expect(webCutSeconds()).toBeCloseTo(SHOWCASE_TOTAL_FRAMES / 30);
  });

  it('downscales the 2x screenshots with lanczos into a near-lossless RGB mezzanine', () => {
    const args = buildMezzanineArgs({ width: 1920, height: 1080 }, '/w/m.mkv');
    expect(args).toContain('image2pipe');
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=1920:1080:flags=lanczos');
    expect(args[args.indexOf('-c:v', args.indexOf('-vf')) + 1]).toBe('libx264rgb');
    expect(buildMezzanineArgs({ width: 1080, height: 1920 }, '/w/m.mkv')).toContain('scale=1080:1920:flags=lanczos');
    expect(buildMezzanineArgs({ width: 886, height: 1920 }, '/w/m.mkv')).toContain('scale=886:1920:flags=lanczos');
  });

  it('encodes brag.mp4 as crf 18 yuv420p BT.709 with faststart and no audio', () => {
    const args = buildMasterArgs('/w/m.mkv', '/o/brag.mp4');
    expect(args[args.indexOf('-crf') + 1]).toBe('18');
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
    expect(args[args.indexOf('-colorspace') + 1]).toBe('bt709');
    expect(args[args.indexOf('-color_primaries') + 1]).toBe('bt709');
    expect(args[args.indexOf('-color_trc') + 1]).toBe('bt709');
    expect(args[args.indexOf('-movflags') + 1]).toBe('+faststart');
    expect(args).toContain('-an');
    // The master always opens on frame 0; only a web cut with another poster frame is rotated.
    expect(args.join(' ')).not.toMatch(/trim=/);
  });

  it('encodes the webm as two-pass VP9 with row-mt, rotated to open on the poster frame', () => {
    const encode = { input: '/w/m.mkv', output: '/o/s.webm', bitrateKbps: 600, passLog: '/w/pass', startFrame: 132 };
    const first = buildWebmPassArgs(encode, 1);
    const second = buildWebmPassArgs(encode, 2);
    expect(first[first.indexOf('-c:v') + 1]).toBe('libvpx-vp9');
    expect(first[first.indexOf('-pass') + 1]).toBe('1');
    expect(first.slice(-3)).toEqual(['-f', 'null', '/dev/null']);
    expect(second[second.indexOf('-pass') + 1]).toBe('2');
    expect(second[second.length - 1]).toBe('/o/s.webm');
    expect(second[second.indexOf('-b:v') + 1]).toBe('600k');
    expect(second[second.indexOf('-row-mt') + 1]).toBe('1');
    expect(second).toContain('-an');
    const graph = second[second.indexOf('-filter_complex') + 1];
    expect(graph).toContain('trim=start_frame=132');
    expect(graph).toContain('trim=end_frame=132');
    expect(graph).toMatch(/\[a\]\[b\]concat=n=2:v=1:a=0/);
    expect(second[second.indexOf('-map') + 1]).toBe('[out]');
    expect(second).not.toContain('-vf');
  });

  it('plays the loop unrotated from frame 0', () => {
    expect(webRotation(0)).toEqual(['-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p']);
  });

  it('encodes the mp4 as H.264 with faststart and BT.709, scaled for the lite size', () => {
    const encode = { input: '/w/m.mkv', output: '/o/s.mp4', bitrateKbps: 600, passLog: '/w/pass', startFrame: 132 };
    const second = buildWebMp4PassArgs(encode, 2);
    expect(second[second.indexOf('-c:v') + 1]).toBe('libx264');
    expect(second[second.indexOf('-movflags') + 1]).toBe('+faststart');
    expect(second[second.indexOf('-colorspace') + 1]).toBe('bt709');
    expect(second).toContain('-an');
    const lite = buildWebMp4PassArgs({ ...encode, size: { width: 720, height: 1280 } }, 2);
    expect(lite[lite.indexOf('-filter_complex') + 1]).toMatch(/scale=720:1280:flags=lanczos/);
  });
});

describe('placeholder footage', () => {
  it('covers every take and every callout anchor the storyboard asks for', () => {
    for (const takeId of SHOWCASE_TAKE_IDS) expect(SHOWCASE_PLACEHOLDER_TAKES[takeId]).toBeDefined();
    for (const scene of SHOWCASE_SCENES) {
      for (const name of scene.callouts) {
        const rect = SHOWCASE_PLACEHOLDER_TAKES[scene.takes[0]].anchors[name];
        expect(anchorOnScreen(rect ?? null, PLACEHOLDER_SCREEN), `${scene.id}/${name}`).toBe(true);
      }
    }
  });

  it('extracts enough 800 px frames for the take, holding a short clip on its last frame', () => {
    const args = buildPlaceholderFootageArgs('spray', SHOWCASE_PLACEHOLDER_TAKES.spray, '/f/spray');
    expect(args[args.indexOf('-vf') + 1]).toMatch(/^fps=30,scale=800:-2:flags=lanczos,tpad=stop_mode=clone/);
    const spray = sceneOf('spray');
    expect(args[args.indexOf('-frames:v') + 1]).toBe(
      String(Math.ceil(((spray.endFrame - spray.startFrame) / 30 + 2) * 30)),
    );
    expect(args[args.length - 1]).toBe('/f/spray/%05d.jpg');
    expect(args.slice(0, 6)).toContain('-loop');
    // One frame of a help clip, held for the whole take.
    const frame = buildPlaceholderFootageArgs('workouts', SHOWCASE_PLACEHOLDER_TAKES.workouts, '/f/w');
    expect(frame[frame.indexOf('-vf') + 1]).toMatch(/^trim=end_frame=1,loop=loop=-1/);
  });

  it('stands the spray takes in with a store still until a spray frame is committed', () => {
    expect(SHOWCASE_PLACEHOLDER_TAKES.spray.source).toEqual(SHOWCASE_PLACEHOLDER_TAKES['boards-spray'].source);
    expect(SHOWCASE_PLACEHOLDER_TAKES.spray.source.kind).toBe('still');
  });
});

describe('CLI', () => {
  it('parses the documented flags', () => {
    expect(parseRenderArgs(['--', '--stills', '--format', '9x16'])).toMatchObject({
      stills: true,
      formats: ['9x16'],
      fromFrame: 0,
    });
    expect(parseRenderArgs(['--measure', '--from-frame', '120', '--placeholder-footage'])).toMatchObject({
      measure: true,
      fromFrame: 120,
      placeholderFootage: true,
      formats: ['16x9', '9x16'],
    });
    expect(() => parseRenderArgs(['--format', '4x3'])).toThrow(/--format/);
    expect(() => parseRenderArgs(['--from-frame', '-2'])).toThrow();
    expect(() => parseRenderArgs(['--from-frame', '9999'])).toThrow();
    expect(() => parseRenderArgs(['--wat'])).toThrow(/Unknown option/);
    expect(parseRenderArgs(['--frame', '264', '--format', '16x9'])).toMatchObject({ frame: 264, stills: false });
    expect(parseRenderArgs([]).frame).toBeNull();
  });
});

describe('stage motion helpers', () => {
  it('springs from 0 to 1 with a small overshoot', () => {
    expect(spring(0)).toBe(0);
    const samples = Array.from({ length: 60 }, (_, index) => spring(index / 30));
    expect(Math.max(...samples)).toBeGreaterThan(1);
    expect(Math.max(...samples)).toBeLessThan(1.1);
    expect(spring(2)).toBeCloseTo(1, 3);
  });

  it('mixes the backgrounds in OKLab, landing exactly on both ends', () => {
    expect(mixOklab('#110A20', '#F4F1FB', 0)).toBe('rgb(17 10 32)');
    expect(mixOklab('#110A20', '#F4F1FB', 1)).toBe('rgb(244 241 251)');
  });
});

describe('boards pile-up', () => {
  const boards = sceneOf('boards');

  it('lands every recorded board, the persistent Tension phone in the middle of the final row', () => {
    const plan = planBoards(boards.takes, new Set(boards.takes));
    expect(plan.arrival).toEqual(boards.takes);
    // The spray wall is the persistent phone: the next scene is its own.
    expect(plan.main).toBe('boards-spray');
    expect(plan.neatCount).toBe(3);
    expect(plan.arrival.slice(0, 3)).toEqual(['boards-kilter', 'boards-tension', 'boards-spray']);
    // MoonBoard is the first to join the pile-up, and So iLL squeezes in last.
    expect(plan.arrival[3]).toBe('boards-moonboard');
    expect(plan.arrival[8]).toBe('boards-soill');
    expect(plan.final).toHaveLength(9);
    // The trio keeps the middle, the spray wall dead centre, So iLL beside it.
    expect(plan.final.slice(3, 7)).toEqual(['boards-kilter', 'boards-spray', 'boards-soill', 'boards-tension']);
    expect(plan.final[4]).toBe('boards-spray');
    expect(plan.labels['boards-soill']).toBe('So iLL');
    expect(plan.labels['boards-spray']).toBe('Spray wall');
    expect(boardTakeLabel('boards-spray')).toBe('Spray wall');
    expect(boardTakeLabel('boards-moonboard')).toBe('MoonBoard');
  });

  it('carries on with whichever boards were recorded', () => {
    const recorded = new Set<ShowcaseTakeId>(['boards-kilter', 'boards-moonboard', 'boards-decoy']);
    const plan = planBoards(boards.takes, recorded);
    expect(plan.arrival).toEqual(['boards-kilter', 'boards-moonboard', 'boards-decoy']);
    // No spray wall in the trio: the first neat arrival becomes the persistent phone.
    expect(plan.main).toBe('boards-kilter');
    expect(plan.arrivalFrames).toHaveLength(3);
    expect(() => planBoards(boards.takes, new Set())).toThrow(/at least one board/);
  });

  it('opens on the neat three and brings the rest in fast, the last after a beat', () => {
    const frames = pileupArrivalFrames(9, 3);
    // The trio is there from frame 0: the poster, and where the loop closer lands.
    expect(frames.slice(0, 3)).toEqual([0, 0, 0]);
    expect(frames.slice(3, 8)).toEqual([40, 46, 52, 58, 64]);
    // The squeeze waits one gap plus a pause.
    expect(frames[8]).toBe(SHOWCASE_PILEUP.squeeze);
    expect(frames[8]).toBe(75);
    // Everyone is in well before the headline starts leaving.
    expect(Math.max(...frames)).toBeLessThan(
      boards.endFrame - boards.startFrame - SHOWCASE_CHOREO.wordsOutFromEnd - 30,
    );
  });

  it('lists every take in the scene arrival order the timeline declares', () => {
    expect(new Set(planBoards(boards.takes, new Set(boards.takes)).final)).toEqual(new Set(boards.takes));
  });
});

describe('workouts checklist', () => {
  it('ticks the pyramid in order and rests after the top set', () => {
    const grades = copy.workouts.rows.map((row) => row.grade);
    expect(grades).toEqual(['V2', 'V4', 'V5', 'V6', 'V5', 'V4']);
    const { ticks, restRow, restStart, restEnd } = workoutTickFrames(grades);
    expect(restRow).toBe(4);
    ticks.slice(1).forEach((tick, index) => expect(tick).toBeGreaterThan(ticks[index]));
    // The rest countdown runs between the top set's tick and the next row's.
    expect(restStart).toBeGreaterThan(ticks[3]);
    expect(restEnd).toBeLessThanOrEqual(ticks[4]);
    const workouts = sceneOf('workouts');
    const settleEnd = workouts.endFrame - workouts.startFrame - SHOWCASE_CHOREO.settleEndFromEnd;
    expect(ticks[ticks.length - 1] + 8).toBeLessThan(settleEnd);
    // Every rest is the footage's fixed 0:30 window.
    expect(new Set(copy.workouts.rows.map((row) => row.rest))).toEqual(new Set(['0:30']));
  });
});

describe('anchor preparation', () => {
  it('sorts samples and grows header-only anchors over the list below', () => {
    const prepared = prepareAnchorsFile(
      {
        takeId: 'wall',
        screen: { width: 440, height: 956 },
        anchors: {
          'wall-history': [
            { t: 2, x: 8, y: 400, width: 424, height: 24 },
            { t: 0, x: 8, y: 800, width: 424, height: 24 },
          ],
          'now-on-wall': [{ t: 0, x: 132, y: 81, width: 230, height: 35 }],
        },
      },
      {},
    );
    const history = prepared.anchors['wall-history'] ?? [];
    expect(history.map((sample) => sample.t)).toEqual([0, 2]);
    // Clamped to 24 pt above the bottom of the screen...
    expect(history[0].y + history[0].height).toBe(956 - 24);
    // ...otherwise 300 pt taller.
    expect(history[1].height).toBe(324);
    expect(prepared.anchors['now-on-wall']?.[0].height).toBe(35);
  });
});

describe('island placeholder', () => {
  const climb = { name: 'Rock & Roll', grade: 'V5', setter: 'x', frames: 'p1r1' };

  it('mirrors the Live Activity: climb name, "N of M · angle", grade, and Prev / bulb / mirror / Next', () => {
    const { svg, thumbnail } = islandOverlaySvg(climb, { index: 3, total: 12, angle: 40 }, '#F03E3E');
    expect(svg).toContain('Rock &amp; Roll');
    expect(svg).toContain('3 of 12 \u00B7 40\u00B0');
    expect(svg).toContain('>V5<');
    expect(svg).toContain('Prev');
    expect(svg).toContain('Next');
    expect(svg).toContain('PLACEHOLDER ISLAND');
    expect(thumbnail.width).toBeGreaterThan(0);
  });

  it('points the static anchors at the drawn buttons, all on screen', () => {
    const take = SHOWCASE_PLACEHOLDER_TAKES['lock-screen'];
    expect(take.source.kind).toBe('island');
    expect(take.anchors['lock-relight']).toEqual(ISLAND_LAYOUT.bulb);
    expect(take.anchors['lock-mirror']).toEqual(ISLAND_LAYOUT.mirror);
    expect(take.anchors['lock-next']).toEqual(ISLAND_LAYOUT.next);
    for (const name of ['lock-next', 'lock-relight', 'lock-mirror'] as const) {
      expect(anchorOnScreen(take.anchors[name] ?? null, PLACEHOLDER_SCREEN), name).toBe(true);
    }
  });

  it('cuts the take from the two climbs, switching on the Next tap', () => {
    const take = SHOWCASE_PLACEHOLDER_TAKES['lock-screen'];
    if (take.source.kind !== 'island') throw new Error('island placeholder expected');
    const args = buildPlaceholderFootageArgs('lock-screen', take, '/f/island', ['/s/a.png', '/s/b.png']);
    expect(args).toContain('/s/a.png');
    expect(args).toContain('/s/b.png');
    expect(args[args.indexOf('-t') + 1]).toBe(take.source.nextAt.toFixed(3));
    expect(args[args.indexOf('-filter_complex') + 1]).toMatch(/concat=n=2/);
    expect(() => buildPlaceholderFootageArgs('lock-screen', take, '/f/island', [])).toThrow(/two island screens/);
  });

  it('marks drawn footage so only a placeholder render shows it', () => {
    expect(SHOWCASE_DRAWN_PLACEHOLDER_MARKER).toMatch(/PLACEHOLDER/);
  });
});

describe('board placeholders', () => {
  it('never draws a board phone: every one is a recording, a store still or a real render', () => {
    for (const takeId of sceneOf('boards').takes) {
      expect(['still', 'render'], takeId).toContain(SHOWCASE_PLACEHOLDER_TAKES[takeId].source.kind);
    }
    expect(SHOWCASE_PLACEHOLDER_TAKES['boards-woods'].source.kind).toBe('render');
  });

  it('asks the public API for the most popular climbs on the board config', () => {
    const board = { boardName: 'woods', layoutId: 1, sizeId: 2, setIds: [1], angle: 40 };
    const request = buildClimbSearchRequest(board);
    expect(request.url).toBe('https://ws.boardsesh.com/graphql');
    const body = JSON.parse(request.body) as { variables: { i: Record<string, unknown> } };
    expect(body.variables.i).toMatchObject({
      boardName: 'woods',
      layoutId: 1,
      sizeId: 2,
      setIds: '1',
      sortBy: 'popular',
    });
    const url = new URL(buildBoardRenderUrl(board, 'p1r12p2r13'));
    expect(url.pathname).toBe('/render/board');
    expect(url.searchParams.get('frames')).toBe('p1r12p2r13');
    expect(url.searchParams.get('render_mode')).toBe('aura');
    expect(url.searchParams.get('field_color')).toBe('#181225');
  });

  it('picks a graded climb whose name fits the header', () => {
    const climb = (name: string, difficulty: string) => ({ name, difficulty, frames: 'p1r1', setter_username: 'x' });
    expect(
      pickPlaceholderClimb([
        climb('Ungraded', ''),
        climb('A name far too long for the header', '6a/V3'),
        climb(' Iceman ', '6a/V3'),
      ]),
    ).toEqual({ name: 'Iceman', grade: 'V3', setter: 'x', frames: 'p1r1' });
    expect(pickPlaceholderClimb([climb('Font only', '6a')])).toBeNull();
    expect(
      pickPlaceholderClimbs([climb('One', 'V1'), climb('Two', 'V2'), climb('Three', 'V3')], 2).map((c) => c.name),
    ).toEqual(['One', 'Two']);
  });
});

describe('island scene', () => {
  it('zooms onto the island and lays its callouts out at the zoomed pose, after the zoom settles', () => {
    const staging = SHOWCASE_SCENE_STAGING['lock-screen'];
    if (!staging) throw new Error('island staging missing');
    expect(staging.zoomPose).toBe('ISLAND');
    const island = sceneOf('lock-screen');
    const timings = calloutTimings(island, island.callouts, resolvedEdit('lock-screen'));
    expect(timings['lock-next']?.enter).toBeGreaterThan(SHOWCASE_CHOREO.calloutStart + staging.calloutDelay - 1);
    expect(copy['lock-screen'].callouts).toMatchObject({ 'lock-relight': 'Reconnect board' });
    expect(copy['lock-screen'].headline).not.toMatch(/unlock/i);
  });

  it('drops 9:16 pills below the boxes when the zoomed phone leaves no room at the sides', () => {
    const phone = { x: 200, y: 500, width: 680, height: 1400 };
    const pills = layoutPortraitPills(
      [
        { x: 600, y: 700, width: 120, height: 60 },
        { x: 380, y: 700, width: 60, height: 60 },
        { x: 450, y: 700, width: 60, height: 60 },
      ],
      { width: 1080, height: 1920 },
      phone,
    );
    expect(pills.map((pill) => pill.exit)).toEqual(['bottom', 'bottom', 'bottom']);
    expect(pills.map((pill) => pill.side)).toEqual(['right', 'left', 'left']);
    // Left side: the box nearest the left edge gets the nearest pill, so the risers never cross.
    expect(pills[1].y).toBeLessThan(pills[2].y);
    expect(pills[0].y).toBe(pills[1].y);
    pills.forEach((pill) => expect(pill.y).toBeGreaterThan(760));
  });
});

describe('callout legibility', () => {
  it('renders labels at a readable size when the cut plays 390 CSS px wide', () => {
    expect(calloutLabelCssPx('16x9')).toBeGreaterThanOrEqual(7);
    expect(calloutLabelCssPx('9x16')).toBeGreaterThanOrEqual(11);
    expect(calloutLabelCssPx('16x9')).toBeCloseTo(7.3, 1);
    expect(calloutLabelCssPx('9x16')).toBeCloseTo(11.6, 1);
  });

  it('keeps every 16:9 pill column clear of the phone and every 9:16 pill inside the canvas', () => {
    const calloutPose = SHOWCASE_POSES['16x9'].CALLOUT;
    expect(SHOWCASE_CALLOUT_LAYOUT.gutterX).toBeGreaterThan(calloutPose.cx + 214 * calloutPose.scale);
    const portrait = SHOWCASE_POSES['9x16'].CALLOUT;
    const sideRoom = 540 - 214 * portrait.scale;
    // A side pill may overlap the rim and bezel (13 px), never the screen.
    expect(
      SHOWCASE_CALLOUT_LAYOUT.portraitPillInset + SHOWCASE_CALLOUT_LAYOUT.portraitPillWidth - sideRoom,
    ).toBeLessThanOrEqual(13 * portrait.scale + 1);
  });
});

describe('the edit', () => {
  it('fills every scene exactly with footage, and every callout window sits in a range the scene plays', () => {
    for (const takeId of Object.keys(SHOWCASE_TAKE_EDITS) as ShowcaseTakeId[]) {
      const scene = SHOWCASE_SCENES.find((candidate) => candidate.takes.includes(takeId));
      if (!scene) throw new Error(`no scene for ${takeId}`);
      const edit = resolvedEdit(takeId);
      expect(segmentsLength(edit.segments), takeId).toBe(scene.endFrame - scene.startFrame);
      for (const [from, to] of edit.segments) expect(to, takeId).toBeGreaterThan(from);
      for (const [name, window] of Object.entries(edit.callouts)) {
        expect(scene.callouts, `${takeId}/${name}`).toContain(name);
        expect(localAtFootage(edit.segments, window[0]), `${takeId}/${name}`).not.toBeNull();
      }
    }
  });

  it('reads only marks the recorder documents for each take', () => {
    for (const [takeId, edit] of Object.entries(SHOWCASE_TAKE_EDITS)) {
      if (!edit) continue;
      for (const mark of marksNeeded(edit))
        expect(DOCUMENTED_MARKS[takeId as ShowcaseTakeId], `${takeId}/${mark}`).toContain(mark);
    }
  });

  it('places cuts on marks: a re-record that moves every mark moves the cut, not its length', () => {
    const edit = SHOWCASE_TAKE_EDITS['lock-screen'];
    if (!edit) throw new Error('island edit missing');
    const island = sceneOf('lock-screen');
    const length = island.endFrame - island.startFrame;
    const early = resolveTakeEdit('lock-screen', edit, { 'island-expanded': 10, 'next-tapped': 13 }, length, 600);
    const late = resolveTakeEdit('lock-screen', edit, { 'island-expanded': 12, 'next-tapped': 15 }, length, 600);
    expect(late.segments.map(([from, to]) => [from - 60, to - 60])).toEqual(early.segments);
    // Expanded island first, then the cut to Next and ~2.5 s of the new climb.
    expect(early.segments[0][0]).toBe(300 - 9);
    expect(early.segments[1]).toEqual([390 - 36, 390 - 36 + length - 45]);
    expect(early.segments[1][1] - 390).toBeGreaterThanOrEqual(75);
  });

  it('fails clearly when a mark is missing or a segment runs off the footage', () => {
    const edit = SHOWCASE_TAKE_EDITS['lock-screen'];
    if (!edit) throw new Error('island edit missing');
    const island = sceneOf('lock-screen');
    const length = island.endFrame - island.startFrame;
    expect(() => resolveTakeEdit('lock-screen', edit, { 'island-expanded': 10 }, length, 600)).toThrow(
      /"lock-screen" is missing mark\(s\) next-tapped/,
    );
    expect(() =>
      resolveTakeEdit('lock-screen', edit, { 'island-expanded': 10, 'next-tapped': 13 }, length, 400),
    ).toThrow(/runs off its 400 footage frames/);
  });

  it('resolves anchor shifts and the rest pill against marks', () => {
    const log = resolvedEdit('log');
    // scrolled 5.005 s (frame 150) - 1.5 s; filter-kilter 10.252 s (frame 308) - 1.2 s.
    expect(log.anchorShifts['activity-calendar']).toEqual([
      { from: 105, dy: -338 },
      { from: 272, dy: -415 },
    ]);
    const crew = resolvedEdit('crew');
    expect(crew.anchorShifts['invite-qr']).toEqual([{ from: 0, dy: 405 }]);
    const workouts = resolvedEdit('workouts');
    expect(workouts.restPill.map(([, value]) => value)).toEqual(['0:29', '0:28', '0:26', '0:25']);
    const first = workouts.restPill[0][0];
    expect(localAtFootage(workouts.segments, first)).not.toBeNull();
  });

  it("holds a range's last frame for its hold, in both the Node and the stage copy", () => {
    const segments = [
      [10, 20, 5],
      [100, 110],
    ] as const;
    expect(segmentsLength(segments)).toBe(25);
    expect(footageAt(segments, 9, 500)).toBe(19);
    expect(footageAt(segments, 12, 500)).toBe(19);
    expect(footageAt(segments, 14, 500)).toBe(19);
    expect(footageAt(segments, 15, 500)).toBe(100);
    expect(localAtFootage(segments, 105)).toBe(20);
    const held = [[400, 418, 12]] as const;
    expect(footageAt(held, 40, 418)).toBe(417);
    for (const ranges of [segments, held, [[10, 20]] as const]) {
      for (let local = -12; local < 60; local += 1) {
        expect(stageFootageAt(ranges, local, 418), `local ${local}`).toBe(footageAt(ranges, local, 418));
      }
    }
  });

  it('holds the last frame when a scene runs a little past its take, and still fails a long overrun', () => {
    const edit: TakeEdit = { segments: [{ mark: 'start', from: 0 }] };
    const short = resolveTakeEdit('spray', edit, { start: 5 }, 120, 150 + 100);
    expect(short.segments).toEqual([[150, 250, 20]]);
    expect(short.warnings[0]).toMatch(/ends 20 frames before its scene/);
    expect(() => resolveTakeEdit('spray', edit, { start: 5 }, 120 + SHOWCASE_MAX_TAIL_HOLD_FRAMES, 150 + 100)).toThrow(
      /runs off its 250 footage frames/,
    );
    const hold: TakeEdit = {
      segments: [
        { mark: 'start', from: 0, to: 1, hold: 0.5 },
        { mark: 'start', from: 2 },
      ],
    };
    expect(resolveTakeEdit('spray', hold, { start: 5 }, 90, 400).segments).toEqual([
      [150, 180, 15],
      [210, 255],
    ]);
  });

  it('maps scene frames to footage across hard cuts, and back', () => {
    const segments = [
      [10, 20],
      [100, 110],
    ] as const;
    expect(footageAt(segments, 0, 500)).toBe(10);
    expect(footageAt(segments, 9, 500)).toBe(19);
    expect(footageAt(segments, 10, 500)).toBe(100);
    expect(footageAt(segments, -5, 500)).toBe(5);
    expect(footageAt(segments, 25, 500)).toBe(115);
    expect(footageAt(segments, 25, 112)).toBe(111);
    expect(localAtFootage(segments, 105)).toBe(15);
    expect(localAtFootage(segments, 50)).toBeNull();
  });

  it('moves sheet- and scroll-measured anchors piecewise, keeping the original times', () => {
    const shifted = applyAnchorShifts(
      [
        { t: 2.7, x: 0, y: 28, width: 440, height: 112 },
        { t: 2.9, x: 0, y: 72, width: 440, height: 112 },
      ],
      [
        { from: 0, dy: 462 },
        { from: 240, dy: 145 },
      ],
    );
    expect(shifted.map((sample) => [sample.t, sample.y])).toEqual([
      [0, 490],
      [2.7, 490],
      [2.9, 534],
      [8, 217],
    ]);
  });

  it('gives windowed callouts their own entrance and exit', () => {
    const crew = sceneOf('crew');
    const timings = calloutTimings(crew, crew.callouts, resolvedEdit('crew'));
    const enters = crew.callouts.map((name) => timings[name]?.enter ?? -1);
    expect(enters[1]).toBeGreaterThan(enters[0]);
    expect(enters[2]).toBeGreaterThan(enters[1]);
    for (const name of crew.callouts) {
      const timing = timings[name];
      if (!timing) throw new Error(name);
      expect(timing.exit - timing.enter, name).toBeGreaterThanOrEqual(26);
    }
  });
});

describe('no flat frames', () => {
  it('never fills the stage with a mix of two backgrounds, only one colour revealed over the other', () => {
    const { backgroundLeadIn, backgroundLeadOut } = SHOWCASE_CHOREO;
    let transitions = 0;
    for (let frame = 0; frame < SHOWCASE_TOTAL_FRAMES; frame += 1) {
      const background = backgroundAt(SHOWCASE_SCENES, frame, backgroundLeadIn, backgroundLeadOut);
      expect(['dark', 'light']).toContain(background.from);
      expect(['dark', 'light']).toContain(background.to);
      expect(background.amount).toBeGreaterThanOrEqual(0);
      expect(background.amount).toBeLessThanOrEqual(1);
      if (background.from !== background.to) transitions += 1;
    }
    // Six background changes (spray, wall, crew, workouts, island, log), 10 frames each.
    expect(transitions).toBe(6 * (backgroundLeadIn + backgroundLeadOut));
  });

  it('reveals the crew scene over the wall scene where the grey frame was', () => {
    const crew = sceneOf('crew');
    const mid = backgroundAt(SHOWCASE_SCENES, crew.startFrame, 4, 6);
    expect(mid).toMatchObject({ from: 'dark', to: 'light' });
    expect(backgroundAt(SHOWCASE_SCENES, crew.startFrame + 6, 4, 6)).toEqual({ from: 'light', to: 'light', amount: 1 });
    expect(backgroundAt(SHOWCASE_SCENES, crew.startFrame - 5, 4, 6)).toEqual({ from: 'dark', to: 'dark', amount: 1 });
  });

  it('flags a flat fill and passes a real frame', () => {
    expect(isFlatFrame(new Uint8Array(48 * 27).fill(122))).toBe(true);
    const phoneOnGrey = new Uint8Array(48 * 27).fill(122);
    for (let y = 5; y < 22; y += 1) for (let x = 20; x < 28; x += 1) phoneOnGrey[y * 48 + x] = 10;
    expect(isFlatFrame(phoneOnGrey)).toBe(false);
    expect(isFlatFrame([])).toBe(true);
  });
});

describe('the loop closer', () => {
  const start = SHOWCASE_TOTAL_FRAMES - SHOWCASE_CHOREO.loopCloserFrames + 6;
  const last = SHOWCASE_TOTAL_FRAMES - 1;

  it('lands every neat phone on the last frame exactly where frame 0 has it', () => {
    for (const format of ['16x9', '9x16'] as const) {
      const { BOARDS_LEFT, BOARDS_MID, BOARDS_RIGHT } = SHOWCASE_POSES[format];
      const drop = SHOWCASE_CANVAS[format].height * 0.9;
      for (const slot of [BOARDS_LEFT, BOARDS_MID, BOARDS_RIGHT]) {
        // Frame 0 shows the phone in its slot; so must the last frame, to the last bit.
        expect(closerPose(slot, last, start, last, drop), format).toEqual(slot);
        expect(Object.is(closerPose(slot, last, start, last, drop).cy, slot.cy)).toBe(true);
      }
    }
  });

  it('brings them up from below the canvas, easing out, never past the slot', () => {
    for (const format of ['16x9', '9x16'] as const) {
      const canvas = SHOWCASE_CANVAS[format];
      const slot = SHOWCASE_POSES[format].BOARDS_MID;
      const drop = canvas.height * 0.9;
      const from = closerPose(slot, start, start, last, drop);
      // The whole phone (900 px tall before scaling) starts under the bottom edge.
      expect(from.cy - 450 * slot.scale, format).toBeGreaterThan(canvas.height);
      expect(from).toMatchObject({ cx: slot.cx, scale: slot.scale, rz: slot.rz });
      let previous = from.cy;
      for (let frame = start + 1; frame <= last; frame += 1) {
        const { cy } = closerPose(slot, frame, start, last, drop);
        expect(cy, `${format} frame ${frame}`).toBeLessThanOrEqual(previous);
        expect(cy, `${format} frame ${frame}`).toBeGreaterThanOrEqual(slot.cy);
        previous = cy;
      }
      // Most of the way up with a third of the frames to go: it settles in, it does not snap.
      const late = closerPose(slot, last - 6, start, last, drop);
      expect(late.cy - slot.cy, format).toBeLessThan(drop * 0.05);
    }
  });
});

describe('web posters and the lite encode', () => {
  it('opens the web cut and its poster on frame 0, the settled boards trio; --poster-frame still rotates', () => {
    expect(SHOWCASE_WEB_POSTER_FRAME).toBe(0);
    expect(sceneOf('boards').startFrame).toBe(0);
    expect(parseRenderArgs([]).posterFrame).toBe(SHOWCASE_WEB_POSTER_FRAME);
    // Unrotated by default, so the web cut plays the loop as the masters do.
    expect(webRotation(SHOWCASE_WEB_POSTER_FRAME).join(' ')).not.toMatch(/trim=/);
    expect(parseRenderArgs(['--poster-frame', '105']).posterFrame).toBe(105);
    const [homepage] = SHOWCASE_TARGETS.homepage.renditions;
    expect(homepage.deliverable).toMatchObject({
      kind: 'web-lite',
      poster: `${SHOWCASE_WEB_POSTER_DIR}/showcase-hero-9x16.webp`,
      webm: `${SHOWCASE_WEB_VIDEO_DIR}/showcase-9x16-lite.webm`,
      mp4: `${SHOWCASE_WEB_VIDEO_DIR}/showcase-9x16-lite.mp4`,
      posterFrame: SHOWCASE_WEB_POSTER_FRAME,
    });
  });

  it('sizes the lite encode to its caps', () => {
    expect(SHOWCASE_WEB_LITE.size).toEqual({ width: 720, height: 1280 });
    const seconds = webCutSeconds();
    for (const max of [SHOWCASE_WEB_LITE.maxWebmBytes, SHOWCASE_WEB_LITE.maxMp4Bytes]) {
      expect((webBitrateFor(max, seconds) * 1000 * seconds) / 8).toBeLessThan(max * 0.9);
    }
  });
});

describe('stage geometry and motion edge cases', () => {
  it('draws no leader for no points and a bare move for one', () => {
    expect(orthoPath([])).toBe('');
    expect(orthoPath([{ x: 3, y: 4 }])).toBe('M3.00 4.00');
    // Points that collapse to one (under half a pixel apart) are one point.
    expect(
      orthoPath([
        { x: 3, y: 4 },
        { x: 3.2, y: 4.1 },
      ]),
    ).toBe('M3.00 4.00');
    expect(
      orthoPath([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toBe('M0.00 0.00 L10.00 0.00');
    expect(
      orthoPath([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 50 },
      ]),
    ).toBe('M0.00 0.00 L90.00 0.00 Q100.00 0.00 100.00 10.00 L100.00 50.00');
  });

  /** RK4 over x'' = -2ζωx' - ω²(x - 1), from rest at 0: the ODE the spring solves. */
  function integrate(seconds: number, zeta: number, period: number): number {
    const omega = (2 * Math.PI) / period;
    const steps = Math.ceil(seconds * 4000);
    const dt = seconds / steps;
    let x = 0;
    let v = 0;
    const accel = (position: number, velocity: number) => -2 * zeta * omega * velocity - omega * omega * (position - 1);
    for (let step = 0; step < steps; step += 1) {
      const k1x = v;
      const k1v = accel(x, v);
      const k2x = v + (dt / 2) * k1v;
      const k2v = accel(x + (dt / 2) * k1x, v + (dt / 2) * k1v);
      const k3x = v + (dt / 2) * k2v;
      const k3v = accel(x + (dt / 2) * k2x, v + (dt / 2) * k2v);
      const k4x = v + dt * k3v;
      const k4v = accel(x + dt * k3x, v + dt * k3v);
      x += (dt / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
      v += (dt / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
    }
    return x;
  }

  it('matches a numerical integration in all three damping regimes', () => {
    for (const zeta of [0.3, 0.55, 0.78, 1, 1.4, 2.5]) {
      for (const period of [0.42, 0.55]) {
        for (const seconds of [0.05, 0.13, 0.3, 0.6, 1.2]) {
          expect(spring(seconds, { zeta, period }), `ζ ${zeta}, T ${period}, t ${seconds}`).toBeCloseTo(
            integrate(seconds, zeta, period),
            6,
          );
        }
      }
    }
  });

  it('keeps the under-damped spring the stage uses (ζ 0.78) bit-for-bit unchanged', () => {
    // The formula the stage has always used for ζ < 1; the rendered video depends on it.
    const before = (seconds: number, zeta: number, period: number) => {
      if (seconds <= 0) return 0;
      const omega = (2 * Math.PI) / period;
      const damped = omega * Math.sqrt(1 - zeta * zeta);
      const decay = Math.exp(-zeta * omega * seconds);
      return 1 - decay * (Math.cos(damped * seconds) + ((zeta * omega) / damped) * Math.sin(damped * seconds));
    };
    for (let frame = 0; frame <= 90; frame += 1) {
      expect(Object.is(spring(frame / 30), before(frame / 30, 0.78, 0.55)), `frame ${frame}`).toBe(true);
      expect(Object.is(spring(frame / 30, { zeta: 0.55, period: 0.42 }), before(frame / 30, 0.55, 0.42))).toBe(true);
      expect(Object.is(spring(frame / 30, { zeta: 0.62, period: 0.42 }), before(frame / 30, 0.62, 0.42))).toBe(true);
      expect(Object.is(spring(frame / 30, { zeta: 0.5, period: 0.5 }), before(frame / 30, 0.5, 0.5))).toBe(true);
    }
  });
});
