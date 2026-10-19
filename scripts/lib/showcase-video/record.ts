import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  SHOWCASE_ANCHOR_NAMES,
  SHOWCASE_FOOTAGE_WIDTH,
  DEFAULT_SHOWCASE_PLATFORM,
  SHOWCASE_FPS,
  SHOWCASE_PLATFORMS,
  SHOWCASE_TAKE_IDS,
  SHOWCASE_LOCALES,
  SHOWCASE_VARIANT_KINDS,
  type ShowcaseLocale,
  type ShowcaseVariantKind,
  showcaseWorkDirs,
  showcaseVariantWorkDirs,
  type ShowcaseWorkDirs,
  isShowcasePlatform,
  type ShowcasePlatform,
  parseShowcaseAnchorLine,
  type ShowcaseAnchorLogLine,
  type ShowcaseAnchorName,
  type ShowcaseAnchorSample,
  type ShowcaseAnchorsFile,
  type ShowcaseCalloutName,
  type ShowcaseMarksFile,
  type ShowcaseTakeId,
  sortAnchorSamples,
} from './contract';
import type { ShowcaseBackend, ShowcaseBoardKind, ShowcaseStaticAnchor } from './takes';

export type { ShowcaseBackend } from './takes';

/**
 * The recorder's helpers: argument parsing, ffmpeg argument vectors, log
 * parsing and the end-of-run self-check. Everything here is unit tested in
 * `scripts/__tests__/showcase-video-record.test.ts`; the orchestrator
 * (`scripts/showcase-video-record.ts`) owns every process and file; the local
 * signal server here also accepts consent-independent home readiness pings.
 */

/** Keep HTTP readiness callbacks running while escaping an idle iOS dev launcher. */
export async function waitForShowcaseHome(
  options: Readonly<{
    hasReachedHome: () => boolean;
    hasLoadedBundle: () => boolean;
    recoverLauncher: () => Promise<void>;
    /** Polling budget; recovery may overrun it under its own startup deadline. */
    timeoutMs: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  }>,
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const started = now();
  let recovered = false;
  while (true) {
    // Maestro startup can outlast the deadline. Honor home delivered during it.
    if (options.hasReachedHome()) return true;
    const elapsed = now() - started;
    if (elapsed >= options.timeoutMs) return false;
    if (!recovered && elapsed >= 20_000 && !options.hasLoadedBundle()) {
      recovered = true;
      await options.recoverLauncher();
      continue;
    }
    await sleep(Math.min(1000, options.timeoutMs - elapsed));
  }
}

export type ShowcaseDevice = Readonly<{
  name: string;
  typeId: string;
  /** Screen size in points, the unit `measureInWindow` reports anchors in. */
  screen: Readonly<{ width: number; height: number }>;
}>;

const IPHONE_16_PRO_MAX = 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max';

/** Dedicated simulators, so a recording never inherits another tool's state or lease. */
export const SHOWCASE_DEVICES: Readonly<Record<'primary' | 'secondary', ShowcaseDevice>> = {
  primary: { name: 'Boardsesh Showcase', typeId: IPHONE_16_PRO_MAX, screen: { width: 440, height: 956 } },
  secondary: { name: 'Boardsesh Showcase 2', typeId: IPHONE_16_PRO_MAX, screen: { width: 440, height: 956 } },
};

/** A separate device pair for parallel recordings; never changes the default pair. */
export function showcaseDevice(role: 'primary' | 'secondary', nameSuffix = ''): ShowcaseDevice {
  const suffix = nameSuffix.trim();
  if (!suffix) return SHOWCASE_DEVICES[role];
  if (!/^[\p{L}\p{N} _-]{1,60}$/u.test(suffix))
    throw new Error(
      'SHOWCASE_SIMULATOR_NAME_SUFFIX must contain 1–60 letters, numbers, spaces, underscores or hyphens.',
    );
  return { ...SHOWCASE_DEVICES[role], name: `${SHOWCASE_DEVICES[role].name} [${suffix}]` };
}

