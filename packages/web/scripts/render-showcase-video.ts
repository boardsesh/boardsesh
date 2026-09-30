#!/usr/bin/env node
/**
 * Renders the homepage showcase video from the stage in marketing/showcase-video/.
 *
 * Every frame is a pure function of its number: the stage exposes
 * `window.renderAt(frame)`, this script screenshots Chromium at 2x for each
 * frame and pipes the PNGs through a lanczos downscale into a near-lossless
 * mezzanine, and every deliverable (brag.mp4, the web encodes, the posters) is
 * cut from that mezzanine.
 *
 * Not a Playwright test project, for the same reason as capture-design-mockups:
 * a file:// page needs no dev server, database or signed-in user.
 *
 * Usage: vp run video:render [-- --target <name>|all] [--stills] [--measure] [--from-frame <n>]
 *                            [--format 16x9|9x16] [--placeholder-footage] [--skip-web] [--no-donation-line]
 */
import { chromium, type Page } from '@playwright/test';
import sharp from 'sharp';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  HOLD_STATE_MAP,
  V_GRADE_COLORS,
  getHoldDisplayColor,
  getVGradeColor,
  readableTextColor,
  type HoldStateInfo,
} from '@boardsesh/board-constants';
import { brandColors, brandColorsDark, materialSurfaces } from '@boardsesh/velvet-tokens';
import { themeTokens } from '../app/theme/theme-config';
import {
  SHOWCASE_FPS,
  SHOWCASE_OUT_DIR,
  SHOWCASE_MARKS_DIR,
  SHOWCASE_TAKE_IDS,
  type ShowcaseMarksFile,
  type ShowcaseAnchorsFile,
  type ShowcaseCalloutName,
  type ShowcaseTakeId,
} from '../../../scripts/lib/showcase-video/contract';
import {
  SHOWCASE_OPTIONAL_TAKES,
  SHOWCASE_POSTER_FRAME,
  SHOWCASE_SCENES,
  resolveTimeline,
  type ShowcaseTimeline,
  type ShowcaseScene,
} from '../../../scripts/lib/showcase-video/timeline';
import {
  SHOWCASE_CAPTION_BAR,
  SHOWCASE_CHOREO,
  SHOWCASE_DEVICE_SCALE,
  SHOWCASE_LIGHT_ROLE_COLORS,
  SHOWCASE_FRAMES_DIR,
  SHOWCASE_PERSPECTIVE,
  SHOWCASE_PHONE,
  SHOWCASE_PLACEHOLDER_TAKES,
  SHOWCASE_SHARE_COPY,
  SHOWCASE_STAGE_COPY,
  SHOWCASE_STAGE_HOLDS,
  SHOWCASE_FULL_BLEED_HTML,
  SHOWCASE_STAGE_HTML,
  SHOWCASE_STAGE_TOKENS,
  SHOWCASE_STILLS_DIR,
  SHOWCASE_TAKE_LEAD_FRAMES,
  SHOWCASE_WEB_POSTER_FRAME,
  isFlatFrame,
  webBitrateFor,
  SHOWCASE_WEB_MAX_BYTES,
  SHOWCASE_WORKOUT_BEATS,
  SHOWCASE_SCENE_STAGING,
  SHOWCASE_TAKE_EDITS,
  SHOWCASE_DRAWN_PLACEHOLDER_MARKER,
  anchorsFilePath,
  buildBoardRenderUrl,
  buildClimbSearchRequest,
  buildAppPreviewArgs,
  buildDurationProbeArgs,
  buildFramePngArgs,
  buildMasterArgs,
  buildStreamProbeArgs,
  cutIntermediates,
  fullBleedStillFrames,
  buildMezzanineArgs,
  buildPlaceholderFootageArgs,
  buildWebMp4PassArgs,
  buildWebmPassArgs,
  detectLitHolds,
  footageTakeDir,
  layoutSceneCallouts,
  parseRenderArgs,
  placeholderAnchorsFile,
  islandOverlaySvg,
  pickPlaceholderClimbs,
  planBoards,
  prepareAnchorsFile,
  readingBudgetReport,
  readingBudgetMet,
  formatReadingBudgetTable,
  withoutDonationLine,
  renderedBoardScreen,
  sceneCalloutCopy,
  resolveSceneCallouts,
  stillFramesForScene,
  webCutSeconds,
  footageAt,
  takeSegments,
  localAtFootage,
  resolveTakeEdit,
  type ResolvedTakeEdit,
  workoutTickFrames,
  type CalloutStage,
  type FullBleedClipData,
  type FullBleedStageData,
  type LitHold,
  type PlaceholderBoardRender,
  type PlaceholderClimb,
  type PlaceholderTake,
  type IslandQueue,
  type RenderArgs,
  type ShowcaseCopy,
  type ShowcaseStageData,
  type StillFrame,
  type StageBoards,
  type StageCallout,
  type StageTake,
} from '../../../scripts/lib/showcase-video/render';
import { FFMPEG_BIN, FFPROBE_BIN, HELP_CLIP_POSTER_ENCODE } from '../../../scripts/lib/help-clips';
import {
  SHOWCASE_TARGET_NAMES,
  appPreviewProblems,
  assertTargetLength,
  parseStreamProbe,
  selectTargets,
  textOutsideSafeArea,
  type TargetSelection,
  type ProbedMedia,
  type ShowcaseDeliverable,
  type ShowcaseRendition,
  type ShowcaseTarget,
  type TextBox,
} from '../../../scripts/lib/showcase-video/targets';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..');
const MARK_PATH = resolve(REPO_ROOT, 'packages/mobile/assets/splash-icon.png');
const execFileAsync = promisify(execFile);
const FRAME_BUFFER_MAX_BYTES = 256 * 1024 * 1024;

const USAGE = `Usage: vp run video:render [-- <flags>]

Renders the showcase video's targets from marketing/showcase-video/ and the recorded takes.

  --target <name>        One target, repeatable or comma-separated: ${SHOWCASE_TARGET_NAMES.join(', ')};
                         all for every one. Default: homepage + social (what vp run video ships).
                         Outputs: docs/showcase-video.md, "Targets"
  --stills               Contact sheets only (settled + mid-transition frames per scene)
                         → ${relative(REPO_ROOT, SHOWCASE_STILLS_DIR)}/
  --poster-frame <n>     Frame the web cut opens on and its poster shows (default ${SHOWCASE_WEB_POSTER_FRAME}; brag.* keep frame 0)
  --frame <n>            One frame as a full-size PNG → ${relative(REPO_ROOT, SHOWCASE_STILLS_DIR)}/
  --measure              Draw every anchor box over the footage (debug; never ships)
  --from-frame <n>       Start at frame n (writes a preview, skips the web encodes)
  --format 16x9|9x16     Only the renditions of one format (default: all)
  --placeholder-footage  Rebuild stand-in footage + anchors from the committed help
                         clips, store screenshots and generated cards before rendering
  --skip-web             Leave out the homepage target (the lite hero encodes and poster)
  --no-donation-line     Leave "Paid for by the climbers who use it." out of every target's outro
                         (store and ad targets never have it); leaves out the homepage
  --help                 Show this message`;

