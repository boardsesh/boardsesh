#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureTutorial } from './lib/instructional-video/capture';
import { resolveAndroidApk } from './mobile-android-apk';
import { startTutorialDemo, type TutorialDemo } from './lib/instructional-video/demo';
import { tutorialEpisode } from './lib/instructional-video/episodes';
import { TUTORIAL_REPO_ROOT, TUTORIAL_WORK_ROOT } from './lib/instructional-video/paths';
import { buildTutorialCuts, selectedChapters } from './lib/instructional-video/timeline';
import { assertTutorialReleaseClean, tutorialModifiedSourcePaths } from './lib/instructional-video/source';
import type { TutorialPlatform } from './lib/instructional-video/types';
import { renderTutorial, writeTutorialRecordingPack } from '../packages/web/scripts/render-instructional-video';

export type TutorialArguments = Readonly<{
  episode: string;
  platform: TutorialPlatform;
  workRoot: string;
  only?: readonly string[];
  draft: boolean;
  dryRun: boolean;
  recordOnly: boolean;
  renderOnly: boolean;
  recordingPack: boolean;
  recapture: boolean;
  serial?: string;
  apkPath?: string;
  audioDir?: string;
  music?: string;
  sourceRef?: string;
  help: boolean;
}>;
export function parseTutorialArguments(argv: readonly string[]): TutorialArguments {
  const argumentsMap = new Map<string, string>();
  const switches = new Set<string>();
  const flags = new Set(['draft', 'dry-run', 'record-only', 'render-only', 'recording-pack', 'recapture', 'help']);
  const values = new Set([
    'episode',
    'platform',
    'work-dir',
    'only',
    'serial',
    'apk-path',
    'audio-dir',
    'music',
    'source-ref',
  ]);
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--') continue;
    const name = argv[index].replace(/^--/, '');
    if (!argv[index].startsWith('--') || (!flags.has(name) && !values.has(name)))
      throw new Error(`Unknown tutorial argument ${argv[index]}. Use --help.`);
    if (switches.has(name) || argumentsMap.has(name)) throw new Error(`Repeated argument --${name}.`);
    if (flags.has(name)) switches.add(name);
    else {
      const argument = argv[++index];
      if (!argument || argument.startsWith('--')) throw new Error(`--${name} requires a value.`);
      argumentsMap.set(name, argument);
    }
  }
  const platform = argumentsMap.get('platform') ?? 'android';
  if (platform !== 'android' && platform !== 'ios') throw new Error('--platform must be android or ios.');
  if (switches.has('record-only') && switches.has('render-only'))
    throw new Error('Choose --record-only or --render-only.');
  const only = argumentsMap.get('only')?.split(',');
  if (only?.some((id) => !id)) throw new Error('--only needs comma-separated chapter IDs.');
  return {
    episode: argumentsMap.get('episode') ?? 'evergreen',
    platform,
    workRoot: resolve(argumentsMap.get('work-dir') ?? TUTORIAL_WORK_ROOT),
    only,
    draft: switches.has('draft'),
    dryRun: switches.has('dry-run'),
    recordOnly: switches.has('record-only'),
    renderOnly: switches.has('render-only'),
    recordingPack: switches.has('recording-pack'),
    recapture: switches.has('recapture'),
    serial: argumentsMap.get('serial'),
    apkPath: argumentsMap.get('apk-path'),
    audioDir: argumentsMap.get('audio-dir'),
    music: argumentsMap.get('music'),
    sourceRef: argumentsMap.get('source-ref'),
    help: switches.has('help'),
  };
}