/** Match the visible native calendar heading, treating translated punctuation literally. */
export function showcaseCalendarPattern(heading: string): string {
  return heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Match the localized history button while allowing its active board label. */
export function showcaseBoardHistoryPattern(label: string): string {
  const fragments = label.split('{{board}}');
  if (fragments.length !== 2) throw new Error('Board history label must contain one {{board}} placeholder');
  const escapeLiteral = (fragment: string) => fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${escapeLiteral(fragments[0])}[^\\r\\n]+${escapeLiteral(fragments[1])}$`;
}

/** Only the catalog fields used to identify a genuine native filter presentation. */
export type ShowcaseFilterCatalog = {
  mobile: {
    filter: { title: string; close: string; gradeRange: string; section: { name: string; difficulty: string } };
    search: { filters: string; filterCountAria: string; chips: { filtersWithCount: string } };
    gradeRail: { setFilterAria: string; selectedFilterAria: string; rangeFilterAria: string };
  };
};

/** Match real localized controls; never supply a grade range, count or result. */
export function showcaseFilterPatterns(catalog: ShowcaseFilterCatalog): Record<string, string> {
  const escapeLiteral = (label: string) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const template = (label: string, placeholder: string, actualControl: string): string => {
    const fragments = label.split(`{{${placeholder}}}`);
    if (fragments.length !== 2) throw new Error(`Filter label must contain one {{${placeholder}}} placeholder`);
    return `${escapeLiteral(fragments[0])}${actualControl}${escapeLiteral(fragments[1])}`;
  };
  const { filter, search, gradeRail } = catalog.mobile;
  return {
    SHOWCASE_FILTER_CLOSE: `^${escapeLiteral(filter.close)}$`,
    SHOWCASE_FILTER_TITLE: `^${escapeLiteral(filter.title)}$`,
    SHOWCASE_FILTER_NAME: `^${escapeLiteral(filter.section.name)}$`,
    SHOWCASE_FILTER_DIFFICULTY: `^${escapeLiteral(filter.section.difficulty)}$`,
    SHOWCASE_FILTER_GRADE_RANGE: `^${escapeLiteral(filter.gradeRange)}$`,
    SHOWCASE_FILTER_BUTTON: `^(?:${[
      escapeLiteral(filter.title),
      escapeLiteral(search.filters),
      template(search.filterCountAria, 'count', '[0-9]+'),
      template(search.chips.filtersWithCount, 'count', '[0-9]+'),
    ].join('|')})$`,
    SHOWCASE_FILTER_GRADE_CONTROL: `^(?:${[
      gradeRail.setFilterAria,
      gradeRail.selectedFilterAria,
      gradeRail.rangeFilterAria,
    ]
      .map((label) => template(label, 'grade', '[^\\r\\n]+'))
      .join('|')})$`,
  };
}

/**
 * The seven walls the board takes sit on, in `SHOWCASE_BOARD_SLOTS` order
 * (kilter, tension, moonboard, woods, decoy, grasshopper, spray). Each entry
 * matches a board's name or layout name on the signed-in account (see
 * packages/mobile/src/lib/screenshot-board-selection.ts). Prod is the App Store
 * account's walls (the Kilter is Marco's own board, the App Store hero wall;
 * the spray wall's name is a placeholder until the account has the wall the
 * video shows); local is the seeded dev DB's, plus the MoonBoard the recorder
 * adds on first run. A wall that is renamed or unfollowed fails the take with
 * the account's roster in the message.
 */
export const SHOWCASE_DEFAULT_BOARDS: Readonly<Record<ShowcaseBackend, string>> = {
  prod: "Marco's Board|High Point Climbing Orlando|MoonBoard 2016|Woods Original|Decoy Dungeon|Grasshopper|Home Spray Wall",
  local: 'The Proj Wall|The Slab Lab|MoonBoard 2016',
};

/** Where the secondary account's credentials live on Marco's machine (mode 600, never in the repo). */
export const SHOWCASE_DEFAULT_ENV_FILE = join(homedir(), '.config', 'boardsesh', 'showcase-secrets.env');

export type ShowcaseRecordArgs = Readonly<{
  /** The phone the takes are filmed on (default iOS). */
  platform: ShowcasePlatform;
  kind: ShowcaseVariantKind;
  /** Explicit locale or variant opts into separated native store captures. */
  nativeLocaleCapture: boolean;
  locales: readonly ShowcaseLocale[];
  /** Set the devices up, then hold them (and Metro) until Ctrl-C, recording nothing: for calibrating flows. */
  hold: boolean;
  only: readonly ShowcaseTakeId[] | null;
  dryRun: boolean;
  keepRaw: boolean;
  appPath: string | null;
  backend: ShowcaseBackend;
  boards: string | null;
  envFile: string;
  skipAnchorCheck: boolean;
  /** Record nothing: rejoin this session on the primary and end it (a crashed crew run's leftover). */
  endSession: string | null;
}>;

function expectValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseTakeIds(raw: string): ShowcaseTakeId[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (!(SHOWCASE_TAKE_IDS as readonly string[]).includes(part)) {
        throw new Error(`--only: unknown take "${part}" (one of: ${SHOWCASE_TAKE_IDS.join(', ')})`);
      }
      return part as ShowcaseTakeId;
    });
}

/**
 * What a run does once its devices are ready: `hold` (calibration: nothing is
 * recorded and no stray session is ended, even when `--end-session` is also
 * given), `end-session` (rejoin and end one session), or `record` the takes.
 */
export function recordRunMode(
  args: Readonly<Pick<ShowcaseRecordArgs, 'hold' | 'endSession'>>,
): 'hold' | 'end-session' | 'record' {
  if (args.hold) return 'hold';
  if (args.endSession) return 'end-session';
  return 'record';
}

/**
 * Why the recorder refuses to run off macOS. Android needs macOS too: the
 * crew take's second participant is an iOS simulator.
 */
export function macOsOnlyMessage(platform: ShowcasePlatform): string {
  return platform === 'android'
    ? 'The showcase recorder needs macOS on Android too: the crew take films an Android emulator, ' +
        'but its second participant is an iOS simulator.'
    : 'The showcase recorder drives iOS simulators: macOS only.';
}

export function parseRecordArgs(argv: readonly string[]): ShowcaseRecordArgs {
  const args = argv.filter((argument) => argument !== '--');
  let only: ShowcaseTakeId[] | null = null;
  let platform: ShowcasePlatform = DEFAULT_SHOWCASE_PLATFORM;
  let kind: ShowcaseVariantKind = 'default';
  let locales: ShowcaseLocale[] = ['en-US'];
  let localeFlagSeen = false;
  let kindFlagSeen = false;
  let hold = false;
  let dryRun = false;
  let keepRaw = false;
  let appPath: string | null = null;
  let backend: ShowcaseBackend = 'prod';
  let boards: string | null = null;
  let envFile = SHOWCASE_DEFAULT_ENV_FILE;
  let skipAnchorCheck = false;
  let endSession: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    switch (flag) {
      case '--wall':
      case '--kind': {
        kindFlagSeen = true;
        const chosen = expectValue(flag, value);
        if (!(SHOWCASE_VARIANT_KINDS as readonly string[]).includes(chosen))
          throw new Error(`--kind must be one of ${SHOWCASE_VARIANT_KINDS.join(', ')}`);
        kind = chosen as ShowcaseVariantKind;
        index++;
        break;
      }
      case '--locale':
      case '--locales': {
        if (localeFlagSeen) throw new Error('Use --locale or --locales once per run');
        localeFlagSeen = true;
        const chosen = expectValue(flag, value);
        const requested = chosen === 'all' ? [...SHOWCASE_LOCALES] : chosen.split(',').map((entry) => entry.trim());
        if (!requested.length || requested.some((entry) => !(SHOWCASE_LOCALES as readonly string[]).includes(entry)))
          throw new Error(`--locale/--locales must be ${SHOWCASE_LOCALES.join(', ')} or all`);
        locales = [...new Set(requested)] as ShowcaseLocale[];
        index++;
        break;
      }
      case '--only':
        only = [...(only ?? []), ...parseTakeIds(expectValue(flag, value))];
        index++;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--platform': {
        const chosen = expectValue(flag, value);
        if (!isShowcasePlatform(chosen)) {
          throw new Error(`--platform must be one of ${SHOWCASE_PLATFORMS.join(', ')} (got "${chosen}")`);
        }
        platform = chosen;
        index++;
        break;
      }
      case '--hold':
        hold = true;
        break;
      case '--keep-raw':
        keepRaw = true;
        break;
      case '--app-path':
        appPath = expectValue(flag, value);
        index++;
        break;
      case '--backend': {
        const chosen = expectValue(flag, value);
        if (chosen !== 'prod' && chosen !== 'local')
          throw new Error(`--backend must be prod or local (got "${chosen}")`);
        backend = chosen;
        index++;
        break;
      }
      case '--boards':
        boards = expectValue(flag, value);
        index++;
        break;
      case '--env-file':
        envFile = expectValue(flag, value);
        index++;
        break;
      case '--skip-anchor-check':
        skipAnchorCheck = true;
        break;
      case '--end-session': {
        const sessionId = parseSessionIdFromInviteUrl(`/join/${expectValue(flag, value)}`);
        if (!sessionId) throw new Error('--end-session takes a session id (a UUID)');
        endSession = sessionId;
        index++;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (only && only.length === 0) throw new Error('--only needs at least one take');
  if ((hold || endSession) && locales.length > 1) throw new Error('--hold and --end-session require one locale');
  return {
    platform,
    kind,
    nativeLocaleCapture: kindFlagSeen || localeFlagSeen,
    locales,
    hold,
    only: only ? [...new Set(only)] : null,
    dryRun,
    keepRaw,
    appPath,
    backend,
    boards,
    envFile,
    skipAnchorCheck,
    endSession,
  };
}

/** Preserve the original English homepage workflow unless the caller selects a store variant or locale. */
export function recordingWorkDirs(
  args: Pick<ShowcaseRecordArgs, 'platform' | 'kind' | 'locales' | 'nativeLocaleCapture'>,
): ShowcaseWorkDirs {
  return args.nativeLocaleCapture
    ? showcaseVariantWorkDirs(args.kind, args.locales[0], args.platform)
    : showcaseWorkDirs(args.platform);
}

/** Replace the locale selector when launching one clean recorder process per locale. */
export function recordLocaleArgs(argv: readonly string[], locale: ShowcaseLocale): string[] {
  const forwarded: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--locale' || argv[index] === '--locales') {
      index++;
      continue;
    }
    if (argv[index] !== '--') forwarded.push(argv[index]);
  }
  return [...forwarded, '--locale', locale];
}

/**
 * `KEY=value` lines, the shape `op inject` and a hand-written secrets file both
 * produce. Comments, blank lines and a leading `export ` are ignored, one layer
 * of matching quotes is stripped. Values are never logged by the caller.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let fileValue = match[2].trim();
    if (
      fileValue.length >= 2 &&
      ((fileValue.startsWith('"') && fileValue.endsWith('"')) || (fileValue.startsWith("'") && fileValue.endsWith("'")))
    ) {
      fileValue = fileValue.slice(1, -1);
    }
    parsed[match[1]] = fileValue;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// ffmpeg

/**
 * Raw simulator recording -> the renderer's JPEG sequence.
 *
 * simctl only writes a frame when the screen changes, and the container ends at
 * the LAST frame: a take that holds a still board for six seconds comes back as
 * a 0.07 s file. So the timeline is rebuilt from the wall clock instead of
 * seeking in the file:
 *
 * - `fps` turns the variable frame rate into constant 30 fps, repeating a frame
 *   across every gap where nothing changed;
 * - `tpad` clones the last frame out past the moment the recording stopped;
 * - `trim` then cuts exactly [trimSeconds, trimSeconds + durationSeconds) of
 *   that, dropping Maestro's attach time from the head, and `setpts` restarts
 *   the clock at 0;
 * - `scale=W:-2` keeps the aspect with an even height, and `format=yuvj420p`
 *   is the full-range YUV the JPEG encoder insists on.
 */
export function buildFootageFrameArgs(
  options: Readonly<{ input: string; outputPattern: string; trimSeconds: number; durationSeconds: number }>,
): string[] {
  const padSeconds = options.trimSeconds + options.durationSeconds + 1;
  return [
    '-y',
    '-loglevel',
    'error',
    '-i',
    options.input,
    '-an',
    '-vf',
    [
      `fps=${SHOWCASE_FPS}`,
      `tpad=stop_mode=clone:stop_duration=${padSeconds.toFixed(3)}`,
      `trim=start=${options.trimSeconds.toFixed(3)}:duration=${options.durationSeconds.toFixed(3)}`,
      'setpts=PTS-STARTPTS',
      `scale=${SHOWCASE_FOOTAGE_WIDTH}:-2`,
      'format=yuvj420p',
    ].join(','),
    // q3: visually lossless at 800 px, about a third smaller than q2 across the
    // ~2,000 frames a full run writes.
    '-q:v',
    '3',
    '-start_number',
    '1',
    options.outputPattern,
  ];
}

/** Stream width, height, one per line. */
export function buildDimensionsProbeArgs(file: string): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    file,
  ];
}

// ---------------------------------------------------------------------------
// Logs

/** `simctl io recordVideo` says this on stderr once frames are being written. */
export function isRecordingStartedLine(line: string): boolean {
  return /recording started/i.test(line);
}

/**
 * Every showcase flow's first step is `GET <signal server>/mark/flow-start`, so
 * the recorder knows to the millisecond when the flow began driving the app.
 * Everything before that on the recording is Maestro attaching (4-7 s) and is
 * cut. Without the mark (a flow run by hand, a signal server that never got the
 * request), fall back to the take's registry trim.
 */
export const FLOW_START_MARK = 'flow-start';

export function resolveTrimSeconds(
  options: Readonly<{ recordStartMs: number; flowStartMs: number | null; fallbackSeconds: number }>,
): number {
  if (options.flowStartMs === null || options.flowStartMs < options.recordStartMs) return options.fallbackSeconds;
  return Math.round(options.flowStartMs - options.recordStartMs) / 1000;
}

/**
 * The signal server's routes, shared with the flows:
 *   GET /ready/<role>   counts primary/secondary home arrivals independently of analytics
 *   GET /mark/<name>    records when a flow reached a step (the recorder reads it back)
 *   GET /set/<name>     raises a signal another device's flow is waiting on
 *   GET /signal/<name>  "go" once raised, "wait" before
 *   GET /value/<name>   a value the recorder published, "" before (see anchorTapValues)
 * Names are lowercase words and dashes, so a URL can never smuggle anything else.
 */
export type ShowcasePhoneRole = 'primary' | 'secondary';

export type SignalRequest =
  | Readonly<{ kind: 'ready'; role: ShowcasePhoneRole }>
  | Readonly<{ kind: 'mark' | 'set' | 'signal' | 'value'; name: string }>
  | Readonly<{ kind: 'unknown' }>;

export function parseSignalRequest(url: string): SignalRequest {
  const readiness = /^\/ready\/(primary|secondary)\/?$/.exec(url.split('?')[0]);
  if (readiness) return { kind: 'ready', role: readiness[1] as ShowcasePhoneRole };
  const match = /^\/(mark|set|signal|value)\/([a-z0-9-]{1,64})\/?$/.exec(url.split('?')[0]);
  if (!match) return { kind: 'unknown' };
  return { kind: match[1] as 'mark' | 'set' | 'signal' | 'value', name: match[2] };
}

export type SignalServer = Readonly<{
  url: string;
  port: number;
  readinessUrl(role: ShowcasePhoneRole): string;
  homeReadyCount(role: ShowcasePhoneRole): number;
  marks: Map<string, number>;
  values: Map<string, string>;
  raise(name: string): void;
  reset(): void;
  close(): Promise<void>;
}>;

export async function startSignalServer(): Promise<SignalServer> {
  const marks = new Map<string, number>();
  const values = new Map<string, string>();
  const raised = new Set<string>();
  // Unlike take marks, these counters must survive reset() and only increase.
  const homeReadyCounts: Record<ShowcasePhoneRole, number> = { primary: 0, secondary: 0 };
  const server: Server = createServer((request, response) => {
    response.setHeader('content-type', 'text/plain');
    if (request.method !== 'GET') {
      response.statusCode = 405;
      response.setHeader('allow', 'GET');
      response.end('GET required');
      return;
    }
    const parsed = parseSignalRequest(request.url ?? '');
    if (parsed.kind === 'unknown') {
      response.statusCode = 404;
      response.end('unknown');
      return;
    }
    if (parsed.kind === 'ready') {
      homeReadyCounts[parsed.role] += 1;
      response.end('ok');
      return;
    }
    if (parsed.kind === 'mark') marks.set(parsed.name, Date.now());
    if (parsed.kind === 'set') raised.add(parsed.name);
    if (parsed.kind === 'value') {
      response.end(values.get(parsed.name) ?? '');
      return;
    }
    response.end(parsed.kind === 'signal' ? (raised.has(parsed.name) ? 'go' : 'wait') : 'ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    readinessUrl: (role) => `http://127.0.0.1:${port}/ready/${role}`,
    homeReadyCount: (role) => homeReadyCounts[role],
    marks,
    values,
    raise: (name) => raised.add(name),
    reset: () => {
      marks.clear();
      values.clear();
      raised.clear();
    },
    close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())),
  };
}

