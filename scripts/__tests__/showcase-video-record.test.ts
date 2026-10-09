import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHOWCASE_TAKE_IDS, type ShowcaseAnchorsFile, type ShowcaseMarksFile } from '../lib/showcase-video/contract';
import {
  BLANK_FRAME_MAX_STDEV,
  REFERENCE_MAX_DIFF_RATIO,
  SHOWCASE_DEFAULT_BOARDS,
  SHOWCASE_DEFAULT_ENV_FILE,
  anchorArrivalsFromChunk,
  anchorTapValues,
  buildAnchorsFile,
  buildFootageFrameArgs,
  buildMarksFile,
  checkTake,
  countHomeReady,
  findBoardHandoffProblem,
  findKeychainTeamProblem,
  differingPixelRatio,
  findBoardSlotProblem,
  isBlankFrame,
  isRecordingStartedLine,
  parseEnvFile,
  parseRecordArgs,
  parseSessionIdFromInviteUrl,
  parseSignalRequest,
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
} from '../lib/showcase-video/takes';
import { requiredTakeSeconds } from '../lib/showcase-video/timeline';

const anchorLine = (name: string, x: number): string =>
  ` LOG  [showcase-anchor] {"name":"${name}","x":${x},"y":118,"width":132,"height":32}`;

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
    expect(countHomeReady(' INFO  [analytics] $screen /home\n INFO  [analytics] $screen /homes\nx')).toBe(2);
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
