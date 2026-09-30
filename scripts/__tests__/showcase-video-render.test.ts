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
  SHOWCASE_STAGE_COPY,
  SHOWCASE_WEB_MAX_BYTES,
  anchorOnScreen,
  assignLeaderGutters,
  buildMasterArgs,
  buildMezzanineArgs,
  buildPlaceholderFootageArgs,
  buildWebMp4PassArgs,
  buildWebmPassArgs,
  calloutSlots,
  classifyGlowPixel,
  countWords,
  detectLitHolds,
  footageFrameIndex,
  layoutPortraitPills,
  layoutSceneCallouts,
  orderHoldsForClimb,
  parseHeadline,
  parseRenderArgs,
  placeholderAnchorsFile,
  projectPhonePoint,
  readingBudgetReport,
  resolveSceneCallouts,
  screenToCanvas,
  showcaseOutputs,
  stillFramesForScene,
  webBitrateKbps,
  webCutSeconds,
  type ShowcaseCopy,
} from '../lib/showcase-video/render';
import { SHOWCASE_SCENES, SHOWCASE_TOTAL_FRAMES } from '../lib/showcase-video/timeline';

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
    const { callouts, warnings } = resolveSceneCallouts(crew, file, copy.crew.callouts);
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
    const { callouts, warnings } = resolveSceneCallouts(light, file, copy.light.callouts);
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
  it('uses the storyboard pill slots', () => {
    expect(calloutSlots(2)).toEqual([420, 660]);
    expect(calloutSlots(3)).toEqual([360, 540, 720]);
    expect(calloutSlots(0)).toEqual([]);
  });

  it('staggers leader gutters so stacked leaders never overlap', () => {
    const starts = [
      { x: 960, y: 290 },
      { x: 1280, y: 370 },
      { x: 1290, y: 480 },
    ];
    const gutters = assignLeaderGutters(starts, [360, 540, 720]);
    expect(new Set(gutters).size).toBe(3);
    // The lower leaders drop further left of the upper ones, or their verticals would share x.
    expect(gutters[2]).toBeLessThan(gutters[1]);
    gutters.forEach((gutter) => expect(gutter).toBeLessThanOrEqual(1340));
  });

  it('keeps a lone leader on the nominal gutter', () => {
    expect(assignLeaderGutters([{ x: 1200, y: 500 }], [540])).toEqual([1340]);
  });

  it('alternates 9:16 pills left and right and keeps same-side pills apart', () => {
    const pills = layoutPortraitPills(
      [
        { x: 300, y: 800, width: 40, height: 40 },
        { x: 700, y: 820, width: 40, height: 40 },
        { x: 300, y: 830, width: 40, height: 40 },
      ],
      1920,
    );
    expect(pills.map((pill) => pill.side)).toEqual(['left', 'right', 'left']);
    expect(pills[2].y - pills[0].y).toBeGreaterThanOrEqual(76);
  });

  it('lays out every placeholder callout in both formats', () => {
    for (const format of ['16x9', '9x16'] as const) {
      for (const sceneId of ['light', 'crew'] as const) {
        const scene = sceneOf(sceneId);
        const take = scene.takes[0];
        const file = placeholderAnchorsFile(take, SHOWCASE_PLACEHOLDER_TAKES[take]);
        const callouts = layoutSceneCallouts(format, scene.callouts, file, copy[sceneId].callouts);
        expect(callouts.map((callout) => callout.role)).toEqual(['start', 'hand', 'finish'].slice(0, callouts.length));
        callouts.forEach((callout) => expect(callout.label).toBe(copy[sceneId].callouts[callout.name]));
      }
    }
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
      if (scene.id !== 'light' && scene.id !== 'crew') continue;
      for (const name of scene.callouts) expect(copy[scene.id].callouts[name]).toBeTruthy();
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

  it('targets a bitrate that lands the web cut under the 1.8 MB gate', () => {
    const seconds = webCutSeconds();
    expect(seconds).toBeCloseTo((SHOWCASE_TOTAL_FRAMES - 1) / 30);
    const kbps = webBitrateKbps(SHOWCASE_WEB_MAX_BYTES, seconds);
    expect((kbps * 1000 * seconds) / 8).toBeLessThan(SHOWCASE_WEB_MAX_BYTES);
    expect(SHOWCASE_WEB_MAX_BYTES).toBeLessThan(2_000_000);
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