/** How many times the app has reached home in this Metro log. */
export function countHomeReady(logText: string): number {
  return [...logText.matchAll(/\$screen \/home(?=\s|$)/g)].length;
}

/**
 * Splits log bytes into the complete (newline-terminated) lines and the
 * unterminated tail. A writer can flush half a line, or half a UTF-8
 * character, between two reads; the tail is carried into the next call so
 * neither fragment is parsed on its own. A trailing `\r` (CRLF) is dropped.
 */
export function splitCompleteLines(pending: Buffer, chunk: Buffer): { lines: string[]; rest: Buffer } {
  const bytes = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline === -1) return { lines: [], rest: bytes };
  const lines = bytes
    .subarray(0, lastNewline)
    .toString('utf8')
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  return { lines, rest: Buffer.from(bytes.subarray(lastNewline + 1)) };
}

export type AnchorArrival = Readonly<{ line: ShowcaseAnchorLogLine; atMs: number }>;

/** Anchor lines out of a chunk of Metro output, each stamped with when the chunk arrived. */
export function anchorArrivalsFromChunk(chunk: string, atMs: number): AnchorArrival[] {
  const arrivals: AnchorArrival[] = [];
  for (const line of chunk.split('\n')) {
    const parsed = parseShowcaseAnchorLine(line);
    if (parsed) arrivals.push({ line: parsed, atMs });
  }
  return arrivals;
}