const log = (message: string) => console.log(`[video:render] ${message}`);
const warn = (message: string) => console.warn(`[video:render] warning: ${message}`);

// --- footage -----------------------------------------------------------------------

const PLACEHOLDER_CACHE_DIR = resolve(SHOWCASE_FRAMES_DIR, '../placeholder-cache');

type CachedClimb = Readonly<{ climb: PlaceholderClimb; imagePath: string }>;

/**
 * The board's `count` most popular graded climbs and their `/render/board`
 * images, from the cache when present (so a re-render works offline).
 */
async function fetchPlaceholderClimbs(
  cacheKey: string,
  board: PlaceholderBoardRender,
  count: number,
): Promise<CachedClimb[]> {
  mkdirSync(PLACEHOLDER_CACHE_DIR, { recursive: true });
  const paths = Array.from({ length: count }, (_, index) => ({
    climbPath: resolve(PLACEHOLDER_CACHE_DIR, `${cacheKey}${count > 1 ? `-${index}` : ''}.json`),
    imagePath: resolve(PLACEHOLDER_CACHE_DIR, `${cacheKey}${count > 1 ? `-${index}` : ''}.png`),
  }));
  if (paths.some(({ climbPath, imagePath }) => !existsSync(climbPath) || !existsSync(imagePath))) {
    const request = buildClimbSearchRequest(board);
    const response = await fetch(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: request.body,
    });
    if (!response.ok) throw new Error(`searchClimbs answered ${response.status}`);
    const payload = (await response.json()) as {
      data?: { searchClimbs?: { climbs?: Parameters<typeof pickPlaceholderClimbs>[0] } };
    };
    const climbs = pickPlaceholderClimbs(payload.data?.searchClimbs?.climbs ?? [], count);
    if (climbs.length < count) throw new Error(`only ${climbs.length} graded climbs to show`);
    for (const [index, climb] of climbs.entries()) {
      const image = await fetch(buildBoardRenderUrl(board, climb.frames));
      if (!image.ok) throw new Error(`/render/board answered ${image.status}`);
      writeFileSync(paths[index].imagePath, Buffer.from(await image.arrayBuffer()));
      writeFileSync(paths[index].climbPath, `${JSON.stringify(climb, null, 2)}\n`);
    }
  }
  return paths.map(({ climbPath, imagePath }) => ({
    climb: JSON.parse(readFileSync(climbPath, 'utf8')) as PlaceholderClimb,
    imagePath,
  }));
}

/** A dark, app-like screen around a real board render, optionally under the drawn island. */
async function composeBoardScreen(cached: CachedClimb, output: string, queue?: IslandQueue): Promise<void> {
  const boardImage = sharp(readFileSync(cached.imagePath));
  const { width, height } = await boardImage.metadata();
  const screen = renderedBoardScreen(cached.climb, { width, height });
  const layers: sharp.OverlayOptions[] = [
    {
      input: await boardImage.clone().resize(screen.board.width, screen.board.height).png().toBuffer(),
      left: screen.board.left,
      top: screen.board.top,
    },
  ];
  if (queue) {
    const gradeColor = getVGradeColor(cached.climb.grade) ?? '#A78BFA';
    const island = islandOverlaySvg(cached.climb, queue, gradeColor);
    layers.push({ input: Buffer.from(island.svg), left: 0, top: 0 });
    const thumbnail = await boardImage
      .clone()
      .resize(island.thumbnail.width, island.thumbnail.height, { fit: 'cover' })
      .png()
      .toBuffer();
    layers.push({ input: thumbnail, left: island.thumbnail.left, top: island.thumbnail.top });
  }
  await sharp(Buffer.from(screen.svg)).composite(layers).png().toFile(output);
}

/**
 * The screens a generated placeholder take is cut from: one board render, or
 * for the drawn island the climb before and after the Next tap. Null when the
 * render cannot be fetched; the take then has no footage and sits out.
 */
async function placeholderScreens(takeId: ShowcaseTakeId, take: PlaceholderTake): Promise<string[] | null> {
  const { source } = take;
  if (source.kind !== 'render' && source.kind !== 'island') return [];
  mkdirSync(SHOWCASE_FRAMES_DIR, { recursive: true });
  try {
    if (source.kind === 'render') {
      const [cached] = await fetchPlaceholderClimbs(takeId, source.board, 1);
      const output = resolve(SHOWCASE_FRAMES_DIR, `placeholder-${takeId}.png`);
      await composeBoardScreen(cached, output);
      return [output];
    }
    const climbs = await fetchPlaceholderClimbs(takeId, source.board, 2);
    const outputs: string[] = [];
    for (const [index, cached] of climbs.entries()) {
      const output = resolve(SHOWCASE_FRAMES_DIR, `placeholder-${takeId}-${index}.png`);
      await composeBoardScreen(cached, output, { ...source.queue, index: source.queue.index + index });
      outputs.push(output);
    }
    return outputs;
  } catch (error) {
    warn(`${takeId}: no board render (${error instanceof Error ? error.message : 'failed'}); it sits out the cut`);
    return null;
  }
}

function describePlaceholder(take: PlaceholderTake): string {
  const { source } = take;
  if (source.kind === 'render') return `a ${source.board.boardName} /render/board climb`;
  if (source.kind === 'island') return `a DRAWN island over ${source.board.boardName} /render/board climbs`;
  return source.file;
}

/** Written into every generated take directory; a directory without it holds real footage. */
const PLACEHOLDER_MARKER = 'PLACEHOLDER';

