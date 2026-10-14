import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseAllDocuments } from 'yaml';
import {
  SHOWCASE_TAKE_IDS,
  SHOWCASE_LOCALES,
  SHOWCASE_VARIANT_KINDS,
  showcaseVariantWorkDirs,
  type ShowcaseAnchorsFile,
  type ShowcaseMarksFile,
} from '../lib/showcase-video/contract';
import {
  BLANK_FRAME_MAX_STDEV,
  REFERENCE_MAX_DIFF_RATIO,
  SHOWCASE_DEFAULT_BOARDS,
  SHOWCASE_DEFAULT_ENV_FILE,
  SHOWCASE_DEVICES,
  showcaseDevice,
  showcaseCalendarPattern,
  showcaseFilterPatterns,
  type ShowcaseFilterCatalog,
  anchorArrivalsFromChunk,
  anchorTapValues,
  buildAnchorsFile,
  buildFootageFrameArgs,
  buildMarksFile,
  checkTake,
  countHomeReady,
  collapseCaptureNotificationShade,
  crewQueueFallbackPoint,
  crewPeerRowPattern,
  crewPeerRowFallbackPoint,
  ensureCaptureSessionClosed,
  findBoardHandoffProblem,
  findKeychainTeamProblem,
  differingPixelRatio,
  findBoardSlotProblem,
  isBlankFrame,
  isRecordingStartedLine,
  parseEnvFile,
  parseRecordArgs,
  recordLocaleArgs,
  recordingWorkDirs,
  parseSessionIdFromInviteUrl,
  parseSignalRequest,
  startSignalServer,
  resolveTrimSeconds,
  restoredSessionId,
  sessionStarted,
  sessionVisibilityIsOff,
  splitCompleteLines,
  type TakeCheckInput,
} from '../lib/showcase-video/record';
import {
  SHOWCASE_BOARD_CONFIG_LINKS,
  SHOWCASE_BOARD_SLOTS,
  SHOWCASE_PRIME_SETTLE_MS,
  SHOWCASE_TAKES,
  assertShowcaseTakesComplete,
  expectedAnchorsFor,
  isShowcaseFlow,
  showcaseFlowPath,
  findShowcaseTake,
  recordingTakes,
} from '../lib/showcase-video/takes';
import { requiredTakeSeconds } from '../lib/showcase-video/timeline';

const anchorLine = (name: string, x: number): string =>
  ` LOG  [showcase-anchor] {"name":"${name}","x":${x},"y":118,"width":132,"height":32}`;

describe('parallel recording simulator names', () => {
  it('uses the existing device pair by default', () => {
    expect(showcaseDevice('primary')).toBe(SHOWCASE_DEVICES.primary);
    expect(showcaseDevice('secondary', '  ')).toBe(SHOWCASE_DEVICES.secondary);
  });

  it('isolates both roles while retaining native screen geometry and device type', () => {
    for (const role of ['primary', 'secondary'] as const) {
      expect(showcaseDevice(role, ' Remaining ')).toEqual({
        ...SHOWCASE_DEVICES[role],
        name: `${SHOWCASE_DEVICES[role].name} [Remaining]`,
      });
      expect(showcaseDevice(role, 'Remaining').name).not.toBe(SHOWCASE_DEVICES[role].name);
    }
    expect(SHOWCASE_DEVICES.primary.name).toBe('Boardsesh Showcase');
    expect(showcaseDevice('primary', '2').name).not.toBe(SHOWCASE_DEVICES.secondary.name);
  });

  it.each(['bad/name', 'bad\nname', 'x'.repeat(61)])('rejects an invalid suffix %j', (suffix) => {
    expect(() => showcaseDevice('primary', suffix)).toThrow('SHOWCASE_SIMULATOR_NAME_SUFFIX');
  });
});

describe('native all-board progress calendar labels', () => {
  it.each(SHOWCASE_LOCALES)('matches the genuine %s calendar section heading', (locale) => {
    const catalog = JSON.parse(
      readFileSync(new URL(`../../packages/shared/i18n/locales/${locale}/profile.json`, import.meta.url), 'utf8'),
    ) as { stats: { calendar: string } };
    const pattern = new RegExp(`^${showcaseCalendarPattern(catalog.stats.calendar)}$`);
    expect(pattern.test(catalog.stats.calendar)).toBe(true);
    expect(pattern.test(`${catalog.stats.calendar} unrelated`)).toBe(false);
  });

  it('treats translated punctuation literally', () => {
    const pattern = new RegExp(`^${showcaseCalendarPattern('Calendar (all boards) [climbs].')}$`);
    expect(pattern.test('Calendar (all boards) [climbs].')).toBe(true);
    expect(pattern.test('Calendar all boards climbsX')).toBe(false);
  });
});

describe('parseRecordArgs', () => {
  it('defaults to every take against prod', () => {
    expect(parseRecordArgs([])).toEqual({
      only: null,
      dryRun: false,
      keepRaw: false,
      appPath: null,
      backend: 'prod',
      boards: null,
      envFile: SHOWCASE_DEFAULT_ENV_FILE,
      skipAnchorCheck: false,
      endSession: null,
      platform: 'ios',
      kind: 'default',
      nativeLocaleCapture: false,
      locales: ['en-US'],
      hold: false,
    });
  });

  it('reads every flag, and --only repeated or comma separated', () => {
    const args = parseRecordArgs([
      '--',
      '--only',
      'crew,log',
      '--only',
      'crew',
      '--dry-run',
      '--keep-raw',
      '--app-path',
      '/tmp/Boardsesh.app',
      '--backend',
      'local',
      '--boards',
      'A|B|C',
      '--env-file',
      '/tmp/secrets.env',
      '--skip-anchor-check',
      '--end-session',
      '667186B5-f0e5-4f56-92bf-8646f87d3f81',
      '--platform',
      'android',
      '--hold',
    ]);
    expect(args).toEqual({
      only: ['crew', 'log'],
      dryRun: true,
      keepRaw: true,
      appPath: '/tmp/Boardsesh.app',
      backend: 'local',
      boards: 'A|B|C',
      envFile: '/tmp/secrets.env',
      skipAnchorCheck: true,
      endSession: '667186b5-f0e5-4f56-92bf-8646f87d3f81',
      platform: 'android',
      kind: 'default',
      nativeLocaleCapture: false,
      locales: ['en-US'],
      hold: true,
    });
  });

  it('rejects an unknown take, backend or flag', () => {
    expect(() => parseRecordArgs(['--only', 'hook'])).toThrow(/unknown take "hook"/);
    // The light take went with its scene.
    expect(() => parseRecordArgs(['--only', 'light'])).toThrow(/unknown take "light"/);
    expect(parseRecordArgs(['--only', 'spray,boards-spray']).only).toEqual(['spray', 'boards-spray']);
    expect(() => parseRecordArgs(['--backend', 'staging'])).toThrow(/prod or local/);
    expect(() => parseRecordArgs(['--fast'])).toThrow(/Unknown argument: --fast/);
    expect(() => parseRecordArgs(['--only'])).toThrow(/requires a value/);
    expect(() => parseRecordArgs(['--end-session', 'abc'])).toThrow(/UUID/);
    expect(() => parseRecordArgs(['--platform', 'windows'])).toThrow(/--platform must be one of ios, android/);
  });
});