const sameRect = (left: ShowcaseAnchorSample, right: ShowcaseAnchorSample): boolean =>
  left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;

/**
 * The anchors file for one take. `t` is seconds into the TRIMMED footage.
 * Samples logged before the trimmed start collapse into one at `t = 0` (the
 * rect in force when the footage begins); a sample that repeats the previous
 * rect is dropped; samples past the footage's end are dropped.
 */
export function buildAnchorsFile(
  options: Readonly<{
    takeId: ShowcaseTakeId;
    arrivals: readonly AnchorArrival[];
    recordStartMs: number;
    trimSeconds: number;
    durationSeconds: number;
    screen: Readonly<{ width: number; height: number }>;
    /** Recorder-authored rects, each on screen from its mark onward (ms, same clock as arrivals). */
    staticAnchors?: readonly (ShowcaseStaticAnchor & Readonly<{ markMs: number }>)[];
  }>,
): ShowcaseAnchorsFile {
  const anchors: Partial<Record<ShowcaseCalloutName, ShowcaseAnchorSample[]>> = {};
  const ordered = [...options.arrivals].sort((left, right) => left.atMs - right.atMs);
  for (const name of SHOWCASE_ANCHOR_NAMES) {
    const own = ordered.filter((arrival) => arrival.line.name === name);
    if (own.length === 0) continue;
    const samples: ShowcaseAnchorSample[] = [];
    for (const arrival of own) {
      const rawT = (arrival.atMs - options.recordStartMs) / 1000 - options.trimSeconds;
      if (rawT > options.durationSeconds) break;
      const { x, y, width, height } = arrival.line;
      const sample: ShowcaseAnchorSample = { t: Math.max(0, Math.round(rawT * 1000) / 1000), x, y, width, height };
      const previous = samples[samples.length - 1];
      if (previous && previous.t === 0 && sample.t === 0) {
        samples[samples.length - 1] = sample;
        continue;
      }
      if (previous && sameRect(previous, sample)) continue;
      samples.push(sample);
    }
    if (samples.length > 0) anchors[name] = sortAnchorSamples(samples);
  }
  for (const staticAnchor of options.staticAnchors ?? []) {
    const rawT = (staticAnchor.markMs - options.recordStartMs) / 1000 - options.trimSeconds;
    if (rawT > options.durationSeconds) continue;
    const sample: ShowcaseAnchorSample = { t: Math.max(0, Math.round(rawT * 1000) / 1000), ...staticAnchor.rect };
    // A name listed twice (a button that moves on a tap) keeps both, in time order.
    anchors[staticAnchor.name] = sortAnchorSamples([...(anchors[staticAnchor.name] ?? []), sample]);
  }
  return { takeId: options.takeId, screen: options.screen, anchors };
}