async function main(): Promise<void> {
  const options = parseTutorialArguments(process.argv.slice(2));
  if (options.help) {
    console.log(
      'vp run video:tutorial -- [--draft] [--episode evergreen|release-2.6.0] [--only crew,workouts,search,spray,progress]\n  --recording-pack       Write human narration prompts; no capture/render\n  --dry-run              Print cuts and prerequisites; no runtime or rendering\n  --record-only          Capture app footage only\n  --render-only          Reuse captured footage\n  --apk-path <file>      Cached Android dev-client APK\n  --audio-dir <dir>      Named human recordings (WAV, M4A, MP3)\n  --music <file>         Supplied music bed (required for final)\n  --source-ref <commit>  Pin release footage to a reviewed source commit\n  --work-dir <dir>       Override .boardsesh/tutorial-videos\n  --recapture           Replace this pipeline’s takes\n  --platform android|ios (iOS capture remains a separate follow-up)',
    );
    return;
  }
  const episode = tutorialEpisode(options.episode);
  selectedChapters(episode, options.only);
  const packDirectory = writeTutorialRecordingPack(episode, options.workRoot);
  console.log(`Human recording pack: ${resolve(packDirectory, 'recording-pack.md')}`);
  if (options.recordingPack) return;
  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          episode: episode.id,
          platform: options.platform,
          draft: options.draft,
          cuts: buildTutorialCuts(episode, new Map(), options.only).map((cut) => ({
            id: cut.id,
            seconds: cut.totalFrames / 30,
            beats: cut.beats.map((beat) => beat.id),
          })),
          prerequisites: [
            'Dedicated Android emulator + dev-client APK',
            'Maestro, ffmpeg, ffprobe, Chromium',
            'Isolated local Docker demo',
            ...(options.draft ? [] : ['Human recordings and supplied music']),
            ...(episode.releaseVersion ? ['Reviewed source ref; crew-notes capture (issue #6335)'] : []),
          ],
        },
        null,
        2,
      ),
    );
    return;
  }
  const sourceRef = options.sourceRef
    ? execFileSync('git', ['rev-parse', '--verify', `${options.sourceRef}^{commit}`], {
        cwd: TUTORIAL_REPO_ROOT,
        encoding: 'utf8',
      }).trim()
    : undefined;
  if (episode.releaseVersion && !sourceRef)
    throw new Error('Release video requires --source-ref. Complete its reviewed capture recipe first (#6335).');
  if (episode.releaseVersion) {
    const missingFlows = episode.takes
      .filter((take) => !options.only || options.only.includes(take.chapterId))
      .flatMap((take) => [take.flow, ...(take.setupFlows ?? [])])
      .filter((flow) => !existsSync(resolve(TUTORIAL_REPO_ROOT, flow)));
    if (missingFlows.length)
      throw new Error(
        `Release ${episode.releaseVersion} capture recipe is incomplete (#6335). Add the reviewed flows first: ${missingFlows.join(', ')}.`,
      );
  }
  if (
    sourceRef &&
    !options.renderOnly &&
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: TUTORIAL_REPO_ROOT, encoding: 'utf8' }).trim() !== sourceRef
  )
    throw new Error('Capture must run from the worktree at --source-ref.');
  if (episode.releaseVersion && !options.renderOnly && sourceRef) {
    assertTutorialReleaseClean(tutorialModifiedSourcePaths(TUTORIAL_REPO_ROOT, sourceRef));
  }
  if (!options.renderOnly) {
    const notesDirectory = resolve(TUTORIAL_REPO_ROOT, '.boardsesh');
    mkdirSync(notesDirectory, { recursive: true });
    writeFileSync(
      resolve(notesDirectory, 'qa-notes.md'),
      '1. Open the tutorial demo → Alex and four tutorial walls appear.\n2. Join Alex’s session → Sam contributes a climb with his avatar.\n3. Start a workout → logging starts rest, then advances the queue.\n4. Open the spray wall → the photo and highlighted holds appear.\n5. Open progress → personal grades and multiple boards appear.\n',
    );
    const controller = new AbortController();
    const interrupt = (signal: 'SIGINT' | 'SIGTERM') => {
      if (controller.signal.aborted) return;
      process.exitCode = signal === 'SIGINT' ? 130 : 143;
      controller.abort(new Error(`Tutorial capture interrupted by ${signal}.`));
    };
    const onInterrupt = () => interrupt('SIGINT');
    const onTerminate = () => interrupt('SIGTERM');
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    let demo: TutorialDemo | undefined;
    try {
      const apkPath = options.apkPath ?? (options.platform === 'android' ? resolveAndroidApk().apkPath : undefined);
      demo = await startTutorialDemo(options.workRoot, controller.signal);
      console.log(`Tutorial backend: ${demo.backendUrl}`);
      await captureTutorial({
        episode,
        platform: options.platform,
        workRoot: options.workRoot,
        chapterIds: options.only,
        serial: options.serial,
        apkPath,
        recapture: options.recapture,
        backendUrl: demo.backendUrl,
        env: demo.env,
        signal: controller.signal,
      });
    } finally {
      try {
        await demo?.stop();
      } finally {
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onTerminate);
      }
    }
    controller.signal.throwIfAborted();
  }
  if (!options.recordOnly)
    console.log(
      `Review outputs: ${await renderTutorial({ episode, platform: options.platform, workRoot: options.workRoot, chapterIds: options.only, draft: options.draft, audioDir: options.audioDir, music: options.music, sourceRef })}`,
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (process.exitCode !== 130 && process.exitCode !== 143) process.exitCode = 1;
  });