describe('native locale and board recordings', () => {
  it('preserves legacy homepage paths until a locale or kind is explicitly selected', () => {
    expect(recordingWorkDirs(parseRecordArgs([])).footage).toMatch(/work\/footage$/);
    expect(recordingWorkDirs(parseRecordArgs(['--platform', 'android'])).footage).toMatch(/work\/android\/footage$/);
    expect(recordingWorkDirs(parseRecordArgs(['--locale', 'en-US'])).footage).toMatch(
      /work\/boards\/default\/en-US\/footage$/,
    );
    expect(recordingWorkDirs(parseRecordArgs(['--kind', 'default'])).footage).toMatch(
      /work\/boards\/default\/en-US\/footage$/,
    );
  });

  it('records each supported locale explicitly and rejects ambiguous selectors', () => {
    expect(parseRecordArgs(['--locales', 'all']).locales).toEqual(SHOWCASE_LOCALES);
    expect(parseRecordArgs(['--locales', 'fr,de,fr']).locales).toEqual(['fr', 'de']);
    expect(() => parseRecordArgs(['--locale', 'en'])).toThrow(/--locale/);
    expect(() => parseRecordArgs(['--locale', 'es', '--locales', 'all'])).toThrow(/once/);
    expect(() => parseRecordArgs(['--hold', '--locales', 'all'])).toThrow(/one locale/);
    expect(recordLocaleArgs(['--only', 'wall', '--locales', 'all', '--'], 'de')).toEqual([
      '--only',
      'wall',
      '--locale',
      'de',
    ]);
  });

  it('uses separate footage, raw, marks, and anchor directories for every board and locale', () => {
    const paths = SHOWCASE_VARIANT_KINDS.flatMap((kind) =>
      SHOWCASE_LOCALES.flatMap((locale) =>
        ['ios', 'android'].flatMap((platform) =>
          Object.values(showcaseVariantWorkDirs(kind, locale, platform as 'ios' | 'android')),
        ),
      ),
    );
    expect(new Set(paths).size).toBe(paths.length);
    expect(showcaseVariantWorkDirs('moonboard', 'fr').footage).toMatch(/work\/boards\/moonboard\/fr\/footage$/);
  });

  it.each([
    ['kilter', 0],
    ['tension', 1],
    ['moonboard', 2],
    ['spray', 6],
  ] as const)('primes and verifies %s for wall, crew, and workouts', (kind, slot) => {
    const takes = recordingTakes(parseRecordArgs(['--kind', kind, '--only', 'wall,crew,workouts']));
    expect(takes).toHaveLength(3);
    for (const take of takes) {
      expect(take.board).toEqual({ kind, slot });
      expect(take.primeLinks.some((link) => link.includes(`screenshotBoardIndex=${slot}`))).toBe(true);
      if (take.id !== 'wall') expect(take.primeLinks.at(-1)).toBe('record');
    }
  });

  it('records every source used by named store cuts, including permitted board piles', () => {
    const kilter = recordingTakes(parseRecordArgs(['--kind', 'kilter']));
    expect(kilter.map((take) => take.id)).toEqual(
      expect.arrayContaining(['boards-kilter', 'boards-spray', 'boards-moonboard', 'log', 'crew']),
    );
    expect(kilter.find((take) => take.id === 'log')?.flow).toBe('log-kilter.yaml');
    const spray = recordingTakes(parseRecordArgs(['--kind', 'spray']));
    expect(spray.map((take) => take.id)).toEqual(
      expect.arrayContaining(['spray', 'log', 'boards-spray', 'boards-kilter', 'boards-moonboard']),
    );
    expect(recordingTakes(parseRecordArgs(['--kind', 'tension'])).find((take) => take.id === 'log')?.flow).toBe(
      'log-tension.yaml',
    );
    expect(() => recordingTakes(parseRecordArgs(['--kind', 'spray', '--only', 'boards-kilter']))).not.toThrow();
  });

  it('keeps default footage separate and records MoonBoard beats only on its variant', () => {
    expect(recordingTakes(parseRecordArgs([])).some((take) => take.id.startsWith('moonboard-'))).toBe(false);
    expect(recordingTakes(parseRecordArgs(['--kind', 'moonboard'])).map((take) => take.id)).toContain(
      'moonboard-filter',
    );
    expect(() => recordingTakes(parseRecordArgs(['--kind', 'tension', '--only', 'boards-kilter']))).toThrow(
      /cannot record/,
    );
    expect(() => parseRecordArgs(['--kind', '../kilter'])).toThrow(/--kind/);
  });

  it('activates the native MoonBoard filter scene without inventing a selected grade range', () => {
    const [take] = recordingTakes(parseRecordArgs(['--kind', 'moonboard', '--only', 'moonboard-filter']));
    const route = new URL(`com.boardsesh.app://${take.primeLinks.at(-1)}`);
    expect(take.board).toEqual({ slot: 2, kind: 'moonboard' });
    expect(route.searchParams.get('screenshotBoardIndex')).toBe('2');
    expect(route.searchParams.get('screenshotOpenFilters')).toBe('1');
    expect(route.searchParams.get('screenshotCppScene')).toBe('search-grade');
    expect(route.searchParams.has('screenshotMinGrade')).toBe(false);
    expect(route.searchParams.has('screenshotMaxGrade')).toBe(false);
  });
});

describe('parseEnvFile', () => {
  it('reads KEY=value lines, strips quotes and export, skips comments', () => {
    expect(
      parseEnvFile(
        [
          '# secrets',
          'export SHOWCASE_SECONDARY_EMAIL="someone@example.com"',
          "SHOWCASE_SECONDARY_PASSWORD='p=a ss'",
          '',
          'not a line',
          'SCREENSHOT_USER_PASSWORD = plain',
        ].join('\n'),
      ),
    ).toEqual({
      SHOWCASE_SECONDARY_EMAIL: 'someone@example.com',
      SHOWCASE_SECONDARY_PASSWORD: 'p=a ss',
      SCREENSHOT_USER_PASSWORD: 'plain',
    });
  });
});

describe('buildFootageFrameArgs', () => {
  it('rebuilds a CFR timeline, pads past the stop, trims by filter and numbers from 00001', () => {
    const args = buildFootageFrameArgs({
      input: 'raw.mov',
      outputPattern: 'out/%05d.jpg',
      trimSeconds: 5.25,
      durationSeconds: 8,
    });
    // No input seek: simctl's file ends at its last CHANGED frame, so seeking
    // into a still take lands past the end of the file.
    expect(args).not.toContain('-ss');
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2)).toEqual(['-i', 'raw.mov']);
    expect(args[args.indexOf('-vf') + 1]).toBe(
      'fps=30,tpad=stop_mode=clone:stop_duration=14.250,trim=start=5.250:duration=8.000,' +
        'setpts=PTS-STARTPTS,scale=800:-2,format=yuvj420p',
    );
    expect(args[args.indexOf('-start_number') + 1]).toBe('1');
    expect(args).toContain('-an');
    expect(args[args.length - 1]).toBe('out/%05d.jpg');
  });
});

describe('logs', () => {
  it('spots the recordVideo start line', () => {
    expect(isRecordingStartedLine('Recording started')).toBe(true);
    expect(isRecordingStartedLine('Wrote video to: x.mov')).toBe(false);
  });

  it('trims to the flow-start mark, else falls back', () => {
    expect(resolveTrimSeconds({ recordStartMs: 1000, flowStartMs: 7250, fallbackSeconds: 6 })).toBe(6.25);
    expect(resolveTrimSeconds({ recordStartMs: 1000, flowStartMs: null, fallbackSeconds: 6 })).toBe(6);
    expect(resolveTrimSeconds({ recordStartMs: 1000, flowStartMs: 500, fallbackSeconds: 6 })).toBe(6);
  });

  it('parses signal routes and nothing else', () => {
    expect(parseSignalRequest('/mark/flow-start')).toEqual({ kind: 'mark', name: 'flow-start' });
    expect(parseSignalRequest('/set/crew-add')).toEqual({ kind: 'set', name: 'crew-add' });
    expect(parseSignalRequest('/signal/crew-add?x=1')).toEqual({ kind: 'signal', name: 'crew-add' });
    expect(parseSignalRequest('/signal/../etc')).toEqual({ kind: 'unknown' });
    expect(parseSignalRequest('/value/anchor-queue-row-avatar-y')).toEqual({
      kind: 'value',
      name: 'anchor-queue-row-avatar-y',
    });
    expect(parseSignalRequest('/drop/all')).toEqual({ kind: 'unknown' });
  });

  it('counts home arrivals', () => {
    expect(countHomeReady(' INFO  [analytics] $screen /home\n INFO  [analytics] $screen /homes\nx')).toBe(1);
    expect(countHomeReady('$screen /home/climbs\n$screen /home?filter=1')).toBe(0);
    expect(countHomeReady('$screen /home')).toBe(1);
    expect(countHomeReady('')).toBe(0);
  });

  it('reads the session id out of an invite link', () => {
    expect(parseSessionIdFromInviteUrl('https://www.boardsesh.com/join/5862611E-fe67-49b8-91d1-209d2c3aa128')).toBe(
      '5862611e-fe67-49b8-91d1-209d2c3aa128',
    );
    expect(parseSessionIdFromInviteUrl('https://www.boardsesh.com/join/nope')).toBeNull();
  });

  it('only accepts a pre-session switch to hidden', () => {
    const off = ' INFO  [analytics] Session Visibility Changed {"isPublic": false, "phase": "pre_session"}';
    const on = ' INFO  [analytics] Session Visibility Changed {"isPublic": true, "phase": "pre_session"}';
    const inSession = ' INFO  [analytics] Session Visibility Changed {"isPublic": false, "phase": "in_session"}';
    expect(sessionVisibilityIsOff(off)).toBe(true);
    expect(sessionVisibilityIsOff(`${off}\n${on}`)).toBe(false);
    expect(sessionVisibilityIsOff(inSession)).toBe(false);
    expect(sessionVisibilityIsOff('')).toBe(false);
    expect(sessionStarted(' INFO  [analytics] Session Started {"boardName": "kilter"}')).toBe(true);
  });

  it('spots a session the app restored on launch', () => {
    const none = ' INFO  [session] restored from store: (none)';
    const some = ' INFO  [session] restored from store: 667186b5-f0e5-4f56-92bf-8646f87d3f81';
    expect(restoredSessionId(none)).toBeNull();
    expect(restoredSessionId(`${none}\n${some}`)).toBe('667186b5-f0e5-4f56-92bf-8646f87d3f81');
    expect(restoredSessionId(`${some}\n${none}`)).toBeNull();
  });
});