/**
 * Where an anchor sits, as the whole-number screen percentages a Maestro
 * `point:` takes, published on the signal server as `anchor-<name>-x` / `-y`.
 * A flow reads them to tap something whose place depends on data: the crew
 * take long-presses the queue row the second phone just added, and that row
 * sits lower when the queue has history.
 */
export function anchorTapValues(
  line: ShowcaseAnchorLogLine,
  screen: Readonly<{ width: number; height: number }>,
): Record<string, string> {
  const x = Math.round(((line.x + line.width / 2) / screen.width) * 100);
  const y = Math.round(((line.y + line.height / 2) / screen.height) * 100);
  const clamp = (percent: number): string => String(Math.min(99, Math.max(1, percent)));
  return {
    [`anchor-${line.name}-x`]: clamp(x),
    [`anchor-${line.name}-y`]: clamp(y),
    // The raw centre in points, for an anchor measured inside a sheet's own
    // window (its y is relative to the sheet, so the flow adds the sheet's top).
    [`anchor-${line.name}-cy`]: String(Math.round(line.y + line.height / 2)),
  };
}

/**
 * scripts/screenshot-sim.entitlements names the team-prefixed keychain group
 * literally (a simulator build has no provisioning profile to expand
 * `$(AppIdentifierPrefix)` in entitlements), while the app's Info.plist gets
 * the prefix from the project's DEVELOPMENT_TEAM. If the team ever changes,
 * the two drift apart and every shared-keychain write fails, which breaks the
 * island take's Next. `null` when they agree, or when the app predates the key.
 */
