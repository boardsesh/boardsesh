import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  anchorAt as stageAnchorAt,
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
  SHOWCASE_WEB_BITRATE_KBPS,
  SHOWCASE_WEB_MAX_BYTES,
  SHOWCASE_CALLOUT_LAYOUT,
  SHOWCASE_SCENE_STAGING,
  anchorOnScreen,
  buildBoardRenderUrl,
  buildClimbSearchRequest,
  calloutLabelCssPx,
  calloutTime,
  pickPlaceholderClimb,
  boardTakeLabel,
  buildMasterArgs,
  buildMezzanineArgs,
  buildPlaceholderFootageArgs,
  buildWebMp4PassArgs,
  buildWebmPassArgs,
  calloutSlots,
  classifyGlowPixel,
  contrastRatio,
  countWords,
  detectLitHolds,
  expectedWebBytes,
  footageFrameIndex,
  layoutPortraitPills,
  layoutSceneCallouts,
  orderHoldsForClimb,
  parseHeadline,
  parseRenderArgs,
  pileupArrivalFrames,
  placeholderAnchorsFile,
  placeholderCardSvg,
  planBoards,
  planLeaders,
  prepareAnchorsFile,
  projectPhonePoint,
  readingBudgetReport,
  resolveSceneCallouts,
  sceneCalloutCopy,
  screenToCanvas,
  showcaseOutputs,
  stillFramesForScene,
  webCutSeconds,
  workoutTickFrames,
  type ShowcaseCopy,
} from '../lib/showcase-video/render';
import { SHOWCASE_SCENES, SHOWCASE_TOTAL_FRAMES } from '../lib/showcase-video/timeline';
import type { ShowcaseTakeId } from '../lib/showcase-video/contract';

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
    const light = sceneOf('light');
    const file = placeholderAnchorsFile('light', {
      source: { kind: 'video', file: 'x.mp4', seek: 0 },
      anchors: {
        'wall-pill': { x: 500, y: 20, width: 40, height: 20 },
        'board-surface': { x: 20, y: 200, width: 400, height: 500 },
      },
    });
    const { callouts, warnings } = resolveSceneCallouts(light, file, sceneCalloutCopy(copy, 'light'));
    expect(callouts).toEqual(['board-surface']);
    expect(warnings[0]).toMatch(/off screen/);
  });

  it('lines footage up one second ahead of its scene and clamps at the ends', () => {
    const light = sceneOf('light');
    expect(footageFrameIndex(light, light.startFrame, 200)).toBe(30);
    expect(footageFrameIndex(light, 0, 200)).toBe(0);
    expect(footageFrameIndex(light, 10_000, 200)).toBe(199);
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
        const callouts = layoutSceneCallouts(format, scene.id, scene.callouts, file, labels);
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

describe('reading budget', () => {
  it('counts words, not punctuation', () => {
    expect(countWords('Free, no ads. iOS & Android.')).toBe(5);
    expect(countWords('Your board.\nLit from your *phone.*'.replace(/\*/g, ''))).toBe(6);
  });

  it('gives every scene at least 0.3 s per visible word', () => {
    for (const report of readingBudgetReport(copy)) {
      expect(report.haveFrames, `${report.sceneId}: ${report.words} words`).toBeGreaterThanOrEqual(report.needFrames);
    }
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

describe('lit-hold detection', () => {
  function frame(width: number, height: number, blobs: { x: number; y: number; rgb: [number, number, number] }[]) {
    const pixels = new Uint8Array(width * height * 3).fill(30);
    for (const blob of blobs) {
      for (let y = blob.y - 3; y <= blob.y + 3; y += 1) {
        for (let x = blob.x - 3; x <= blob.x + 3; x += 1) pixels.set(blob.rgb, (y * width + x) * 3);
      }
    }
    return pixels;
  }

  it('classifies the three role glows and ignores foot amber and grey', () => {
    expect(classifyGlowPixel(0, 255, 0)).toBe('start');
    expect(classifyGlowPixel(77, 245, 253)).toBe('hand');
    expect(classifyGlowPixel(255, 0, 255)).toBe('finish');
    expect(classifyGlowPixel(255, 170, 0)).toBeNull();
    expect(classifyGlowPixel(128, 128, 128)).toBeNull();
  });

  it('finds each glow blob, ordered start → hands bottom-up → finish', () => {
    const pixels = frame(100, 100, [
      { x: 20, y: 20, rgb: [255, 0, 255] },
      { x: 50, y: 40, rgb: [77, 245, 253] },
      { x: 60, y: 70, rgb: [77, 245, 253] },
      { x: 70, y: 90, rgb: [0, 255, 0] },
      { x: 80, y: 80, rgb: [255, 170, 0] },
    ]);
    const holds = detectLitHolds(pixels, 100, 100, 3);
    expect(holds.map((hold) => hold.role)).toEqual(['start', 'hand', 'hand', 'finish']);
    expect(holds[0].x).toBeCloseTo(70);
    expect(holds[1].y).toBeCloseTo(70);
  });

  it('only looks inside the region it is given', () => {
    const pixels = frame(100, 100, [
      { x: 20, y: 20, rgb: [0, 255, 0] },
      { x: 70, y: 70, rgb: [0, 255, 0] },
    ]);
    expect(detectLitHolds(pixels, 100, 100, 3, { x: 50, y: 50, width: 50, height: 50 })).toHaveLength(1);
  });

  it('orders finishes left to right', () => {
    const ordered = orderHoldsForClimb([
      { x: 9, y: 1, role: 'finish' },
      { x: 1, y: 1, role: 'finish' },
    ]);
    expect(ordered.map((hold) => hold.x)).toEqual([1, 9]);
  });
});

describe('stills', () => {
  it('leads each sheet with the settled frame and covers the loop seam', () => {
    const hook = stillFramesForScene(sceneOf('hook'));
    expect(hook[0]).toEqual({ frame: 0, label: 'settled' });
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
  const outputs = showcaseOutputs('16x9');

  it('writes the web cut where the static-asset catalog looks', () => {
    expect(outputs.webWebm).toBe(`${SHOWCASE_WEB_VIDEO_DIR}/showcase.webm`);
    expect(outputs.webMp4).toBe(`${SHOWCASE_WEB_VIDEO_DIR}/showcase.mp4`);
    expect(outputs.poster).toBe(`${SHOWCASE_WEB_POSTER_DIR}/showcase-poster.webp`);
    expect(showcaseOutputs('9x16').webWebm).toBe(`${SHOWCASE_WEB_VIDEO_DIR}/showcase-9x16.webm`);
    expect(showcaseOutputs('9x16').poster).toBe(`${SHOWCASE_WEB_POSTER_DIR}/showcase-poster-9x16.webp`);
    expect(outputs.master.endsWith('/out/brag.mp4')).toBe(true);
    expect(outputs.masterStill.endsWith('/out/brag.jpg')).toBe(true);
  });

  it('targets a bitrate that leaves the web cut well under its 4 MB gate', () => {
    const seconds = webCutSeconds();
    expect(seconds).toBeCloseTo((SHOWCASE_TOTAL_FRAMES - 1) / 30);
    expect(SHOWCASE_WEB_MAX_BYTES).toBe(4_000_000);
    // Two-pass rate control lands within a few per cent; keep 20% for container and overshoot.
    expect(expectedWebBytes(SHOWCASE_WEB_BITRATE_KBPS, seconds)).toBeLessThan(SHOWCASE_WEB_MAX_BYTES * 0.8);
  });

  it('downscales the 2x screenshots with lanczos into a near-lossless RGB mezzanine', () => {
    const args = buildMezzanineArgs('16x9', '/w/m.mkv');
    expect(args).toContain('image2pipe');
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=1920:1080:flags=lanczos');
    expect(args[args.indexOf('-c:v', args.indexOf('-vf')) + 1]).toBe('libx264rgb');
    expect(buildMezzanineArgs('9x16', '/w/m.mkv')).toContain('scale=1080:1920:flags=lanczos');
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
    // The master keeps frame 0; only the web cut drops it.
    expect(args.join(' ')).not.toMatch(/trim=/);
  });

  it('encodes the webm as two-pass VP9 with row-mt, from frame 1', () => {
    const encode = { input: '/w/m.mkv', output: '/o/s.webm', bitrateKbps: 600, passLog: '/w/pass' };
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
    expect(second[second.indexOf('-vf') + 1]).toMatch(/^trim=start_frame=1,/);
  });

  it('encodes the mp4 as H.264 with faststart, BT.709, and an optional 720p fallback', () => {
    const encode = { input: '/w/m.mkv', output: '/o/s.mp4', bitrateKbps: 600, passLog: '/w/pass' };
    const second = buildWebMp4PassArgs(encode, 2);
    expect(second[second.indexOf('-c:v') + 1]).toBe('libx264');
    expect(second[second.indexOf('-movflags') + 1]).toBe('+faststart');
    expect(second[second.indexOf('-colorspace') + 1]).toBe('bt709');
    expect(second).toContain('-an');
    expect(second[second.indexOf('-vf') + 1]).not.toMatch(/1280/);
    const fallback = buildWebMp4PassArgs({ ...encode, size: { width: 1280, height: 720 } }, 2);
    expect(fallback[fallback.indexOf('-vf') + 1]).toMatch(/scale=1280:720:flags=lanczos/);
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
    const args = buildPlaceholderFootageArgs('light', SHOWCASE_PLACEHOLDER_TAKES.light, '/f/light');
    expect(args[args.indexOf('-vf') + 1]).toMatch(/^fps=30,scale=800:-2:flags=lanczos,tpad=stop_mode=clone/);
    expect(args[args.indexOf('-frames:v') + 1]).toBe(String(Math.ceil(((192 - 72) / 30 + 2) * 30)));
    expect(args[args.length - 1]).toBe('/f/light/%05d.jpg');
    const still = buildPlaceholderFootageArgs('boards-kilter', SHOWCASE_PLACEHOLDER_TAKES['boards-kilter'], '/f/k');
    expect(still.slice(0, 6)).toContain('-loop');
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
    expect(plan.main).toBe('boards-tension');
    expect(plan.neatCount).toBe(3);
    expect(plan.final).toHaveLength(8);
    expect(plan.final.slice(3, 5)).toEqual(['boards-tension', 'boards-soill']);
    expect(plan.labels['boards-soill']).toBe('So iLL');
    expect(boardTakeLabel('boards-moonboard')).toBe('MoonBoard');
  });

  it('carries on with whichever boards were recorded', () => {
    const recorded = new Set<ShowcaseTakeId>(['boards-kilter', 'boards-moonboard', 'boards-decoy']);
    const plan = planBoards(boards.takes, recorded);
    expect(plan.arrival).toEqual(['boards-kilter', 'boards-moonboard', 'boards-decoy']);
    // No Tension: the first neat arrival becomes the persistent phone.
    expect(plan.main).toBe('boards-kilter');
    expect(plan.arrivalFrames).toHaveLength(3);
    expect(() => planBoards(boards.takes, new Set())).toThrow(/at least one board/);
  });

  it('brings the neat three in with the scene change and the rest in fast, the last after a beat', () => {
    const frames = pileupArrivalFrames(8, 3, 1);
    expect(frames.slice(0, 3)).toEqual([-2, -4, 3]);
    expect(frames.slice(3, 7)).toEqual([40, 46, 52, 58]);
    // The squeeze waits one gap plus a pause.
    expect(frames[7]).toBe(69);
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
    expect(ticks[ticks.length - 1]).toBeLessThan(settleEnd - 20);
    expect(copy.workouts.restCountdown[0]).toBe(copy.workouts.rows[3].rest);
  });
});

describe('anchor preparation', () => {
  it('sorts samples and grows header-only anchors over the list below', () => {
    const prepared = prepareAnchorsFile({
      takeId: 'wall',
      screen: { width: 440, height: 956 },
      anchors: {
        'wall-history': [
          { t: 2, x: 8, y: 400, width: 424, height: 24 },
          { t: 0, x: 8, y: 800, width: 424, height: 24 },
        ],
        'now-on-wall': [{ t: 0, x: 132, y: 81, width: 230, height: 35 }],
      },
    });
    const history = prepared.anchors['wall-history'] ?? [];
    expect(history.map((sample) => sample.t)).toEqual([0, 2]);
    // Clamped to 24 pt above the bottom of the screen...
    expect(history[0].y + history[0].height).toBe(956 - 24);
    // ...otherwise 300 pt taller.
    expect(history[1].height).toBe(324);
    expect(prepared.anchors['now-on-wall']?.[0].height).toBe(35);
  });
});

describe('placeholder cards', () => {
  it('draws the island with the buttons its static anchors point at, escaped', () => {
    const take = SHOWCASE_PLACEHOLDER_TAKES['lock-screen'];
    if (take.source.kind !== 'card') throw new Error('lock-screen placeholder should be a card');
    const svg = placeholderCardSvg(take.source.card);
    expect(svg).toContain('Boardsesh session');
    expect(svg).toContain('>Next<');
    for (const name of ['lock-next', 'lock-relight', 'lock-mirror'] as const) {
      expect(anchorOnScreen(take.anchors[name] ?? null, PLACEHOLDER_SCREEN), name).toBe(true);
    }
    expect(placeholderCardSvg({ ...take.source.card, title: 'A & <B>' })).toContain('A &amp; &lt;B&gt;');
  });
});

describe('board placeholders', () => {
  it('never gives a board phone a generated card: every one is a recording, a store still or a real render', () => {
    for (const takeId of sceneOf('boards').takes) {
      expect(SHOWCASE_PLACEHOLDER_TAKES[takeId].source.kind, takeId).not.toBe('card');
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
  });
});

describe('island scene', () => {
  it('zooms onto the island and lays its callouts out at the zoomed pose, after the zoom settles', () => {
    const staging = SHOWCASE_SCENE_STAGING['lock-screen'];
    if (!staging) throw new Error('island staging missing');
    expect(staging.zoomPose).toBe('ISLAND');
    expect(calloutTime('lock-screen')).toBeGreaterThan(calloutTime('crew'));
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