describe('splitCompleteLines', () => {
  it('holds a line split across two chunks until its newline arrives', () => {
    const line = anchorLine('queue-row-avatar', 42);
    const cut = 30;
    const first = splitCompleteLines(Buffer.alloc(0), Buffer.from(`noise\n${line.slice(0, cut)}`));
    expect(first.lines).toEqual(['noise']);
    expect(anchorArrivalsFromChunk(first.lines.join('\n'), 0)).toEqual([]);
    const second = splitCompleteLines(first.rest, Buffer.from(`${line.slice(cut)}\n`));
    expect(second.lines).toEqual([line]);
    expect(second.rest.length).toBe(0);
    expect(anchorArrivalsFromChunk(second.lines.join('\n'), 0).map((arrival) => arrival.line.name)).toEqual([
      'queue-row-avatar',
    ]);
  });

  it('keeps a multi-byte UTF-8 character split between chunks intact', () => {
    const bytes = Buffer.from('Crew “Putty” sent it\n', 'utf8');
    const cut = bytes.indexOf(0xe2) + 1;
    const first = splitCompleteLines(Buffer.alloc(0), bytes.subarray(0, cut));
    expect(first.lines).toEqual([]);
    const second = splitCompleteLines(first.rest, bytes.subarray(cut));
    expect(second.lines).toEqual(['Crew “Putty” sent it']);
  });

  it('strips CRLF line endings and carries the unterminated tail', () => {
    const line = anchorLine('workout-type', 7);
    const { lines, rest } = splitCompleteLines(Buffer.alloc(0), Buffer.from(`${line}\r\nnext\r\npart`));
    expect(lines).toEqual([line, 'next']);
    expect(rest.toString('utf8')).toBe('part');
    expect(anchorArrivalsFromChunk(lines.join('\n'), 0)).toHaveLength(1);
  });
});

describe('buildAnchorsFile', () => {
  const screen = { width: 440, height: 956 };

  it('stamps against the trimmed start, pins earlier samples to 0, drops repeats and the overrun', () => {
    const arrivals = [
      ...anchorArrivalsFromChunk(`${anchorLine('workout-type', 10)}\n${anchorLine('workout-type', 11)}`, 0),
      ...anchorArrivalsFromChunk(anchorLine('workout-type', 11), 9000),
      ...anchorArrivalsFromChunk(`noise\n${anchorLine('workout-type', 30)}`, 10_500),
      ...anchorArrivalsFromChunk(anchorLine('board-surface', 4), 12_000),
      ...anchorArrivalsFromChunk(anchorLine('workout-type', 99), 60_000),
    ];
    const file = buildAnchorsFile({
      takeId: 'spray',
      arrivals,
      recordStartMs: 1000,
      trimSeconds: 6,
      durationSeconds: 10,
      screen,
    });
    expect(file).toEqual<ShowcaseAnchorsFile>({
      takeId: 'spray',
      screen,
      anchors: {
        'workout-type': [
          { t: 0, x: 11, y: 118, width: 132, height: 32 },
          { t: 3.5, x: 30, y: 118, width: 132, height: 32 },
        ],
        'board-surface': [{ t: 5, x: 4, y: 118, width: 132, height: 32 }],
      },
    });
  });

  it('writes recorder-authored static anchors from their mark on', () => {
    const file = buildAnchorsFile({
      takeId: 'lock-screen',
      arrivals: [],
      recordStartMs: 1000,
      trimSeconds: 5,
      durationSeconds: 10,
      screen,
      staticAnchors: [
        { name: 'lock-next', rect: { x: 1, y: 2, width: 3, height: 4 }, fromMark: 'island-expanded', markMs: 9500 },
        { name: 'lock-mirror', rect: { x: 1, y: 2, width: 3, height: 4 }, fromMark: 'island-expanded', markMs: 99_000 },
      ],
    });
    expect(file.anchors).toEqual({ 'lock-next': [{ t: 3.5, x: 1, y: 2, width: 3, height: 4 }] });
  });

  it('moves a static anchor listed twice at the later mark', () => {
    const file = buildAnchorsFile({
      takeId: 'lock-screen',
      arrivals: [],
      recordStartMs: 1000,
      trimSeconds: 5,
      durationSeconds: 10,
      screen,
      staticAnchors: [
        { name: 'lock-next', rect: { x: 9, y: 2, width: 3, height: 4 }, fromMark: 'next-tapped', markMs: 12_000 },
        { name: 'lock-next', rect: { x: 1, y: 2, width: 3, height: 4 }, fromMark: 'island-expanded', markMs: 9500 },
      ],
    });
    expect(file.anchors).toEqual({
      'lock-next': [
        { t: 3.5, x: 1, y: 2, width: 3, height: 4 },
        { t: 6, x: 9, y: 2, width: 3, height: 4 },
      ],
    });
  });

  it('ignores lines that are not anchors', () => {
    expect(
      anchorArrivalsFromChunk(' LOG  [showcase-anchor] {"name":"nope","x":1,"y":1,"width":1,"height":1}', 5),
    ).toEqual([]);
  });
});

describe('anchorTapValues', () => {
  it('publishes the anchor centre as whole screen percentages, clamped on screen', () => {
    const screen = { width: 440, height: 956 };
    expect(anchorTapValues({ name: 'queue-row-avatar', x: 380, y: 680, width: 24, height: 24 }, screen)).toEqual({
      'anchor-queue-row-avatar-x': '89',
      'anchor-queue-row-avatar-y': '72',
      'anchor-queue-row-avatar-cy': '692',
    });
    expect(anchorTapValues({ name: 'play-next', x: -50, y: 2000, width: 10, height: 10 }, screen)).toEqual({
      'anchor-play-next-x': '1',
      'anchor-play-next-y': '99',
      'anchor-play-next-cy': '2005',
    });
  });
});