export function findKeychainTeamProblem(
  appKeychainGroup: string | null,
  entitlementsXml: string,
  entitlementsPath: string,
): string | null {
  if (!appKeychainGroup) return null;
  const listed = [...entitlementsXml.matchAll(/<string>([A-Z0-9]{10}\.group\.com\.boardsesh\.app)<\/string>/g)].map(
    (match) => match[1],
  );
  if (listed.includes(appKeychainGroup)) return null;
  return (
    `The dev-client's keychain group is ${appKeychainGroup} (its BoardseshKeychainAccessGroup), but ` +
    `${entitlementsPath} lists ${listed.join(', ') || 'no team-prefixed group'}. The team ID changed: put ` +
    `${appKeychainGroup} in that file's keychain-access-groups and rebuild the app ` +
    '(vp run mobile:build-sim-app -- --app-out packages/mobile/.app-cache), or the Live Activity cannot use the shared keychain.'
  );
}

/** Signal-server marks that are recorder plumbing, not moments in the footage. */
const PLUMBING_MARKS = new Set([FLOW_START_MARK, 'secondary-ready']);

/**
 * The marks file for one take: every mark the flows raised while recording
 * (the second phone's too), plus marks derived from the FIRST sample of an
 * anchor logged during the take (`anchorMarks`: mark name -> anchor name, e.g.
 * the crew row landing), each in seconds from the trimmed start. Plumbing
 * marks and marks outside the footage are left out.
 */
export function buildMarksFile(
  options: Readonly<{
    takeId: ShowcaseTakeId;
    marks: ReadonlyMap<string, number>;
    arrivals: readonly AnchorArrival[];
    anchorMarks: Readonly<Record<string, ShowcaseAnchorName>>;
    recordStartMs: number;
    trimSeconds: number;
    durationSeconds: number;
  }>,
): ShowcaseMarksFile {
  const toSeconds = (atMs: number): number =>
    Math.round(((atMs - options.recordStartMs) / 1000 - options.trimSeconds) * 1000) / 1000;
  const entries: [string, number][] = [];
  for (const [name, atMs] of options.marks) {
    if (!PLUMBING_MARKS.has(name)) entries.push([name, toSeconds(atMs)]);
  }
  const trimmedStartMs = options.recordStartMs + options.trimSeconds * 1000;
  for (const [markName, anchorName] of Object.entries(options.anchorMarks)) {
    const first = options.arrivals
      .filter((arrival) => arrival.line.name === anchorName && arrival.atMs >= trimmedStartMs)
      .sort((left, right) => left.atMs - right.atMs)[0];
    if (first) entries.push([markName, toSeconds(first.atMs)]);
  }
  const marks = Object.fromEntries(
    entries
      .filter(([, seconds]) => seconds >= 0 && seconds <= options.durationSeconds)
      .sort(([, left], [, right]) => left - right),
  );
  return { takeId: options.takeId, marks };
}

/**
 * A board config opened by deep link (`touchstone/1/1/1/40/list`) has no
 * screenshot slot to check; its `Board Route Handoff` event says whether the
 * app actually adopted it. `null` when the last handoff resolved.
 */
export function findBoardHandoffProblem(logText: string, link: string): string | null {
  const handoffs = logText.split('\n').filter((line) => line.includes('Board Route Handoff'));
  const last = handoffs[handoffs.length - 1];
  if (!last) return `the app never handled the board link ${link}; check the link in SHOWCASE_BOARD_CONFIG_LINKS`;
  if (!/"status":\s*"resolved"/.test(last)) {
    return `the board link ${link} did not resolve (${last.slice(last.indexOf('{')).trim()}); the account or the config is wrong`;
  }
  return null;
}

/**
 * The board type a `[screenshot] board[N]` line names. The app ends the line
 * with `@<angle>°, <boardType>)`, after the wall's name and its layout's name,
 * which are free text and may hold brackets and quotes of their own. Reading
 * from the end means neither can pose as the type: a Kilter called "Tension
 * Fans" is still a Kilter. Null when the line does not end that way.
 */
