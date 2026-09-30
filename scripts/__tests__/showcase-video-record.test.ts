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
  type TakeCheckInput,
} from '../lib/showcase-video/record';
import {
  SHOWCASE_BOARD_CONFIG_LINKS,
  SHOWCASE_BOARD_SLOTS,
  SHOWCASE_TAKES,
  assertShowcaseTakesComplete,
  expectedAnchorsFor,
  isShowcaseFlow,
  showcaseFlowPath,
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
    });
  });

  it('rejects an unknown take, backend or flag', () => {
    expect(() => parseRecordArgs(['--only', 'hook'])).toThrow(/unknown take "hook"/);
    expect(() => parseRecordArgs(['--backend', 'staging'])).toThrow(/prod or local/);
    expect(() => parseRecordArgs(['--fast'])).toThrow(/Unknown argument: --fast/);
    expect(() => parseRecordArgs(['--only'])).toThrow(/requires a value/);
    expect(() => parseRecordArgs(['--end-session', 'abc'])).toThrow(/UUID/);
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

describe('buildAnchorsFile', () => {
  const screen = { width: 440, height: 956 };

  it('stamps against the trimmed start, pins earlier samples to 0, drops repeats and the overrun', () => {
    const arrivals = [
      ...anchorArrivalsFromChunk(`${anchorLine('wall-pill', 10)}\n${anchorLine('wall-pill', 11)}`, 0),
      ...anchorArrivalsFromChunk(anchorLine('wall-pill', 11), 9000),
      ...anchorArrivalsFromChunk(`noise\n${anchorLine('wall-pill', 30)}`, 10_500),
      ...anchorArrivalsFromChunk(anchorLine('board-surface', 4), 12_000),
      ...anchorArrivalsFromChunk(anchorLine('wall-pill', 99), 60_000),
    ];
    const file = buildAnchorsFile({
      takeId: 'light',
      arrivals,
      recordStartMs: 1000,
      trimSeconds: 6,
      durationSeconds: 10,
      screen,
    });
    expect(file).toEqual<ShowcaseAnchorsFile>({
      takeId: 'light',
      screen,
      anchors: {
        'wall-pill': [
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
  it('passes the right kind of wall', () => {
    const log = ' LOG  [screenshot] board[2] "MoonBoard" -> "Home Moon" (MoonBoard 2016 L2 S1 @40°)';
    expect(findBoardSlotProblem(log, 2, 'moonboard')).toBeNull();
  });

  it('names a wrong wall, a miss with its roster, and a slot never resolved', () => {
    expect(findBoardSlotProblem(' LOG  [screenshot] board[1] "X" -> "Gym" (kilter L8 S21 @40°)', 1, 'tension')).toMatch(
      /non-tension wall/,
    );
    const miss = [
      ' LOG  [screenshot] WARN board[2] selector "MoonBoard" matched nothing; using position',
      ' LOG  [screenshot] board roster: "HQ" (kilter L1 S7 @40°)',
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
    expect(problems.join('\n')).toMatch(/reference\/crew\.jpg/);
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
    expect(() => assertShowcaseTakesComplete(SHOWCASE_TAKES.slice(1))).toThrow(/missing: light/);
  });

  it('takes its durations and callouts from the timeline', () => {
    for (const take of SHOWCASE_TAKES) expect(take.minSeconds).toBe(requiredTakeSeconds(take.id));
    expect(expectedAnchorsFor('light')).toEqual(['wall-pill', 'board-surface']);
    expect(expectedAnchorsFor('crew')).toEqual(['invite-qr', 'queue-row-avatar', 'play-next']);
    // Recorder-authored island buttons are not app anchors.
    expect(expectedAnchorsFor('lock-screen')).toEqual([]);
    expect(expectedAnchorsFor('log')).toEqual(['profile-board-filter', 'activity-calendar']);
    // Three phones in one scene: nothing to call out on any one of them.
    expect(expectedAnchorsFor('boards-tension')).toEqual([]);
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

  it('names a wall for every board slot on prod, and marks the rest unavailable locally', () => {
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
    expect(new Set(kinds).size).toBe(8);
    for (const take of SHOWCASE_TAKES.filter((candidate) => candidate.board?.slot === null)) {
      const kind = take.board?.kind;
      expect(kind && SHOWCASE_BOARD_CONFIG_LINKS[kind], take.id).toBeTruthy();
      expect(take.primeLinks).toContain(kind ? SHOWCASE_BOARD_CONFIG_LINKS[kind] : '');
    }
  });
});