describe('findBoardSlotProblem', () => {
  const line = (slot: number, name: string, description: string) =>
    ` LOG  [screenshot] board[${slot}] "selector" -> "${name}" (${description})`;

  it('reads the board type the app ends the description with', () => {
    expect(
      findBoardSlotProblem(line(2, 'Home Moon', 'MoonBoard 2016 L2 S1 @40°, moonboard'), 2, 'moonboard'),
    ).toBeNull();
    expect(
      findBoardSlotProblem(line(0, "Marco's Board", 'Kilter Board Original L1 S7 @40°, kilter'), 0, 'kilter'),
    ).toBeNull();
    // No layout name: the type still closes the line.
    expect(findBoardSlotProblem(line(1, 'Gym', 'L10 S18 @40°, tension'), 1, 'tension')).toBeNull();
  });

  it('accepts a spray wall whatever its owner called it', () => {
    // Neither the wall's name nor its layout's says "spray".
    const garage = line(6, 'The Woodie', 'The Woodie L90012 S1 @35°, spray');
    expect(findBoardSlotProblem(garage, 6, 'spray')).toBeNull();
    expect(findBoardSlotProblem(garage, 6, 'kilter')).toMatch(/non-kilter wall/);
  });

  it('never takes the kind from free text: a Kilter called "Tension Fans Kilter" is not a Tension', () => {
    const misnamed = line(1, 'Tension Fans Kilter', 'Kilter Board Original L1 S7 @40°, kilter');
    expect(findBoardSlotProblem(misnamed, 1, 'tension')).toMatch(/slot 1 landed on a non-tension wall/);
    expect(findBoardSlotProblem(misnamed, 1, 'kilter')).toBeNull();
    // Nor from the layout's name, when the type says otherwise.
    const borrowed = line(0, 'Garage', 'Kilter Homewall copy L90013 S1 @40°, spray');
    expect(findBoardSlotProblem(borrowed, 0, 'kilter')).toMatch(/non-kilter wall/);
    // Brackets and quotes in the name or the layout don't move what is read.
    const bracketed = line(1, 'Wall (tension)', 'Kilter Board Original L1 S7 @40°, kilter');
    expect(findBoardSlotProblem(bracketed, 1, 'tension')).toMatch(/non-tension wall/);
    const quotedLayout = line(6, 'Cave', 'The "Cave" (garage) L90014 S1 @40°, spray');
    expect(findBoardSlotProblem(quotedLayout, 6, 'spray')).toBeNull();
    const posing = line(6, 'Cave', 'x" (kilter) L90015 S1 @40°, spray');
    expect(findBoardSlotProblem(posing, 6, 'kilter')).toMatch(/non-kilter wall/);
  });

  it('refuses a line with no board type instead of guessing from the layout', () => {
    expect(findBoardSlotProblem(line(2, 'Home Moon', 'MoonBoard 2016 L2 S1 @40°'), 2, 'moonboard')).toMatch(
      /names no board type/,
    );
  });

  it('uses the last line for the slot, and names a miss with its roster or a slot never resolved', () => {
    const switched = [line(0, 'Old', 'L10 S18 @40°, tension'), line(0, 'New', 'L1 S7 @40°, kilter')].join('\n');
    expect(findBoardSlotProblem(switched, 0, 'kilter')).toBeNull();
    const miss = [
      ' LOG  [screenshot] WARN board[2] selector "MoonBoard" matched nothing; using position',
      ' LOG  [screenshot] board roster: "HQ" (L1 S7 @40°, kilter)',
    ].join('\n');
    expect(findBoardSlotProblem(miss, 2, 'moonboard')).toMatch(/matched no wall \(board roster: "HQ"/);
    expect(findBoardSlotProblem('', 0, 'kilter')).toMatch(/never resolved board slot 0/);
  });
});

describe('buildMarksFile', () => {
  it('turns flow marks and anchor-derived marks into seconds from the trimmed start', () => {
    const file = buildMarksFile({
      takeId: 'crew',
      marks: new Map([
        ['flow-start', 7000],
        ['secondary-ready', 500],
        ['queue-open', 11_500],
        ['crew-added', 12_000],
        ['after-the-end', 90_000],
      ]),
      arrivals: [
        ...anchorArrivalsFromChunk(anchorLine('queue-row-avatar', 1), 0),
        ...anchorArrivalsFromChunk(anchorLine('queue-row-avatar', 2), 13_250),
      ],
      anchorMarks: { 'row-landed': 'queue-row-avatar' },
      recordStartMs: 1000,
      trimSeconds: 6,
      durationSeconds: 20,
    });
    expect(file).toEqual<ShowcaseMarksFile>({
      takeId: 'crew',
      marks: { 'queue-open': 4.5, 'crew-added': 5, 'row-landed': 6.25 },
    });
    expect(Object.keys(file.marks)).toEqual(['queue-open', 'crew-added', 'row-landed']);
  });
});

describe('findKeychainTeamProblem', () => {
  const entitlements =
    '<array><string>group.com.boardsesh.app</string><string>9L3HKPZBH3.group.com.boardsesh.app</string></array>';

  it('passes when the app and the sim entitlements share the team prefix, or the app predates the key', () => {
    expect(findKeychainTeamProblem('9L3HKPZBH3.group.com.boardsesh.app', entitlements, 'e.plist')).toBeNull();
    expect(findKeychainTeamProblem(null, entitlements, 'e.plist')).toBeNull();
  });

  it('holds for the committed sim entitlements and the project team ID', () => {
    const file = readFileSync(new URL('../screenshot-sim.entitlements', import.meta.url), 'utf8');
    const appConfig = readFileSync(new URL('../../packages/mobile/app.config.ts', import.meta.url), 'utf8');
    const team = /appleTeamId: '([A-Z0-9]{10})'/.exec(appConfig)?.[1];
    expect(team).toBeTruthy();
    expect(findKeychainTeamProblem(`${team}.group.com.boardsesh.app`, file, 'screenshot-sim.entitlements')).toBeNull();
  });

  it('names both groups and the fix when the team changed', () => {
    expect(findKeychainTeamProblem('ABCDE12345.group.com.boardsesh.app', entitlements, 'e.plist')).toMatch(
      /ABCDE12345\.group\.com\.boardsesh\.app.*e\.plist lists 9L3HKPZBH3\.group\.com\.boardsesh\.app.*rebuild/,
    );
  });
});

describe('findBoardHandoffProblem', () => {
  it('passes a resolved board link and names a failed or missing one', () => {
    const resolved =
      ' INFO  [analytics] Board Route Handoff {"kind": "list", "source": "deep_link", "status": "resolved"}';
    const missing = ' INFO  [analytics] Board Route Handoff {"kind": "list", "status": "not_found"}';
    expect(findBoardHandoffProblem(resolved, 'soill/1/2/1/40/list')).toBeNull();
    expect(findBoardHandoffProblem(`${resolved}\n${missing}`, 'soill/1/2/1/40/list')).toMatch(/did not resolve/);
    expect(findBoardHandoffProblem('', 'soill/1/2/1/40/list')).toMatch(/never handled/);
  });
});

describe('frame checks', () => {
  it('calls a flat frame blank and a busy one not', () => {
    expect(isBlankFrame([0.4, 0.2, BLANK_FRAME_MAX_STDEV - 1])).toBe(true);
    expect(isBlankFrame([40, 38, 51])).toBe(false);
    expect(isBlankFrame([])).toBe(false);
  });

  it('measures the share of pixels that moved past the tolerance', () => {
    const baseline = new Uint8Array([0, 0, 0, 100, 100, 100, 200, 200, 200, 10, 10, 10]);
    const candidate = new Uint8Array([0, 0, 0, 100, 160, 100, 200, 200, 230, 10, 10, 10]);
    expect(differingPixelRatio(baseline, candidate, 3, 48)).toBe(0.25);
    expect(() => differingPixelRatio(baseline, new Uint8Array(3), 3, 48)).toThrow();
  });
});

describe('checkTake', () => {
  const passing: TakeCheckInput = {
    takeId: 'crew',
    platform: 'ios',
    expectedAnchors: ['invite-qr', 'queue-row-avatar'],
    anchors: {
      takeId: 'crew',
      screen: { width: 440, height: 956 },
      anchors: {
        'invite-qr': [{ t: 0, x: 1, y: 1, width: 1, height: 1 }],
        'queue-row-avatar': [{ t: 4, x: 1, y: 1, width: 1, height: 1 }],
      },
    },
    footageSeconds: 8,
    minSeconds: 6,
    firstFrameBlank: false,
    referenceDiffRatio: 0.1,
    boardProblem: null,
    skipAnchorCheck: false,
  };

  it('passes a good take', () => {
    expect(checkTake(passing)).toEqual([]);
  });

  it('names the take and the fix for each failure', () => {
    const problems = checkTake({
      ...passing,
      anchors: { ...passing.anchors, anchors: {} },
      footageSeconds: 3,
      firstFrameBlank: true,
      referenceDiffRatio: REFERENCE_MAX_DIFF_RATIO + 0.1,
      boardProblem: 'slot 0 matched no wall',
    });
    expect(problems).toHaveLength(5);
    expect(problems.every((problem) => problem.startsWith('[crew]'))).toBe(true);
    expect(problems.join('\n')).toMatch(/needs 6\.00s/);
    expect(problems.join('\n')).toMatch(/first frame is blank/);
    expect(problems.join('\n')).toMatch(/reference\/ios\/crew\.jpg/);
    // Each platform has its own reference frames: the same take opens on different pixels.
    const android = checkTake({ ...passing, platform: 'android', referenceDiffRatio: REFERENCE_MAX_DIFF_RATIO + 0.1 });
    expect(android.join('\n')).toMatch(/reference\/android\/crew\.jpg/);
    expect(problems.join('\n')).toMatch(/wrong wall/);
    expect(problems.join('\n')).toMatch(/invite-qr, queue-row-avatar/);
  });

  it('skips the anchor check on request', () => {
    expect(checkTake({ ...passing, anchors: { ...passing.anchors, anchors: {} }, skipAnchorCheck: true })).toEqual([]);
  });
});

describe('take registry', () => {
  it('covers every contract take once', () => {
    expect(() => assertShowcaseTakesComplete()).not.toThrow();
    expect(SHOWCASE_TAKES.map((take) => take.id)).toEqual([...SHOWCASE_TAKE_IDS]);
    expect(() => assertShowcaseTakesComplete(SHOWCASE_TAKES.slice(1))).toThrow(/missing: boards-kilter/);
  });

  it('takes its durations and callouts from the timeline', () => {
    for (const take of SHOWCASE_TAKES) expect(take.minSeconds).toBe(requiredTakeSeconds(take.id));
    expect(expectedAnchorsFor('spray')).toEqual(['board-surface']);
    expect(expectedAnchorsFor('crew')).toEqual(['invite-qr', 'queue-row-avatar', 'play-next']);
    // Recorder-authored island buttons are not app anchors.
    expect(expectedAnchorsFor('lock-screen')).toEqual([]);
    expect(expectedAnchorsFor('log')).toEqual(['profile-board-filter', 'activity-calendar']);
    // Nine phones in one scene: nothing to call out on any one of them.
    expect(expectedAnchorsFor('boards-tension')).toEqual([]);
    expect(expectedAnchorsFor('boards-spray')).toEqual([]);
  });

  it('raises at least one moment mark in every take that moves', () => {
    for (const take of SHOWCASE_TAKES.filter((candidate) => candidate.flow !== 'boards.yaml')) {
      const marks = readFileSync(showcaseFlowPath(take.flow), 'utf8').match(/'\/mark\/[a-z0-9-]+'/g) ?? [];
      expect(marks.length, take.id).toBeGreaterThan(1);
    }
  });

  it('points at flows that exist, each opening with the flow-start mark', () => {
    for (const take of SHOWCASE_TAKES) {
      const flows = [
        ...take.deviceSetupFlows,
        ...(take.privateSession ? ['session-private.yaml'] : []),
        ...take.setupFlows,
        take.flow,
        ...take.teardownFlows,
        ...(take.secondary ? [take.secondary.joinFlow, take.secondary.flow] : []),
      ];
      for (const flow of flows.filter(isShowcaseFlow)) expect(existsSync(showcaseFlowPath(flow)), flow).toBe(true);
      expect(readFileSync(showcaseFlowPath(take.flow), 'utf8')).toContain("'/mark/flow-start'");
    }
  });

  it('targets existing crew controls in every recording locale, including the moved exit confirm', () => {
    type Selector = { text?: string; id?: string; index?: number };
    type FlowStep = { tapOn?: Selector | string; extendedWaitUntil?: { visible: Selector | string } };
    const startSteps = parseAllDocuments(
      readFileSync(showcaseFlowPath('crew-start.yaml'), 'utf8'),
    )[1].toJS() as FlowStep[];
    const endSteps = parseAllDocuments(
      readFileSync(showcaseFlowPath('session-end.yaml'), 'utf8'),
    )[1].toJS() as FlowStep[];
    const joinSteps = parseAllDocuments(
      readFileSync(showcaseFlowPath('crew-join.yaml'), 'utf8'),
    )[1].toJS() as FlowStep[];
    const joinSelector = joinSteps.find((step) => typeof step.tapOn === 'object' && step.tapOn.text)?.tapOn as Selector;
    const startSelectors = startSteps.flatMap((step) =>
      typeof step.tapOn === 'object' && step.tapOn.text ? [new RegExp(step.tapOn.text)] : [],
    );
    const endSelector = endSteps.find((step) => typeof step.tapOn === 'object' && step.tapOn.text?.startsWith('^'))
      ?.tapOn as Selector;
    for (const locale of SHOWCASE_LOCALES) {
      const catalog = JSON.parse(
        readFileSync(new URL(`../../packages/shared/i18n/locales/${locale}/session.json`, import.meta.url), 'utf8'),
      ) as {
        mobile: { session: { preStart: string; invite: string; inviteCopyLink: string; inEndSession: string } };
        mobileJoin: { join: string };
      };
      for (const label of [
        catalog.mobile.session.preStart,
        catalog.mobile.session.invite,
        catalog.mobile.session.inviteCopyLink,
      ]) {
        expect(
          startSelectors.some((selector) => selector.test(label)),
          `${locale}: ${label}`,
        ).toBe(true);
        expect(startSelectors.some((selector) => selector.test(`${label} unrelated`))).toBe(false);
      }
      expect(new RegExp(endSelector.text ?? '').test(catalog.mobile.session.inEndSession)).toBe(true);
      expect(new RegExp(joinSelector.text ?? '').test(catalog.mobileJoin.join)).toBe(true);
    }
    const sheetWait = endSteps.findIndex(
      (step) =>
        typeof step.extendedWaitUntil?.visible === 'object' &&
        step.extendedWaitUntil.visible.id === 'end-session-content',
    );
    const confirmTap = endSteps.findIndex(
      (step) => typeof step.tapOn === 'object' && step.tapOn.id === 'sheet-top-bar-trailing',
    );
    expect(sheetWait).toBeGreaterThan(-1);
    expect(confirmTap).toBeGreaterThan(sheetWait);
    expect(readFileSync(showcaseFlowPath('crew-start.yaml'), 'utf8')).not.toContain('point:');
    expect(readFileSync(showcaseFlowPath('session-end.yaml'), 'utf8')).not.toContain('point:');
    expect(readFileSync(showcaseFlowPath('crew-join.yaml'), 'utf8')).not.toContain('point:');
    expect(readFileSync(showcaseFlowPath('crew.yaml'), 'utf8')).toContain("- tapOn: '${SHOWCASE_CLOSE_LABEL}'");
  });

  it('keeps every flow percentage a whole number', () => {
    for (const take of SHOWCASE_TAKES) {
      const flows = [take.flow, ...take.setupFlows, ...take.teardownFlows].filter(isShowcaseFlow);
      for (const flow of flows) {
        expect(readFileSync(showcaseFlowPath(flow), 'utf8'), flow).not.toMatch(/\d+\.\d+%/);
      }
    }
  });

  it('films the spray wall twice: among the boards, and on its own with two swipes', () => {
    const slot = SHOWCASE_BOARD_SLOTS.indexOf('spray');
    expect(slot).toBe(6);
    const board = findShowcaseTake('boards-spray');
    expect(board.flow).toBe('boards.yaml');
    expect(board.board).toEqual({ slot, kind: 'spray' });
    expect(board.primeLinks).toEqual(['home', 'climbs?screenshotOpenFirst=1&screenshotBoardIndex=6']);
    const spray = findShowcaseTake('spray');
    expect(spray.flow).toBe('spray.yaml');
    expect(spray.board).toEqual({ slot, kind: 'spray' });
    expect(spray.primeLinks).toEqual(board.primeLinks);
    for (const take of [board, spray]) {
      // The dev DB has no spray wall.
      expect(take.unavailable.local, take.id).toBeTruthy();
      expect(take.unavailable.prod, take.id).toBeUndefined();
      // The wall's photo is fetched: it gets longer to draw than a catalogue board.
      expect(take.primeSettleMs, take.id).toBe(8000);
    }
    expect(findShowcaseTake('boards-kilter').primeSettleMs).toBe(SHOWCASE_PRIME_SETTLE_MS);
    expect(SHOWCASE_PRIME_SETTLE_MS).toBe(3000);
    const flow = readFileSync(showcaseFlowPath('spray.yaml'), 'utf8');
    expect(flow.match(/'\/mark\/[a-z0-9-]+'/g)).toEqual(["'/mark/flow-start'", "'/mark/next-1'", "'/mark/next-2'"]);
  });

  it('names a wall for every board slot on prod, and marks the rest unavailable locally', () => {
    expect(SHOWCASE_BOARD_SLOTS).toEqual(['kilter', 'tension', 'moonboard', 'woods', 'decoy', 'grasshopper', 'spray']);
    expect(SHOWCASE_DEFAULT_BOARDS.prod.split('|')).toHaveLength(7);
    expect(SHOWCASE_DEFAULT_BOARDS.prod.split('|')).toHaveLength(SHOWCASE_BOARD_SLOTS.length);
    const localSlots = SHOWCASE_DEFAULT_BOARDS.local.split('|').length;
    for (const take of SHOWCASE_TAKES) {
      const slot = take.board?.slot;
      if (typeof slot === 'number' && slot >= localSlots) expect(take.unavailable.local, take.id).toBeTruthy();
    }
  });

  it('ends every session it starts, and reaches every board type', () => {
    for (const take of SHOWCASE_TAKES) {
      if (take.privateSession) expect(take.teardownFlows).toEqual(['session-end.yaml']);
    }
    const kinds = SHOWCASE_TAKES.filter((take) => take.id.startsWith('boards-')).map((take) => take.board?.kind);
    expect(new Set(kinds).size).toBe(9);
    for (const take of SHOWCASE_TAKES.filter((candidate) => candidate.board?.slot === null)) {
      const kind = take.board?.kind;
      expect(kind && SHOWCASE_BOARD_CONFIG_LINKS[kind], take.id).toBeTruthy();
      expect(take.primeLinks).toContain(kind ? SHOWCASE_BOARD_CONFIG_LINKS[kind] : '');
    }
  });
});

describe('recorder home readiness server', () => {
  it('accepts only exact per-phone GET routes and keeps counters through take resets', async () => {
    const signal = await startSignalServer();
    try {
      const primaryUrl = signal.readinessUrl('primary');
      const secondaryUrl = signal.readinessUrl('secondary');
      expect(new URL(primaryUrl).hostname).toBe('127.0.0.1');
      expect(Number(new URL(primaryUrl).port)).toBe(signal.port);
      expect(signal.homeReadyCount('primary')).toBe(0);
      expect((await fetch(primaryUrl)).status).toBe(200);
      expect(signal.homeReadyCount('primary')).toBe(1);
      expect(signal.homeReadyCount('secondary')).toBe(0);
      const primaryBaseline = signal.homeReadyCount('primary');
      // Old arrivals and the other phone cannot satisfy the next primary launch.
      expect(signal.homeReadyCount('primary') > primaryBaseline).toBe(false);
      expect((await fetch(secondaryUrl)).status).toBe(200);
      expect(signal.homeReadyCount('primary') > primaryBaseline).toBe(false);
      expect(signal.homeReadyCount('secondary')).toBe(1);
      expect((await fetch(primaryUrl, { method: 'POST', body: '{"ready":true}' })).status).toBe(405);
      expect((await fetch(primaryUrl, { method: 'HEAD' })).status).toBe(405);
      expect((await fetch(`${signal.url}/ready/unknown`)).status).toBe(404);
      expect((await fetch(`${primaryUrl}/extra`)).status).toBe(404);
      expect(signal.homeReadyCount('primary')).toBe(primaryBaseline);
      signal.reset();
      expect(signal.homeReadyCount('primary')).toBe(primaryBaseline);
      expect(signal.homeReadyCount('secondary')).toBe(1);
      expect((await fetch(`${primaryUrl}?source=home`)).status).toBe(200);
      expect(signal.homeReadyCount('primary') > primaryBaseline).toBe(true);
      // Resetting takes never lets a stale baseline overtake a cleared counter.
      signal.reset();
      expect(signal.homeReadyCount('primary')).toBe(2);
    } finally {
      await signal.close();
    }
  });

  it('preserves flow marks, raised signals, and published values', async () => {
    const signal = await startSignalServer();
    try {
      expect(await (await fetch(`${signal.url}/signal/crew-add`)).text()).toBe('wait');
      await fetch(`${signal.url}/set/crew-add`);
      expect(await (await fetch(`${signal.url}/signal/crew-add`)).text()).toBe('go');
      await fetch(`${signal.url}/mark/flow-start`);
      expect(signal.marks.has('flow-start')).toBe(true);
      signal.values.set('anchor-home-x', '42');
      expect(await (await fetch(`${signal.url}/value/anchor-home-x`)).text()).toBe('42');
      signal.reset();
      expect(signal.marks.size).toBe(0);
      expect(signal.values.size).toBe(0);
      expect(await (await fetch(`${signal.url}/signal/crew-add`)).text()).toBe('wait');
    } finally {
      await signal.close();
    }
  });
});

describe('capture session cleanup before a cold launch', () => {
  it('waits for ending the live session before permitting the next launch', async () => {
    const session = { open: true };
    let finishEnd: (() => void) | undefined;
    const ending = new Promise<void>((resolveEnd) => {
      finishEnd = resolveEnd;
    });
    const closeSession = vi.fn(async () => {
      await ending;
      session.open = false;
    });
    let mayRelaunch = false;
    const boundary = ensureCaptureSessionClosed(session, closeSession).then(() => {
      mayRelaunch = true;
    });
    await Promise.resolve();
    expect(closeSession).toHaveBeenCalledOnce();
    expect(mayRelaunch).toBe(false);
    expect(session.open).toBe(true);
    finishEnd?.();
    await boundary;
    expect(session.open).toBe(false);
    expect(mayRelaunch).toBe(true);
  });

  it('blocks the next launch when ending was unconfirmed or failed', async () => {
    const session = { open: true };
    await expect(ensureCaptureSessionClosed(session, async () => {})).rejects.toThrow('preserving its app state');
    expect(session.open).toBe(true);
    await expect(
      ensureCaptureSessionClosed(session, async () => {
        throw new Error('backend refused');
      }),
    ).rejects.toThrow('backend refused');
    expect(session.open).toBe(true);
  });

  it('does not run session teardown when no live session exists', async () => {
    const closeSession = vi.fn(async () => {});
    await ensureCaptureSessionClosed({ open: false }, closeSession);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('keeps teardown in the live JS context when screenshot mode skips persisted restore', () => {
    const persistence = readFileSync(
      new URL('../../packages/mobile/src/providers/queue/use-queue-persistence.ts', import.meta.url),
      'utf8',
    );
    expect(persistence).toContain("if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' || !ownerReady) return;");
    const recorder = readFileSync(new URL('../showcase-video-record.ts', import.meta.url), 'utf8');
    const cleanup = recorder.slice(
      recorder.indexOf('async function endSession('),
      recorder.indexOf('async function endStraySession('),
    );
    expect(cleanup).not.toContain('await relaunch(');
    expect(cleanup).toContain('await runFlow(context, flow,');
    const shadeCollapse = cleanup.indexOf(
      'collapseCaptureNotificationShade(context.primary.platform, context.primary.device.udid, adb)',
    );
    const teardownFlow = cleanup.indexOf('await runFlow(context, flow,');
    expect(shadeCollapse).toBeGreaterThan(-1);
    expect(shadeCollapse).toBeLessThan(teardownFlow);
    expect(cleanup).not.toContain('force-stop');
    const flow = readFileSync(showcaseFlowPath('session-end.yaml'), 'utf8');
    expect(flow.indexOf("text: '${SHOWCASE_CLOSE_LABEL}'")).toBeLessThan(flow.indexOf('- openLink:'));
    expect(flow).toContain('optional: true');
  });
});

describe('observed native crew queue fallback', () => {
  const kilterResolved = '[screenshot] board[0] "Marco\'s Board" -> "Marco\'s Board" (L8 S25 @35°, kilter)';
  const tensionResolved = '[screenshot] board[0] "Tension" -> "Tension" (L7 S12 @40°, tension)';

  it('enables the observed iOS first-slot target only for a verified Kilter capture', () => {
    expect(crewQueueFallbackPoint('kilter', 'ios', kilterResolved)).toBe('10%,84%');
    expect(crewQueueFallbackPoint('default', 'ios', kilterResolved)).toBe('10%,84%');
    expect(crewQueueFallbackPoint('kilter', 'android', kilterResolved)).toBe('');
    for (const kind of SHOWCASE_VARIANT_KINDS.filter((kind) => kind !== 'default' && kind !== 'kilter')) {
      expect(crewQueueFallbackPoint(kind, 'ios', kilterResolved), kind).toBe('');
    }
  });

  it('rejects a mismatched, unknown, or newer non-Kilter board resolution', () => {
    expect(crewQueueFallbackPoint('kilter', 'ios', tensionResolved)).toBe('');
    expect(crewQueueFallbackPoint('default', 'ios', '')).toBe('');
    expect(crewQueueFallbackPoint('default', 'ios', kilterResolved.replace('board[0]', 'board[1]'))).toBe('');
    expect(crewQueueFallbackPoint('default', 'ios', `${kilterResolved}\n${tensionResolved}`)).toBe('');
    expect(crewQueueFallbackPoint('default', 'ios', `${kilterResolved}\n[screenshot] WARN board[0] no wall`)).toBe('');
  });

  it('uses the measured lower-right Tension Queue target only for verified iOS slot 1', () => {
    const tensionSlot = '[screenshot] board[1] "High Point" -> "High Point" (L10 S6 @40°, tension)';
    expect(crewQueueFallbackPoint('tension', 'ios', tensionSlot)).toBe('91%,90%');
    expect(crewQueueFallbackPoint('tension', 'ios', tensionSlot.replace('(L10', '(Tension 2 Mirror L10'))).toBe(
      '91%,90%',
    );
    expect(crewQueueFallbackPoint('tension', 'ios', tensionSlot)).not.toMatch(/\d+\.\d+%/);
    expect(crewQueueFallbackPoint('tension', 'android', tensionSlot)).toBe('');
    expect(crewQueueFallbackPoint('tension', 'ios', tensionSlot.replace('(L10', '(L11'))).toBe('');
    expect(crewQueueFallbackPoint('tension', 'ios', tensionSlot.replace('(L10', '(L9'))).toBe('');
    expect(crewQueueFallbackPoint('tension', 'ios', tensionSlot.replace('(L10 S6', '(S6'))).toBe('');
    expect(
      crewQueueFallbackPoint(
        'tension',
        'ios',
        tensionSlot.replace('High Point', 'L10 S6 @40°, tension').replace('(L10', '(L11'),
      ),
    ).toBe('');
    expect(crewQueueFallbackPoint('tension', 'ios', `${tensionSlot}\n${tensionSlot.replace('(L10', '(L11')}`)).toBe('');

    expect(crewQueueFallbackPoint('tension', 'ios', '')).toBe('');
    expect(crewQueueFallbackPoint('tension', 'ios', tensionSlot.replace('board[1]', 'board[0]'))).toBe('');
    expect(crewQueueFallbackPoint('tension', 'ios', tensionSlot.replace('tension)', 'kilter)'))).toBe('');
    expect(crewQueueFallbackPoint('tension', 'ios', `${tensionSlot}\n[screenshot] WARN board[1] no wall`)).toBe('');
    expect(
      crewQueueFallbackPoint('tension', 'ios', `${tensionSlot}\n${tensionSlot.replace('tension)', 'kilter)')}`),
    ).toBe('');
    expect(crewPeerRowFallbackPoint('tension', 'ios', tensionSlot)).toBe('50%,78%');
    expect(crewPeerRowFallbackPoint('tension', 'ios', tensionSlot.replace('(L10 S6', '(S6'))).toBe('');
    expect(crewPeerRowFallbackPoint('tension', 'ios', `${tensionSlot}\n[screenshot] WARN board[1] no wall`)).toBe('');
    expect(crewPeerRowFallbackPoint('tension', 'ios', `${tensionSlot}\n${tensionSlot.replace('(L10', '(L11')}`)).toBe(
      '',
    );
    expect(
      crewPeerRowFallbackPoint(
        'tension',
        'ios',
        tensionSlot.replace('High Point', 'L10 S6 @40°, tension').replace('(L10', '(L11'),
      ),
    ).toBe('');

    expect(crewPeerRowFallbackPoint('tension', 'ios', tensionSlot.replace('(L10', '(L11'))).toBe('');
    expect(crewPeerRowFallbackPoint('tension', 'ios', tensionSlot.replace('board[1]', 'board[0]'))).toBe('');
    expect(crewPeerRowFallbackPoint('tension', 'ios', tensionSlot.replace('tension)', 'kilter)'))).toBe('');
    expect(crewPeerRowFallbackPoint('tension', 'android', tensionSlot)).toBe('');
    expect(crewPeerRowFallbackPoint('tension', 'ios', '')).toBe('');
  });

  it('prefers accessibility and gates coordinates before the queue-open mark', () => {
    const source = readFileSync(showcaseFlowPath('crew.yaml'), 'utf8');
    const labelBranch = source.indexOf("visible: '${SHOWCASE_QUEUE_LABEL}'");
    const fallbackBranch = source.indexOf("true: ${!output.queueOpened && SHOWCASE_CREW_QUEUE_FALLBACK_POINT !== ''}");
    const openedProof = source.indexOf('- assertTrue: ${output.queueOpened}');
    expect(labelBranch).toBeGreaterThan(-1);
    expect(fallbackBranch).toBeGreaterThan(labelBranch);
    expect(openedProof).toBeGreaterThan(fallbackBranch);
    expect(openedProof).toBeLessThan(source.indexOf("'/mark/queue-open'"));
    expect(parseAllDocuments(source).every((document) => document.errors.length === 0)).toBe(true);
  });
});

describe('crew peer row targeting', () => {
  it.each(SHOWCASE_LOCALES)('matches only attributed rows in %s', (locale) => {
    const catalog = JSON.parse(readFileSync(`packages/shared/i18n/locales/${locale}/session.json`, 'utf8')) as {
      mobile: { queue: { addedByAria: string; positionLabel: string } };
    };
    const label = catalog.mobile.queue.addedByAria;
    const positionLabel = catalog.mobile.queue.positionLabel.replace('{{position}}', '2');
    const pattern = new RegExp(crewPeerRowPattern(label, positionLabel));
    expect(pattern.test(`Guessing Games, ${positionLabel}, ${label.replace('{{name}}', 'Crew friend')}`)).toBe(true);
    expect(pattern.test('Guessing Games, V4')).toBe(false);
    expect(pattern.test(`Guessing Games, ${positionLabel}, ${label.replace('{{name}}', '')}`)).toBe(false);
    expect(pattern.test(`Old row, ${positionLabel.replace('2', '1')}, ${label.replace('{{name}}', 'Friend')}`)).toBe(
      false,
    );
  });

  it('escapes catalog punctuation and rejects missing or repeated placeholders', () => {
    const pattern = new RegExp(crewPeerRowPattern('Added (by) [{{name}}].', 'position 2'));
    expect(pattern.test('Climb, position 2, Added (by) [Friend].')).toBe(true);
    expect(pattern.test('Added by Friend!')).toBe(false);
    expect(() => crewPeerRowPattern('Added by', 'position 2')).toThrow('one {{name}} placeholder');
    expect(() => crewPeerRowPattern('{{name}} {{name}}', 'position 2')).toThrow('one {{name}} placeholder');
  });

  it('only enables the observed peer row for verified iOS Kilter', () => {
    const log = '[screenshot] board[0] "Kilter" -> "Kilter" (L8 S25 @35°, kilter)';
    expect(crewPeerRowFallbackPoint('kilter', 'ios', log)).toBe('50%,78%');
    expect(crewPeerRowFallbackPoint('default', 'ios', log)).toBe('50%,78%');
    expect(crewPeerRowFallbackPoint('kilter', 'android', log)).toBe('');
    expect(crewPeerRowFallbackPoint('tension', 'ios', log)).toBe('');
    expect(crewPeerRowFallbackPoint('kilter', 'ios', '')).toBe('');
    expect(crewPeerRowFallbackPoint('kilter', 'ios', log.replace('kilter)', 'tension)'))).toBe('');
  });

  it('requires the peer avatar before trying the attributed row or measured point', () => {
    const source = readFileSync(showcaseFlowPath('crew.yaml'), 'utf8');
    const avatarProof = source.indexOf('- assertTrue: ${output.peerAvatarY');
    const labelBranch = source.indexOf("visible: '${SHOWCASE_CREW_PEER_ROW_LABEL}'");
    const fallbackBranch = source.indexOf(
      "true: ${!output.peerRowPressed && SHOWCASE_CREW_PEER_ROW_FALLBACK_POINT !== ''}",
    );
    expect(avatarProof).toBeGreaterThan(-1);
    expect(labelBranch).toBeGreaterThan(avatarProof);
    expect(fallbackBranch).toBeGreaterThan(labelBranch);
    expect(source).not.toContain('|| 252');
    expect(parseAllDocuments(source).every((document) => document.errors.length === 0)).toBe(true);
  });
});

describe('warm capture cleanup notification shade', () => {
  it('collapses the Android primary shade without stopping its live app', () => {
    const executeAdb = vi.fn(() => ({ status: 0, stderr: '' }));
    collapseCaptureNotificationShade('android', 'emulator-primary', executeAdb);
    expect(executeAdb).toHaveBeenCalledOnce();
    expect(executeAdb).toHaveBeenCalledWith(['-s', 'emulator-primary', 'shell', 'cmd', 'statusbar', 'collapse']);
  });

  it('does not call Android tools for an iOS capture', () => {
    const executeAdb = vi.fn(() => ({ status: 0, stderr: '' }));
    collapseCaptureNotificationShade('ios', 'ios-primary', executeAdb);
    expect(executeAdb).not.toHaveBeenCalled();
  });

  it('blocks further cleanup when the shade cannot be dismissed', () => {
    expect(() =>
      collapseCaptureNotificationShade('android', 'emulator-primary', () => ({
        status: 1,
        stderr: ' device offline\n',
      })),
    ).toThrow('Android notification shade did not collapse: device offline');
    expect(() =>
      collapseCaptureNotificationShade('android', 'emulator-primary', () => ({ status: 2, stderr: '' })),
    ).toThrow('adb exit 2');
  });
});

describe('native MoonBoard filter recovery', () => {
  const catalogFor = (locale: string): ShowcaseFilterCatalog =>
    JSON.parse(
      readFileSync(new URL(`../../packages/shared/i18n/locales/${locale}/climbs.json`, import.meta.url), 'utf8'),
    ) as ShowcaseFilterCatalog;

  it.each(SHOWCASE_LOCALES)('identifies complete real %s filter controls without supplying results', (locale) => {
    const catalog = catalogFor(locale);
    const patterns = showcaseFilterPatterns(catalog);
    const { filter, search, gradeRail } = catalog.mobile;
    for (const [key, label] of Object.entries({
      SHOWCASE_FILTER_CLOSE: filter.close,
      SHOWCASE_FILTER_TITLE: filter.title,
      SHOWCASE_FILTER_NAME: filter.section.name,
      SHOWCASE_FILTER_DIFFICULTY: filter.section.difficulty,
      SHOWCASE_FILTER_GRADE_RANGE: filter.gradeRange,
    })) {
      expect(new RegExp(patterns[key]).test(label)).toBe(true);
      expect(new RegExp(patterns[key]).test(`${label} unrelated`)).toBe(false);
    }
    const button = new RegExp(patterns.SHOWCASE_FILTER_BUTTON);
    expect(button.test(filter.title)).toBe(true);
    expect(button.test(search.filterCountAria.replace('{{count}}', '2'))).toBe(true);
    expect(button.test(search.chips.filtersWithCount.replace('{{count}}', '3'))).toBe(true);
    const grade = new RegExp(patterns.SHOWCASE_FILTER_GRADE_CONTROL);
    for (const label of [gradeRail.setFilterAria, gradeRail.selectedFilterAria, gradeRail.rangeFilterAria]) {
      expect(grade.test(label.replace('{{grade}}', 'V8+'))).toBe(true);
      expect(grade.test(label.replace('{{grade}}', '7B+ / V8'))).toBe(true);
      expect(grade.test(label.replace('{{grade}}', ''))).toBe(false);
      expect(grade.test(label.replace('{{grade}}', '\n'))).toBe(false);
    }
    expect(grade.test(filter.gradeRange)).toBe(false);
    expect(grade.test('94236 climbs')).toBe(false);
    expect(grade.test('moonboard')).toBe(false);
  });

  it('escapes literal catalog punctuation and refuses malformed grade templates', () => {
    const catalog = catalogFor('en-US');
    catalog.mobile.filter.title = 'Filters (board) [ready].';
    catalog.mobile.gradeRail.setFilterAria = 'Filter (grade) [{{grade}}].';
    const patterns = showcaseFilterPatterns(catalog);
    expect(new RegExp(patterns.SHOWCASE_FILTER_TITLE).test('Filters (board) [ready].')).toBe(true);
    expect(new RegExp(patterns.SHOWCASE_FILTER_TITLE).test('Filters board readyX')).toBe(false);
    expect(new RegExp(patterns.SHOWCASE_FILTER_GRADE_CONTROL).test('Filter (grade) [V8].')).toBe(true);
    expect(new RegExp(patterns.SHOWCASE_FILTER_GRADE_CONTROL).test('Filter grade V8X')).toBe(false);
    for (const malformed of ['No grade', '{{grade}} {{grade}}']) {
      catalog.mobile.gradeRail.setFilterAria = malformed;
      expect(() => showcaseFilterPatterns(catalog)).toThrow('one {{grade}}');
    }
  });

  type Selector = string | { id: string };
  type NativeStep = {
    evalScript?: string;
    tapOn?: Selector;
    assertVisible?: Selector;
    extendedWaitUntil?: { visible?: Selector; notVisible?: Selector; optional?: boolean };
    runFlow?: { when: { notVisible?: Selector; true?: string }; commands: NativeStep[] };
  };
  // Interpret only the native visibility/actions this flow uses. No app/process,
  // recording-server calls or content generation are performed by this test.
  const simulate = (initiallyComplete: boolean, missingAfterReopen?: string, missingInitially?: string) => {
    const catalog = catalogFor('es');
    const patterns = showcaseFilterPatterns(catalog);
    const full = new Set([
      'id:climb-filter-column',
      catalog.mobile.filter.close,
      catalog.mobile.filter.title,
      catalog.mobile.filter.section.name,
      catalog.mobile.filter.section.difficulty,
      catalog.mobile.filter.gradeRange,
      catalog.mobile.gradeRail.setFilterAria.replace('{{grade}}', 'V8'),
    ]);
    let visible = initiallyComplete ? new Set(full) : new Set([catalog.mobile.filter.close]);
    if (missingInitially) visible.delete(missingInitially);
    let recovery = false;
    let ready = false;
    const actions: string[] = [];
    const exists = (selector: Selector): boolean => {
      if (typeof selector !== 'string') return visible.has(`id:${selector.id}`);
      const key = selector.match(/^\$\{([^}]+)\}$/)?.[1];
      const pattern = new RegExp(key ? patterns[key] : selector);
      return [...visible].some((label) => !label.startsWith('id:') && pattern.test(label));
    };
    const execute = (steps: NativeStep[]) => {
      for (const step of steps) {
        if (step.runFlow) {
          const condition = step.runFlow.when;
          if (condition.notVisible ? !exists(condition.notVisible) : recovery) execute(step.runFlow.commands);
        }
        if (step.evalScript?.includes('moonboardFilterRecovery = false')) recovery = false;
        if (step.evalScript?.includes('moonboardFilterRecovery = true')) recovery = true;
        if (step.tapOn) {
          if (!exists(step.tapOn)) throw new Error('native tap target absent');
          if (step.tapOn === '${SHOWCASE_FILTER_CLOSE}') {
            actions.push('close');
            visible = new Set(['id:climbs-screen', catalog.mobile.filter.title]);
          } else if (step.tapOn === '${SHOWCASE_FILTER_BUTTON}') {
            actions.push('reopen');
            visible = new Set(full);
            if (missingAfterReopen) visible.delete(missingAfterReopen);
          } else throw new Error('unexpected native action');
        }
        const wait = step.extendedWaitUntil;
        if (
          wait &&
          !wait.optional &&
          (wait.visible ? !exists(wait.visible) : wait.notVisible && exists(wait.notVisible))
        )
          throw new Error('native readiness failed');
        if (step.assertVisible && !exists(step.assertVisible)) throw new Error('native assertion failed');
        if (step.evalScript?.includes('/mark/grade-filter-shown')) ready = true;
      }
    };
    const documents = parseAllDocuments(readFileSync(showcaseFlowPath('moonboard-filter.yaml'), 'utf8'));
    expect(documents.every((document) => document.errors.length === 0)).toBe(true);
    try {
      execute(documents[1].toJSON() as NativeStep[]);
    } catch {
      return { ready, actions, failed: true };
    }
    return { ready, actions, failed: false };
  };

  it('preserves an already complete native sheet without closing or reopening', () => {
    expect(simulate(true)).toEqual({ ready: true, actions: [], failed: false });
  });
  it('recovers a collapsed native host exactly once before declaring readiness', () => {
    expect(simulate(false)).toEqual({ ready: true, actions: ['close', 'reopen'], failed: false });
  });
  it('requires each body field and the real grade control, not just generic sheet chrome', () => {
    const catalog = catalogFor('es');
    for (const missing of [
      catalog.mobile.filter.title,
      catalog.mobile.filter.section.name,
      catalog.mobile.filter.section.difficulty,
      catalog.mobile.filter.gradeRange,
      catalog.mobile.gradeRail.setFilterAria.replace('{{grade}}', 'V8'),
    ]) {
      expect(simulate(true, undefined, missing)).toEqual({ ready: true, actions: ['close', 'reopen'], failed: false });
      expect(simulate(false, missing)).toEqual({ ready: false, actions: ['close', 'reopen'], failed: true });
    }
  });
});