function loggedBoardType(detail: string): string | null {
  return /@-?[\d.]+°, ([a-z][a-z0-9]*)\)\s*$/.exec(detail)?.[1] ?? null;
}

/**
 * Which wall the app put slot `slot` on, from its own `[screenshot] board[N]`
 * lines. `null` when it is the right kind of wall; otherwise the problem, with
 * the account's roster when the app logged one.
 */
export function findBoardSlotProblem(logText: string, slot: number, kind: ShowcaseBoardKind): string | null {
  const lines = logText.split('\n');
  const warned = lines.find((line) => line.includes(`[screenshot] WARN board[${slot}]`));
  const roster = lines.find((line) => line.includes('[screenshot] board roster:'));
  if (warned) {
    const rosterText = roster ? roster.slice(roster.indexOf('board roster:')).trim() : 'no roster logged';
    return `slot ${slot} matched no wall (${rosterText}); pass --boards with a name from that list`;
  }
  const resolved = [...lines].reverse().find((line) => line.includes(`[screenshot] board[${slot}] `));
  if (!resolved) return `the app never resolved board slot ${slot}; is the account signed in and are its walls loaded?`;
  const detail = resolved.slice(resolved.indexOf(`board[${slot}]`));
  const boardType = loggedBoardType(detail);
  if (boardType === null) {
    return `slot ${slot}'s line names no board type (${detail.trim()}); the app bundle is older than this recorder`;
  }
  const rightKind = boardType === kind;
  if (!rightKind) {
    return `slot ${slot} landed on a non-${kind} wall (${detail.trim()}); pass --boards with a ${kind} wall in slot ${slot}`;
  }
  return null;
}