async function buildPlaceholderFootage(): Promise<void> {
  for (const takeId of SHOWCASE_TAKE_IDS) {
    const take = SHOWCASE_PLACEHOLDER_TAKES[takeId];
    const dir = footageTakeDir(takeId);
    // Never overwrite a recording: only a directory this flag made is rebuilt.
    if (countFrames(dir) > 0 && !existsSync(resolve(dir, PLACEHOLDER_MARKER))) {
      log(`placeholder ${takeId}: real footage in place, left alone`);
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(anchorsFilePath(takeId), { force: true });
    const screens = await placeholderScreens(takeId, take);
    if (!screens) continue;
    mkdirSync(dir, { recursive: true });
    await execFileAsync(FFMPEG_BIN, buildPlaceholderFootageArgs(takeId, take, dir, screens));
    for (const screen of screens) rmSync(screen, { force: true });
    writeFileSync(resolve(dir, PLACEHOLDER_MARKER), 'Generated by --placeholder-footage.\n');
    // A drawn stand-in is marked, so only a --placeholder-footage run shows it.
    if (take.source.kind === 'island') {
      writeFileSync(resolve(dir, SHOWCASE_DRAWN_PLACEHOLDER_MARKER), 'Drawn placeholder: never in the final cut.\n');
    }
    mkdirSync(dirname(anchorsFilePath(takeId)), { recursive: true });
    writeFileSync(anchorsFilePath(takeId), `${JSON.stringify(placeholderAnchorsFile(takeId, take), null, 2)}\n`);
    log(`placeholder ${takeId}: ${countFrames(dir)} frames from ${describePlaceholder(take)}`);
  }
}

function sceneOfTake(takeId: ShowcaseTakeId): ShowcaseScene {
  const scene = SHOWCASE_SCENES.find((candidate) => candidate.takes.includes(takeId));
  if (!scene) throw new Error(`No scene uses take "${takeId}"`);
  return scene;
}

function countFrames(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((name) => /^\d{5}\.jpg$/.test(name)).length;
}

const isPlaceholder = (takeId: ShowcaseTakeId) => existsSync(resolve(footageTakeDir(takeId), PLACEHOLDER_MARKER));

/**
 * A recorded take's marks (`work/marks/<take>.json`), or null for a generated
 * placeholder (it has none). A recorded take whose marks file is missing stops
 * the render.
 */
function readMarks(takeId: ShowcaseTakeId): Record<string, number> | null {
  if (isPlaceholder(takeId)) return null;
  const path = resolve(SHOWCASE_MARKS_DIR, `${takeId}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `Missing marks for take "${takeId}": ${relative(REPO_ROOT, path)}. Re-record it with video:record.`,
    );
  }
  const file = JSON.parse(readFileSync(path, 'utf8')) as ShowcaseMarksFile;
  if (file.takeId !== takeId || typeof file.marks !== 'object')
    throw new Error(`${path} is not a marks file for "${takeId}"`);
  return file.marks;
}

/**
 * The take's edit resolved against its recorded marks for a scene of
 * `sceneLength` frames. A take with no edit (the boards) or a generated
 * placeholder (no marks) plays from one second in. Missing marks stop the render.
 */
function readEdit(
  takeId: ShowcaseTakeId,
  frameCount: number,
  sceneLength = sceneOfTake(takeId).endFrame - sceneOfTake(takeId).startFrame,
): ResolvedTakeEdit | undefined {
  const edit = SHOWCASE_TAKE_EDITS[takeId];
  if (!edit) return undefined;
  const marks = readMarks(takeId);
  if (!marks) return undefined;
  const resolved = resolveTakeEdit(takeId, edit, marks, sceneLength, frameCount);
  resolved.warnings.forEach(warn);
  return resolved;
}

function readAnchors(takeId: ShowcaseTakeId, edit: ResolvedTakeEdit | undefined): ShowcaseAnchorsFile {
  const path = anchorsFilePath(takeId);
  if (!existsSync(path)) throw new Error(`Missing anchors for take "${takeId}": ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ShowcaseAnchorsFile;
  if (parsed.takeId !== takeId || !parsed.screen || !parsed.anchors) {
    throw new Error(`${path} is not a ShowcaseAnchorsFile for "${takeId}"`);
  }
  // Sorted, moved by the edit's sheet and scroll corrections, header-only anchors grown: once, here.
  return prepareAnchorsFile(parsed, edit?.anchorShifts);
}

/**
 * Every take with footage. A missing board take is skipped (the pile-up uses
 * the boards that were recorded); any other missing take stops the render.
 */
function loadTakes(allowDrawnPlaceholders: boolean): {
  takes: Partial<Record<ShowcaseTakeId, StageTake>>;
  anchors: Partial<Record<ShowcaseTakeId, ShowcaseAnchorsFile>>;
  edits: Partial<Record<ShowcaseTakeId, ResolvedTakeEdit>>;
} {
  const drawn = (takeId: ShowcaseTakeId) =>
    existsSync(resolve(footageTakeDir(takeId), SHOWCASE_DRAWN_PLACEHOLDER_MARKER));
  const missing = SHOWCASE_TAKE_IDS.filter(
    (takeId) => countFrames(footageTakeDir(takeId)) === 0 || (drawn(takeId) && !allowDrawnPlaceholders),
  );
  for (const takeId of missing.filter(drawn)) {
    warn(`take "${takeId}" is a drawn placeholder; only a --placeholder-footage render shows it`);
  }
  const required = missing.filter((takeId) => !SHOWCASE_OPTIONAL_TAKES.includes(takeId));
  if (required.length > 0) {
    throw new Error(
      `No footage for ${required.join(', ')} under ${relative(REPO_ROOT, dirname(footageTakeDir('light')))}. ` +
        'Record the takes, or pass --placeholder-footage to build stand-ins from the help clips.',
    );
  }
  for (const takeId of missing) warn(`no footage for optional take "${takeId}"; the cut goes without it`);
  const takes: Partial<Record<ShowcaseTakeId, StageTake>> = {};
  const anchors: Partial<Record<ShowcaseTakeId, ShowcaseAnchorsFile>> = {};
  const edits: Partial<Record<ShowcaseTakeId, ResolvedTakeEdit>> = {};
  for (const takeId of SHOWCASE_TAKE_IDS.filter((candidate) => !missing.includes(candidate))) {
    const frameCount = countFrames(footageTakeDir(takeId));
    const edit = readEdit(takeId, frameCount);
    if (edit) edits[takeId] = edit;
    const file = readAnchors(takeId, edit);
    anchors[takeId] = file;
    takes[takeId] = {
      frameUrlBase: `${pathToFileURL(footageTakeDir(takeId)).href}/`,
      frameCount,
      segments: takeSegments(sceneOfTake(takeId), edit),
      screen: file.screen,
      anchors: file.anchors,
    };
  }
  return { takes, anchors, edits };
}

/**
 * The motif's holds: detected on the light take at the moment the rings land on
 * it, inside the board-surface anchor. Falls back to the hand-traced set.
 */
async function resolveHolds(take: StageTake, anchors: ShowcaseAnchorsFile): Promise<LitHold[]> {
  // Rings land 18 frames after the phone is released at L-4 of the hook.
  const landLocal = 18 - SHOWCASE_CHOREO.backgroundLeadIn;
  const index = footageAt(take.segments, landLocal, take.frameCount);
  const framePath = resolve(footageTakeDir('light'), `${String(index + 1).padStart(5, '0')}.jpg`);
  const { data, info } = await sharp(framePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const toPixels = info.width / anchors.screen.width;
  const surface = anchors.anchors['board-surface']?.[0];
  const region = surface
    ? {
        x: surface.x * toPixels,
        y: surface.y * toPixels,
        width: surface.width * toPixels,
        height: surface.height * toPixels,
      }
    : undefined;
  const detected = detectLitHolds(data, info.width, info.height, info.channels, region, 30).map((hold) => ({
    ...hold,
    x: hold.x / toPixels,
    y: hold.y / toPixels,
  }));
  if (detected.length >= 3) {
    log(`motif: ${detected.length} lit holds detected on light frame ${index + 1}`);
    return detected;
  }
  warn(
    `only ${detected.length} lit holds detected on the light take; using ${relative(REPO_ROOT, SHOWCASE_STAGE_HOLDS)}`,
  );
  return (JSON.parse(readFileSync(SHOWCASE_STAGE_HOLDS, 'utf8')) as { holds: LitHold[] }).holds;
}

// --- tokens ------------------------------------------------------------------------------

function roleColor(name: HoldStateInfo['name'], fallback: string): string {
  const info = Object.values(HOLD_STATE_MAP.kilter).find((state) => state.name === name);
  return info ? getHoldDisplayColor(info, 'aura') : fallback;
}

function writeTokens(): void {
  const tokens: Record<string, string> = {
    'stage-dark': themeTokens.semantic.background,
    'stage-light': '#F4F1FB',
    'ink-dark': materialSurfaces.dark.label,
    'ink-light': materialSurfaces.light.label,
    'sub-dark': materialSurfaces.dark.secondaryLabel,
    'sub-light': materialSurfaces.light.secondaryLabel,
    'accent-dark': materialSurfaces.dark.accent,
    'accent-light': materialSurfaces.light.accent,
    amber: brandColors.accent,
    'glow-dark': brandColorsDark.primaryFill,
    'role-start': roleColor('STARTING', '#00FF00'),
    'role-hand': roleColor('HAND', '#4DF5FD'),
    'role-finish': roleColor('FINISH', '#FF00FF'),
  };
  const lines = Object.entries(tokens).map(([name, value]) => `  --token-${name}: ${value};`);
  const css = `/* Generated by packages/web/scripts/render-showcase-video.ts from @boardsesh/velvet-tokens,\n   @boardsesh/board-constants and the web theme. Do not edit. */\n:root {\n${lines.join('\n')}\n}\n`;
  writeFileSync(SHOWCASE_STAGE_TOKENS, css);
}

function gradeColors(): ShowcaseStageData['grades'] {
  const grades: Record<string, { background: string; ink: string }> = {};
  for (const [grade, background] of Object.entries(V_GRADE_COLORS)) {
    grades[grade] = { background, ink: readableTextColor(background) === '#000000' ? '#16111F' : '#FFFFFF' };
  }
  return grades;
}

// --- stage data --------------------------------------------------------------------------------

/** Everything read from disk once per run: footage, anchors, holds, copy. */
type Footage = Readonly<{
  copy: ShowcaseCopy;
  takes: Partial<Record<ShowcaseTakeId, StageTake>>;
  anchors: Partial<Record<ShowcaseTakeId, ShowcaseAnchorsFile>>;
  holds: LitHold[];
}>;

/** One cut of the motion stage: its timeline, the edits at its scene lengths, and what the stage shows. */
type Prepared = Readonly<{
  copy: ShowcaseCopy;
  takes: Partial<Record<ShowcaseTakeId, StageTake>>;
  anchors: Partial<Record<ShowcaseTakeId, ShowcaseAnchorsFile>>;
  holds: LitHold[];
  callouts: Partial<Record<ShowcaseScene['id'], ShowcaseCalloutName[]>>;
  boards: StageBoards;
  edits: Partial<Record<ShowcaseTakeId, ResolvedTakeEdit>>;
  /** The cut for the footage at hand (a skippable scene without its take is dropped). */
  timeline: ShowcaseTimeline;
}>;

async function loadFootage(allowDrawnPlaceholders: boolean): Promise<Footage> {
  const copy = JSON.parse(readFileSync(SHOWCASE_STAGE_COPY, 'utf8')) as ShowcaseCopy;
  const { takes, anchors } = loadTakes(allowDrawnPlaceholders);
  const light = takes.light;
  const lightAnchors = anchors.light;
  if (!light || !lightAnchors) throw new Error('The light take is required');
  const holds = await resolveHolds(light, lightAnchors);
  return { copy, takes, anchors, holds };
}

/** The motion cut a target asks for: its scenes and lengths, its copy, the edits resolved at those lengths. */
function prepareCut(footage: Footage, target: ShowcaseTarget, donationLine: boolean): Prepared {
  const copy = donationLine ? footage.copy : withoutDonationLine(footage.copy);
  const timeline = resolveTimeline(new Set(Object.keys(footage.takes) as ShowcaseTakeId[]), target.scenes);
  for (const sceneId of timeline.skipped)
    warn(`${target.name}: scene "${sceneId}" has no footage; the cut runs without it`);
  log(
    `${target.name}: ${timeline.scenes.length} scenes, ${timeline.totalFrames} frames (${(timeline.totalFrames / SHOWCASE_FPS).toFixed(1)} s)`,
  );
  const edits: Partial<Record<ShowcaseTakeId, ResolvedTakeEdit>> = {};
  const takes: Partial<Record<ShowcaseTakeId, StageTake>> = { ...footage.takes };
  for (const scene of timeline.scenes) {
    for (const takeId of scene.takes) {
      const take = footage.takes[takeId];
      if (!take) continue;
      const edit = readEdit(takeId, take.frameCount, scene.endFrame - scene.startFrame);
      if (edit) edits[takeId] = edit;
      takes[takeId] = { ...take, segments: takeSegments(scene, edit) };
    }
  }
  const callouts: Prepared['callouts'] = {};
  for (const scene of timeline.scenes) {
    if (scene.callouts.length === 0) continue;
    const resolved = resolveSceneCallouts(
      scene,
      footage.anchors[scene.takes[0]] ?? null,
      sceneCalloutCopy(copy, scene.id),
      edits[scene.takes[0]],
    );
    resolved.warnings.forEach(warn);
    callouts[scene.id] = resolved.callouts;
  }
  const boardsScene = SHOWCASE_SCENES.find((scene) => scene.id === 'boards') as ShowcaseScene;
  const boards = planBoards(boardsScene.takes, new Set(Object.keys(footage.takes) as ShowcaseTakeId[]));
  if (timeline.scenes.some((scene) => scene.id === 'boards')) {
    log(
      `${target.name} boards: ${boards.arrival.length} phones (${boards.arrival.map((takeId) => boards.labels[takeId]).join(', ')})`,
    );
  }
  const budget = readingBudgetReport(copy, timeline.scenes, edits);
  log(`${target.name} reading budget:\n${formatReadingBudgetTable(budget)}`);
  for (const report of budget.filter((candidate) => !readingBudgetMet(candidate))) {
    warn(`${target.name}: reading budget short in "${report.sceneId}"`);
  }
  assertTargetLength(target, timeline.totalFrames);
  return { copy, takes, anchors: footage.anchors, holds: footage.holds, callouts, boards, edits, timeline };
}

/** Scene-local frame the workouts footage's rest pill shows its first value, so the checklist's countdown starts with it. */
function restFromFootage(prepared: Prepared): number | null {
  const edit = prepared.edits.workouts;
  const first = edit?.restPill[0];
  return edit && first ? localAtFootage(edit.segments, first[0]) : null;
}

/** Where a safe area lets 9:16 pill centres sit. */
function pillBand(rendition: ShowcaseRendition): CalloutStage['band'] {
  const area = rendition.safeArea;
  if (!area) return null;
  const half = rendition.stage.callouts.portraitPillHeight / 2 + 6;
  return { top: area.top + half, bottom: rendition.size.height - area.bottom - half };
}

function stageData(prepared: Prepared, rendition: ShowcaseRendition, measure: boolean): ShowcaseStageData {
  const { format, stage } = rendition;
  const { width, height } = rendition.size;
  const calloutStage: CalloutStage = { poses: stage.poses, layout: stage.callouts, band: pillBand(rendition) };
  return {
    format,
    width,
    height,
    fps: SHOWCASE_FPS,
    totalFrames: prepared.timeline.totalFrames,
    perspective: SHOWCASE_PERSPECTIVE,
    measure,
    choreo: SHOWCASE_CHOREO,
    layout: stage.callouts,
    phone: SHOWCASE_PHONE,
    poses: stage.poses,
    headlineTop: stage.headlineTop,
    safeArea: rendition.safeArea,
    scenes: prepared.timeline.scenes.map((scene) => {
      const names = prepared.callouts[scene.id] ?? [];
      const anchorsFile = prepared.anchors[scene.takes[0]];
      const callouts: StageCallout[] =
        names.length > 0 && anchorsFile
          ? layoutSceneCallouts(
              format,
              scene,
              names,
              anchorsFile,
              sceneCalloutCopy(prepared.copy, scene.id),
              prepared.edits[scene.takes[0]],
              calloutStage,
            )
          : [];
      return { ...scene, callouts };
    }),
    takes: prepared.takes,
    boards: prepared.boards,
    workout: workoutTickFrames(
      prepared.copy.workouts.rows.map((row) => row.grade),
      restFromFootage(prepared),
    ),
    workoutBeats: SHOWCASE_WORKOUT_BEATS,
    staging: SHOWCASE_SCENE_STAGING,
    restPill: prepared.edits.workouts?.restPill ?? [],
    lightRoles: SHOWCASE_LIGHT_ROLE_COLORS,
    holds: prepared.holds,
    copy: prepared.copy,
    grades: gradeColors(),
    palette: { stageDark: themeTokens.semantic.background, stageLight: '#F4F1FB' },
    markUrl: pathToFileURL(MARK_PATH).href,
  };
}

/** The full-bleed cut: each clip's footage resolved on its marks, under its caption. */
function fullBleedData(footage: Footage, target: ShowcaseTarget, rendition: ShowcaseRendition, measure: boolean) {
  let frame = 0;
  const clips: FullBleedClipData[] = [];
  for (const clip of target.clips) {
    const take = footage.takes[clip.take];
    if (!take) {
      warn(`${target.name}: no footage for "${clip.take}"; its clip is left out`);
      continue;
    }
    const caption = footage.copy.appStore.captions[clip.caption];
    if (!caption)
      throw new Error(`${target.name}: no caption "${clip.caption}" in ${relative(REPO_ROOT, SHOWCASE_STAGE_COPY)}`);
    const marks = readMarks(clip.take);
    const segments = marks
      ? resolveTakeEdit(clip.take, { segments: clip.segments }, marks, clip.frames, take.frameCount).segments
      : [[SHOWCASE_TAKE_LEAD_FRAMES, SHOWCASE_TAKE_LEAD_FRAMES + clip.frames] as const];
    clips.push({
      startFrame: frame,
      endFrame: frame + clip.frames,
      take: { frameUrlBase: take.frameUrlBase, frameCount: take.frameCount, segments },
      caption,
      captionTop: clip.captionTop,
    });
    frame += clip.frames;
  }
  const seconds = frame / SHOWCASE_FPS;
  log(`${target.name}: ${clips.length} clips, ${frame} frames (${seconds.toFixed(1)} s)`);
  assertTargetLength(target, frame);
  const data: FullBleedStageData = {
    width: rendition.size.width,
    height: rendition.size.height,
    fps: SHOWCASE_FPS,
    totalFrames: frame,
    measure,
    clips,
    bar: SHOWCASE_CAPTION_BAR,
  };
  return data;
}

// --- cuts --------------------------------------------------------------------------------------

/** One rendering of a stage: a page, its data, its size, and every target rendition it feeds. */
type Cut = Readonly<{
  key: string;
  /** For logs and stills: the first target and rendition that asked for it. */
  label: string;
  stillsDir: string;
  html: string;
  size: Readonly<{ width: number; height: number }>;
  data: ShowcaseStageData | FullBleedStageData;
  totalFrames: number;
  safeArea: ShowcaseRendition['safeArea'];
  /** Motion scenes for the stills (empty for full-bleed, which uses its clips). */
  timeline: ShowcaseTimeline | null;
  uses: ReadonlyArray<Readonly<{ target: ShowcaseTarget; rendition: ShowcaseRendition }>>;
}>;

const shortHash = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 10);

/**
 * The cuts to render for the chosen targets. Renditions that would render the
 * same frames (homepage and social 9:16) share one cut, so the browser runs
 * once for both.
 */
async function planCuts(footage: Footage, picks: TargetSelection['picks'], args: RenderArgs): Promise<Cut[]> {
  const cuts = new Map<string, Cut>();
  for (const { target, renditions } of picks) {
    const donationLine = target.donationLine && args.donationLine;
    const prepared = target.layout === 'motion' ? prepareCut(footage, target, donationLine) : null;
    for (const rendition of renditions) {
      const data = prepared
        ? stageData(prepared, rendition, args.measure)
        : fullBleedData(footage, target, rendition, args.measure);
      const key = `${target.layout}-${rendition.id}-${shortHash(data)}`;
      const existing = cuts.get(key);
      if (existing) {
        cuts.set(key, { ...existing, uses: [...existing.uses, { target, rendition }] });
        continue;
      }
      cuts.set(key, {
        key,
        label: `${target.name}/${rendition.id}`,
        stillsDir: resolve(SHOWCASE_STILLS_DIR, target.name),
        html: target.layout === 'motion' ? SHOWCASE_STAGE_HTML : SHOWCASE_FULL_BLEED_HTML,
        size: rendition.size,
        data,
        totalFrames: data.totalFrames,
        safeArea: rendition.safeArea,
        timeline: prepared?.timeline ?? null,
        uses: [{ target, rendition }],
      });
    }
  }
  return [...cuts.values()];
}

// --- browser -----------------------------------------------------------------------------------

async function openStage(cut: Cut) {
  const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--font-render-hinting=none'] });
  // Anything after launch can throw; close the browser so no orphan Chromium keeps the process alive.
  try {
    const { width, height } = cut.size;
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: SHOWCASE_DEVICE_SCALE });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(pathToFileURL(cut.html).href, { waitUntil: 'load' });
    await page.waitForFunction(
      () => (window as unknown as { showcaseStageLoaded?: boolean }).showcaseStageLoaded === true,
      null,
      {
        timeout: 10_000,
      },
    );
    await page.evaluate(
      (input) => {
        (window as unknown as { showcaseInit: (value: unknown) => void }).showcaseInit(input);
      },
      cut.data as unknown as Record<string, unknown>,
    );
    const fonts = await page.evaluate(async () => {
      await Promise.all([
        document.fonts.load('800 104px "Inter Tight"'),
        document.fonts.load('700 24px "Inter Tight"'),
        document.fonts.load('italic 400 120px "Instrument Serif"'),
        document.fonts.load('500 24px "Geist Mono"'),
      ]);
      await document.fonts.ready;
      return [...document.fonts].map((face) => ({ family: face.family.replace(/"/g, ''), status: face.status }));
    });
    for (const family of ['Inter Tight', 'Instrument Serif', 'Geist Mono']) {
      if (!fonts.some((face) => face.family === family && face.status === 'loaded')) {
        throw new Error(`Font "${family}" did not load: ${JSON.stringify(fonts)}`);
      }
    }
    if (errors.length > 0) throw new Error(`Stage errors:\n${errors.join('\n')}`);
    const client = await page.context().newCDPSession(page);
    return { browser, page, client, errors };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function renderFrame(page: Page, frame: number): Promise<void> {
  const failed = await page.evaluate(async (target) => {
    const stage = window as unknown as { renderAt: (value: number) => void; visibleImages: () => HTMLImageElement[] };
    stage.renderAt(target);
    const images = stage.visibleImages();
    const results = await Promise.all(
      images.map((image) =>
        image
          .decode()
          .then(() => null)
          .catch(() => image.getAttribute('src')),
      ),
    );
    return results.filter((value): value is string => value !== null);
  }, frame);
  if (failed.length > 0) throw new Error(`Frame ${frame}: could not decode ${failed.join(', ')}`);
}

type CdpClient = Awaited<ReturnType<typeof openStage>>['client'];

async function capture(client: CdpClient): Promise<Buffer> {
  const { data } = (await client.send('Page.captureScreenshot', {
    format: 'png',
    optimizeForSpeed: true,
    captureBeyondViewport: false,
  })) as { data: string };
  return Buffer.from(data, 'base64');
}

/** Text on the current frame that crosses the cut's safe area, as readable lines. */
async function safeAreaViolations(page: Page, cut: Cut, frame: number): Promise<string[]> {
  if (!cut.safeArea) return [];
  const boxes = await page.evaluate(() => (window as unknown as { textBoxes: () => TextBox[] }).textBoxes());
  return textOutsideSafeArea(boxes, cut.size, cut.safeArea).map(
    (box) =>
      `frame ${frame}: "${box.label}" at ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`,
  );
}

// --- stills --------------------------------------------------------------------------------------

function cutStills(cut: Cut): ReadonlyArray<Readonly<{ group: string; frames: StillFrame[] }>> {
  if (!cut.timeline) {
    const data = cut.data as FullBleedStageData;
    return [{ group: 'clips', frames: fullBleedStillFrames(data.clips) }];
  }
  const data = cut.data as ShowcaseStageData;
  const timeline = cut.timeline;
  return timeline.scenes.map((scene) => {
    const stageScene = data.scenes.find((candidate) => candidate.id === scene.id);
    return { group: scene.id, frames: stillFramesForScene(scene, timeline.totalFrames, stageScene?.callouts ?? []) };
  });
}

async function renderStills(cut: Cut, measure: boolean): Promise<void> {
  mkdirSync(cut.stillsDir, { recursive: true });
  log(`stills for ${cut.label} → ${relative(REPO_ROOT, cut.stillsDir)}/`);
  const { browser, page, client } = await openStage(cut);
  const scale = Math.min(960 / cut.size.width, 768 / cut.size.height);
  const cell = {
    width: Math.round(cut.size.width * scale),
    height: Math.round(cut.size.height * scale),
    columns: cut.size.width > cut.size.height ? 2 : 4,
  };
  const violations: string[] = [];
  const rendition = cut.uses[0].rendition.id;
  try {
    for (const [groupIndex, { group, frames }] of cutStills(cut).entries()) {
      const tiles: sharp.OverlayOptions[] = [];
      for (const [index, still] of frames.entries()) {
        await renderFrame(page, still.frame);
        violations.push(...(await safeAreaViolations(page, cut, still.frame)));
        const shot = await sharp(await capture(client))
          .resize(cell.width, cell.height, { kernel: 'lanczos3' })
          .toBuffer();
        const label = Buffer.from(
          `<svg width="${cell.width}" height="34"><rect width="100%" height="34" fill="rgba(0,0,0,0.6)"/>` +
            `<text x="10" y="23" font-family="Menlo, monospace" font-size="17" fill="#fff">` +
            `${group} · frame ${still.frame} · ${still.label}</text></svg>`,
        );
        const left = (index % cell.columns) * (cell.width + 8);
        const top = Math.floor(index / cell.columns) * (cell.height + 8);
        tiles.push({ input: shot, left, top }, { input: label, left, top });
      }
      const rows = Math.ceil(frames.length / cell.columns);
      const output = resolve(
        cut.stillsDir,
        `${rendition}-${String(groupIndex + 1).padStart(2, '0')}-${group}${measure ? '-measure' : ''}.png`,
      );
      await sharp({
        create: {
          width: Math.min(frames.length, cell.columns) * (cell.width + 8) - 8,
          height: rows * (cell.height + 8) - 8,
          channels: 3,
          background: '#222',
        },
      })
        .composite(tiles)
        .png()
        .toFile(output);
      log(`stills: ${relative(REPO_ROOT, output)}`);
    }
  } finally {
    await browser.close();
  }
  failOnViolations(cut, violations);
}

function failOnViolations(cut: Cut, violations: readonly string[]): void {
  if (violations.length === 0) {
    if (cut.safeArea) log(`${cut.label}: every word inside the safe area`);
    return;
  }
  throw new Error(`${cut.label}: text outside the safe area:\n${violations.slice(0, 20).join('\n')}`);
}

async function renderSingleFrame(cut: Cut, frame: number): Promise<void> {
  if (frame >= cut.totalFrames) throw new Error(`--frame must be below ${cut.totalFrames} for ${cut.label}`);
  mkdirSync(cut.stillsDir, { recursive: true });
  log(`frame ${frame} of ${cut.label} → ${relative(REPO_ROOT, cut.stillsDir)}/`);
  const { width, height } = cut.size;
  const { browser, page, client } = await openStage(cut);
  try {
    await renderFrame(page, frame);
    const output = resolve(cut.stillsDir, `${cut.uses[0].rendition.id}-frame-${String(frame).padStart(4, '0')}.png`);
    await sharp(await capture(client))
      .resize(width, height, { kernel: 'lanczos3' })
      .png()
      .toFile(output);
    log(`frame: ${relative(REPO_ROOT, output)}`);
  } finally {
    await browser.close();
  }
}

// --- full render ------------------------------------------------------------------------------

/** How often a safe-area cut's text is checked during the full render. */
const SAFE_AREA_CHECK_EVERY = 3;

async function renderMezzanine(cut: Cut, fromFrame: number, output: string) {
  mkdirSync(dirname(output), { recursive: true });
  const ffmpeg = spawn(FFMPEG_BIN, buildMezzanineArgs(cut.size, output), { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise<void>((resolvePromise, reject) => {
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
  let pipeError: Error | null = null;
  ffmpeg.stdin.on('error', (error) => {
    pipeError = error;
  });
  const write = (chunk: Buffer) =>
    new Promise<void>((resolvePromise, reject) => {
      if (pipeError) reject(pipeError);
      else if (ffmpeg.stdin.write(chunk)) resolvePromise();
      else ffmpeg.stdin.once('drain', resolvePromise);
    });
  const { browser, page, client } = await openStage(cut);
  const started = Date.now();
  const violations: string[] = [];
  try {
    for (let frame = fromFrame; frame < cut.totalFrames; frame += 1) {
      await renderFrame(page, frame);
      if (frame % SAFE_AREA_CHECK_EVERY === 0) violations.push(...(await safeAreaViolations(page, cut, frame)));
      const png = await capture(client);
      // A flat fill is a render fault (an undecoded screen, a mid-grey crossfade): stop.
      const luma = await sharp(png).resize(48).greyscale().raw().toBuffer();
      if (isFlatFrame(luma)) throw new Error(`${cut.label}: frame ${frame} is a flat fill`);
      await write(png);
      if ((frame + 1) % 60 === 0) {
        const rate = (frame + 1 - fromFrame) / ((Date.now() - started) / 1000);
        log(`${cut.label}: frame ${frame + 1}/${cut.totalFrames} (${rate.toFixed(1)} fps)`);
      }
    }
  } finally {
    ffmpeg.stdin.end();
    await browser.close();
  }
  await done;
  failOnViolations(cut, violations);
}

async function framePng(input: string, frame: number): Promise<Buffer> {
  const { stdout } = await execFileAsync(FFMPEG_BIN, buildFramePngArgs(input, frame), {
    encoding: 'buffer',
    maxBuffer: FRAME_BUFFER_MAX_BYTES,
  });
  return stdout;
}

async function probe(file: string): Promise<string> {
  const { stdout } = await execFileAsync(FFPROBE_BIN, buildDurationProbeArgs(file));
  return stdout.trim().split('\n').join(' ');
}

async function probeStreams(file: string): Promise<ProbedMedia> {
  const { stdout } = await execFileAsync(FFPROBE_BIN, buildStreamProbeArgs(file));
  return parseStreamProbe(stdout);
}

/** Mean absolute difference (0–255) between two frames: the loop seam check. */
async function frameDifference(first: Buffer, second: Buffer): Promise<number> {
  const [a, b] = await Promise.all([first, second].map((png) => sharp(png).removeAlpha().raw().toBuffer()));
  let total = 0;
  for (let index = 0; index < a.length; index += 1) total += Math.abs(a[index] - b[index]);
  return total / a.length;
}

const kb = (bytes: number) => `${(bytes / 1000).toFixed(0)} kB`;

type WebLite = Extract<ShowcaseDeliverable, { kind: 'web-lite' }>;
type Master = Extract<ShowcaseDeliverable, { kind: 'master' }>;
type AppPreview = Extract<ShowcaseDeliverable, { kind: 'app-preview' }>;

/**
 * The homepage hero, 9:16 only: the lite encodes, rotated to open on the
 * poster frame, and that frame as its poster.
 */
async function encodeWeb(
  deliverable: WebLite,
  mezzanine: string,
  passLog: string,
  totalFrames: number,
  posterFrame: number,
): Promise<void> {
  mkdirSync(dirname(deliverable.webm), { recursive: true });
  const seconds = webCutSeconds(totalFrames);
  const lite = [
    { output: deliverable.webm, max: deliverable.maxWebmBytes, build: buildWebmPassArgs },
    { output: deliverable.mp4, max: deliverable.maxMp4Bytes, build: buildWebMp4PassArgs },
  ];
  for (const { output, max, build } of lite) {
    const encode = {
      input: mezzanine,
      output,
      size: deliverable.size,
      startFrame: posterFrame,
      bitrateKbps: webBitrateFor(max, seconds),
      passLog: `${passLog}-lite`,
    };
    await execFileAsync(FFMPEG_BIN, build(encode, 1));
    await execFileAsync(FFMPEG_BIN, build(encode, 2));
    const bytes = statSync(output).size;
    log(`${relative(REPO_ROOT, output)}: ${kb(bytes)} at ${encode.bitrateKbps} kbit/s, from frame ${posterFrame}`);
    if (bytes > Math.min(max, SHOWCASE_WEB_MAX_BYTES)) throw new Error(`${output} is ${bytes} bytes, over ${max}`);
  }

  mkdirSync(dirname(deliverable.poster), { recursive: true });
  await sharp(await framePng(mezzanine, posterFrame))
    .webp(HELP_CLIP_POSTER_ENCODE)
    .toFile(deliverable.poster);
  log(`${relative(REPO_ROOT, deliverable.poster)}: ${kb(statSync(deliverable.poster).size)} (frame ${posterFrame})`);
}

async function encodeMaster(deliverable: Master, target: ShowcaseTarget, mezzanine: string): Promise<void> {
  mkdirSync(dirname(deliverable.video), { recursive: true });
  await execFileAsync(FFMPEG_BIN, buildMasterArgs(mezzanine, deliverable.video, target.audio));
  log(
    `${relative(REPO_ROOT, deliverable.video)}: ${kb(statSync(deliverable.video).size)} (${await probe(deliverable.video)})`,
  );
  await sharp(await framePng(mezzanine, SHOWCASE_POSTER_FRAME))
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(deliverable.still);
  if (deliverable.shareCopy) copyFileSync(SHOWCASE_SHARE_COPY, deliverable.shareCopy);
}

/** The App Preview: one encode, checked against Apple's numbers, copied to each device slot. */
async function encodeAppPreview(
  deliverable: AppPreview,
  target: ShowcaseTarget,
  rendition: ShowcaseRendition,
  mezzanine: string,
): Promise<void> {
  const [first, ...copies] = deliverable.videos;
  mkdirSync(dirname(first), { recursive: true });
  await execFileAsync(FFMPEG_BIN, buildAppPreviewArgs(mezzanine, first, deliverable.videoKbps, target.audio));
  const media = await probeStreams(first);
  const problems = appPreviewProblems(media, rendition.size);
  if (problems.length > 0) throw new Error(`${first} misses Apple's App Preview spec:\n${problems.join('\n')}`);
  log(
    `${relative(REPO_ROOT, first)}: ${kb(media.sizeBytes)}, ${media.video?.width}x${media.video?.height} ` +
      `${media.video?.fps} fps, ${media.durationSeconds.toFixed(2)} s, video ${Math.round((media.video?.kbps ?? 0) / 100) / 10} Mbit/s, ` +
      `audio ${media.audio?.codec} ${media.audio?.channels} ch ${media.audio?.sampleRate} Hz: meets the App Preview spec`,
  );
  for (const copy of copies) {
    copyFileSync(first, copy);
    log(`${relative(REPO_ROOT, copy)}: same file (same resolution slot)`);
  }
  // App Store Connect's default poster frame is 5 s in.
  await sharp(await framePng(mezzanine, 5 * SHOWCASE_FPS))
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(deliverable.still);
}

async function renderCut(cut: Cut, args: RenderArgs): Promise<void> {
  const intermediates = cutIntermediates(cut.key);
  const preview = args.fromFrame > 0 || args.measure;
  const tag = args.measure ? '-measure' : args.fromFrame > 0 ? `-from-${args.fromFrame}` : '';
  const mezzanine = intermediates.mezzanine.replace(/\.mkv$/, `${tag}.mkv`);
  try {
    await renderMezzanine(cut, args.fromFrame, mezzanine);
    if (preview) {
      const output = resolve(SHOWCASE_OUT_DIR, 'preview', `${cut.label.replace('/', '-')}${tag}.mp4`);
      mkdirSync(dirname(output), { recursive: true });
      await execFileAsync(FFMPEG_BIN, buildMasterArgs(mezzanine, output));
      log(`${relative(REPO_ROOT, output)}: ${kb(statSync(output).size)} (${await probe(output)})`);
      return;
    }
    if (cut.timeline) {
      const seam = await frameDifference(
        await framePng(mezzanine, cut.totalFrames - 1),
        await framePng(mezzanine, SHOWCASE_POSTER_FRAME),
      );
      log(`${cut.label}: loop seam (frame ${cut.totalFrames - 1} vs 0) mean difference ${seam.toFixed(2)}/255`);
    }
    for (const { target, rendition } of cut.uses) {
      const { deliverable } = rendition;
      if (deliverable.kind === 'web-lite') {
        await encodeWeb(deliverable, mezzanine, intermediates.passLog, cut.totalFrames, args.posterFrame);
      } else if (deliverable.kind === 'master') await encodeMaster(deliverable, target, mezzanine);
      else await encodeAppPreview(deliverable, target, rendition, mezzanine);
    }
  } finally {
    removeIntermediates(mezzanine, intermediates.passLog);
  }
}

/**
 * The mezzanine (~60–120 MB a cut) and the two-pass logs only exist to feed
 * the encodes. Disk is tight, so they go as soon as the encodes are done, or
 * the render fails.
 */
function removeIntermediates(mezzanine: string, passLog: string): void {
  rmSync(mezzanine, { force: true });
  const dir = dirname(passLog);
  if (!existsSync(dir)) return;
  const prefix = passLog.slice(dir.length + 1);
  for (const name of readdirSync(dir)) if (name.startsWith(prefix)) rmSync(resolve(dir, name), { force: true });
  log(`removed intermediates for ${relative(REPO_ROOT, mezzanine)}`);
}

async function main(): Promise<void> {
  const args = parseRenderArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const { picks, notes } = selectTargets(args);
  notes.forEach(warn);
  if (picks.length === 0) throw new Error('Nothing to render: the flags left out every target');
  log(`targets: ${picks.map(({ target }) => target.name).join(', ')}`);
  mkdirSync(SHOWCASE_FRAMES_DIR, { recursive: true });
  if (args.placeholderFootage) await buildPlaceholderFootage();
  writeTokens();
  const footage = await loadFootage(args.placeholderFootage);
  const cuts = await planCuts(footage, picks, args);
  for (const cut of cuts) {
    log(
      `cut ${cut.label}: ${cut.size.width}x${cut.size.height}, ${cut.totalFrames} frames, for ${cut.uses.map(({ target, rendition }) => `${target.name}/${rendition.id}`).join(' + ')}`,
    );
    if (args.frame !== null) await renderSingleFrame(cut, args.frame);
    else if (args.stills) await renderStills(cut, args.measure);
    else await renderCut(cut, args);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : 'Showcase render failed');
  process.exitCode = 1;
});