/** Match a localized peer attribution label in a queue row's accessibility text. */
export function crewPeerRowPattern(addedByLabel: string, positionLabel: string): string {
  const fragments = addedByLabel.split('{{name}}');
  if (fragments.length !== 2) throw new Error('Queue attribution label must contain one {{name}} placeholder');
  const escapeFragment = (fragment: string): string => fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^.*[,] ${escapeFragment(positionLabel)}, ${escapeFragment(fragments[0])}.+${escapeFragment(fragments[1])}.*$`;
}

/** Observed first-upcoming Kilter/Tension row, away from its trailing drag handle. */
export function crewPeerRowFallbackPoint(
  kind: ShowcaseVariantKind,
  platform: ShowcasePlatform,
  logText: string,
): string {
  // Both iOS targets are independently measured. Queue verification retains
  // Tension's layout 10/slot 1 gate; other families have no observed peer row.
  if (kind !== 'default' && kind !== 'kilter' && kind !== 'tension') return '';
  return crewQueueFallbackPoint(kind, platform, logText) ? '50%,78%' : '';
}

/** Measured family-specific iOS queue targets when the native drawer omits accessibility controls. */
export function crewQueueFallbackPoint(kind: ShowcaseVariantKind, platform: ShowcasePlatform, logText: string): string {
  if (platform !== 'ios') return '';
  // Tension mirrors: its genuine Queue button is in the lower-right utility
  // row, away from the first-slot Mirror control. Only layout 10 was measured;
  // layout 11 cannot mirror and puts Queue in a different slot.
  if (kind === 'tension') {
    if (findBoardSlotProblem(logText, 1, 'tension') !== null) return '';
    const lastTensionSlotResolution = logText
      .split('\n')
      .reverse()
      .find((line) => line.includes('[screenshot] board[1] '));
    return /\bL10 S\d+ @-?[\d.]+°, tension\)\s*$/.test(lastTensionSlotResolution ?? '') ? '91%,90%' : '';
  }
  if (kind !== 'default' && kind !== 'kilter') return '';
  return findBoardSlotProblem(logText, 0, 'kilter') === null ? '10%,84%' : '';
}

/**
 * True once the app has logged the pre-session "Show this session live"
 * switch going OFF. The crew take refuses to start a session without it, so a
 * recording never lands in anyone's "Climbing now" rail.
 */
export function sessionVisibilityIsOff(logText: string): boolean {
  const changes = logText.split('\n').filter((line) => line.includes('Session Visibility Changed'));
  const last = changes[changes.length - 1];
  // pre_session only: an in_session change means a session was ALREADY running
  // (a teardown that never finished), and the Start button is not where the
  // flow expects it.
  return Boolean(last && /"isPublic":\s*false/.test(last) && /"phase":\s*"pre_session"/.test(last));
}

/**
 * The session the app picked back up on launch (`[session] restored from
 * store: <id>`), or null. A crew take that died before its teardown leaves one
 * behind, and the next run has to end it before it can start a fresh one.
 */
export function restoredSessionId(logText: string): string | null {
  const matches = [...logText.matchAll(/\[session\] restored from store: (\S+)/g)];
  const last = matches[matches.length - 1]?.[1];
  return last && last !== '(none)' ? last : null;
}

/** Close Android SystemUI while preserving the app's live capture session. */
export function collapseCaptureNotificationShade(
  platform: ShowcasePlatform,
  serial: string,
  executeAdb: (args: string[]) => { status: number; stderr: string },
): void {
  if (platform !== 'android') return;
  const collapse = executeAdb(['-s', serial, 'shell', 'cmd', 'statusbar', 'collapse']);
  if (collapse.status !== 0) {
    throw new Error(
      `Android notification shade did not collapse: ${collapse.stderr.trim() || `adb exit ${collapse.status}`}`,
    );
  }
}

/** Close a live capture session before a cold launch can discard its JS state. */
export async function ensureCaptureSessionClosed(
  session: { open: boolean },
  closeSession: () => Promise<void>,
): Promise<void> {
  if (!session.open) return;
  await closeSession();
  if (session.open) {
    throw new Error('The live capture session did not end; preserving its app state instead of relaunching.');
  }
}

/** The app logged the session starting (the Start tap landed). */
export function sessionStarted(logText: string): boolean {
  return logText.includes('[analytics] Session Started');
}

/** The session id out of an invite link (`https://www.boardsesh.com/join/<uuid>`). */
export function parseSessionIdFromInviteUrl(text: string): string | null {
  const match = /\/join\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(text);
  return match ? match[1].toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Self-check

/**
 * A frame is blank when no channel varies: a black launch screen, a white
 * flash, a solid loading surface. Real UI has text and edges everywhere, so
 * its per-channel standard deviation sits far above this.
 */
export const BLANK_FRAME_MAX_STDEV = 6;

export function isBlankFrame(channelStdevs: readonly number[]): boolean {
  return channelStdevs.length > 0 && channelStdevs.every((stdev) => stdev < BLANK_FRAME_MAX_STDEV);
}

/**
 * Share of pixels whose R, G or B moved more than `tolerance`, the same measure
 * `scripts/compare-screenshots.ts` uses, over two equally sized raw buffers.
 * The reference check runs it on thumbnails with a loose tolerance: it is there
 * to catch the wrong screen, not a moved pixel.
 */
export function differingPixelRatio(
  baseline: Uint8Array,
  candidate: Uint8Array,
  channels: number,
  tolerance: number,
): number {
  if (baseline.length !== candidate.length || channels < 3) {
    throw new Error('differingPixelRatio needs two buffers of the same size with at least 3 channels');
  }
  const pixelCount = baseline.length / channels;
  let differing = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * channels;
    for (let channel = 0; channel < 3; channel++) {
      if (Math.abs(baseline[offset + channel] - candidate[offset + channel]) > tolerance) {
        differing++;
        break;
      }
    }
  }
  return pixelCount === 0 ? 0 : differing / pixelCount;
}

export const REFERENCE_CHANNEL_TOLERANCE = 48;
export const REFERENCE_MAX_DIFF_RATIO = 0.35;

export type TakeCheckInput = Readonly<{
  takeId: ShowcaseTakeId;
  /** The phone the take was filmed on: each platform has its own reference frames. */
  platform: ShowcasePlatform;
  expectedAnchors: readonly ShowcaseCalloutName[];
  anchors: ShowcaseAnchorsFile;
  footageSeconds: number;
  minSeconds: number;
  firstFrameBlank: boolean;
  /** `null` when there is no reference image for the take. */
  referenceDiffRatio: number | null;
  boardProblem: string | null;
  skipAnchorCheck: boolean;
}>;

/** Every problem with one take, each naming the take and the fix. Empty means it passed. */
export function checkTake(input: TakeCheckInput): string[] {
  const problems: string[] = [];
  const prefix = `[${input.takeId}]`;
  if (input.footageSeconds + 1 / SHOWCASE_FPS < input.minSeconds) {
    problems.push(
      `${prefix} footage is ${input.footageSeconds.toFixed(2)}s, the scene needs ${input.minSeconds.toFixed(2)}s. ` +
        `Lengthen the last pause in its flow, or lower its trimSeconds in scripts/lib/showcase-video/takes.ts.`,
    );
  }
  if (input.firstFrameBlank) {
    problems.push(
      `${prefix} the first frame is blank. The app had not drawn yet when the trimmed footage starts: ` +
        `raise the flow's opening pause, or check the raw recording with --keep-raw.`,
    );
  }
  if (input.referenceDiffRatio !== null && input.referenceDiffRatio > REFERENCE_MAX_DIFF_RATIO) {
    problems.push(
      `${prefix} the first frame differs from marketing/showcase-video/reference/${input.platform}/${input.takeId}.jpg in ` +
        `${Math.round(input.referenceDiffRatio * 100)}% of pixels: the take opened on the wrong screen. ` +
        `Fix its primeLinks/flow, or replace the reference if the screen changed on purpose.`,
    );
  }
  if (input.boardProblem) {
    problems.push(`${prefix} wrong wall: ${input.boardProblem}.`);
  }
  if (!input.skipAnchorCheck) {
    const missing = input.expectedAnchors.filter((name) => !input.anchors.anchors[name]?.length);
    if (missing.length > 0) {
      problems.push(
        `${prefix} the app never logged anchor(s) ${missing.join(', ')}. The screen they sit on was not ` +
          `reached during the take, or the bundle lacks useShowcaseAnchor (fake-BLE/anchor branch). ` +
          `Pass --skip-anchor-check to record without them.`,
      );
    }
  }
  return problems;
}
