import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import {
  CPP_MANIFEST_PATH,
  CPP_TARGETS,
  readCppPage,
  cppCaptureNames,
  resolveCppRecipes,
  assertCppCaptureReady,
  cppNavigationCommands,
  cppReadinessSelector,
  type CppCaptureCoverage,
  type CppRecordedBoard,
  type CppNavigationCommand,
} from '../lib/screenshot-cpp';
import {
  parseArgs,
  buildScreenshotEnv,
  cppLogbookReadinessSelector,
  cppBoardHeaderReadinessSelector,
  cppWallStatusReadinessSelector,
  cppQueueReadinessSelectors,
  cppClimbRowReadinessSelector,
  cppGradeFilterSelectors,
  cppMirrorSelectors,
  cppClimbListErrorSelectors,
  renderCppMaestroFlow as renderCppMaestroFlowWithoutProof,
  cppLogbookAttemptsCommands,
  renderMaestroFlowForIosDevice,
  deviceSlug,
  IOS_SCREENSHOT_DEVICES,
  screenshotFixtureReference,
  waitForCppRecordedRoster,
} from '../mobile-screenshots';
import { parseFrameArguments } from '../frame-screenshots';
import { buildReadinessServerScript } from '../lib/metro-dev-server';

function logbookProof(coverage: CppCaptureCoverage) {
  return {
    target: 'moonboard' as const,
    ascentId: coverage.scenes.logbook.ascentId!,
    variablesHash: 'a'.repeat(64),
    responseSha256: 'b'.repeat(64),
  };
}
function renderCppMaestroFlow(...args: Parameters<typeof renderCppMaestroFlowWithoutProof>) {
  if (args[0] === 'moonboard' && !args[4] && args[2]) args[5] ??= logbookProof(args[2]);
  return renderCppMaestroFlowWithoutProof(...args);
}

const directories: string[] = [];
const LOGBOOK_ASCENT_ID = '543c1c0c-3a22-4640-b30d-6cab80738bc3';
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scenario(target: (typeof CPP_TARGETS)[number]) {
  const page = readCppPage(target);
  const fixturesDir = mkdtempSync(join(tmpdir(), 'cpp-assets-'));
  directories.push(fixturesDir);
  mkdirSync(join(fixturesDir, 'static'));
  const boardPhotoAssets = Object.fromEntries(
    page.heroBoards
      .filter((board) => board.photo)
      .map((board) => {
        const bytes = readFileSync(board.photo!);
        const file = `static/${board.id}.jpg`;
        writeFileSync(join(fixturesDir, file), bytes);
        return [board.id, { file, sha256: createHash('sha256').update(bytes).digest('hex') }];
      }),
  );
  const boards: CppRecordedBoard[] = [...page.heroBoards, ...page.otherBoards].map((board, index) => ({
    uuid: `board-${index}`,
    name: board.selector,
    boardType: board.boardType,
    layoutId: board.layoutId ?? index,
    sizeId: board.sizeId ?? 1,
    setIds: board.setIds?.join(',') ?? '',
    angle: board.angle ?? 0,
  }));
  const primaryId = boards.find((board) => board.name === page.primaryBoard.selector)!.uuid;
  const coverage: CppCaptureCoverage = {
    target,
    boardIds: Object.fromEntries(
      [...page.heroBoards, ...page.otherBoards].map((board, index) => [board.id, boards[index].uuid]),
    ),
    boardNames: Object.fromEntries(
      [...page.heroBoards, ...page.otherBoards].map((board, index) => [board.id, boards[index].name]),
    ),
    boardReadyText: Object.fromEntries(
      [...page.heroBoards, ...page.otherBoards].map((board) => [board.id, `Climb ${board.id}`]),
    ),
    boardPhotoAssets,
    boardPhotoSha256: Object.fromEntries(
      page.heroBoards
        .filter((board) => board.photo)
        .map((board) => [board.id, createHash('sha256').update(readFileSync(board.photo!)).digest('hex')]),
    ),
    scenes: Object.fromEntries(
      ['search', 'logbook', 'led', 'queue', 'workout', 'status', 'island'].map((scene) => [
        scene,
        {
          boardId: primaryId,
          readyText: `Ready ${scene}`,
          sessionId: scene === 'queue' ? 'crew-session' : undefined,
          ascentId: scene === 'logbook' ? LOGBOOK_ASCENT_ID : undefined,
          climbId: scene === 'status' ? 'D0E5387D5B974D38B4E93FC4DFD61EF6' : undefined,
        },
      ]),
    ),
  };
  return { page, boards, coverage, fixturesDir };
}

function selectedScenario(target: (typeof CPP_TARGETS)[number]) {
  const result = scenario(target);
  result.coverage.heroClimbs = Object.fromEntries(
    [...result.page.heroBoards, ...result.page.otherBoards].map((variant, index) => [
      variant.id,
      {
        boardId: result.boards[index].uuid,
        climbId: `${(index + 1).toString(16).padStart(32, '0')}`,
        readyText: `Selected ${variant.id} (left)+[1].`,
        gradeLabel: 'V3',
      },
    ]),
  );
  result.coverage.scenes.search.gradeFilter = {
    minLabel: 'V3',
    maxLabel: 'V4',
    minGradeId: 14,
    maxGradeId: 18,
    expectedCount: 12345,
  };
  result.coverage.accessoryClimb = {
    boardId: result.coverage.boardIds![result.page.primaryBoard.id],
    climbId: 'AF08DF05598B46BFB404BEDCA07685A2',
    readyText: 'Actual primary accessory (left)+[1].',
    gradeLabel: 'V4',
  };
  return result;
}

function requestedCppScenes(commands: unknown): string[] {
  if (Array.isArray(commands)) return commands.flatMap(requestedCppScenes);
  if (typeof commands !== 'object' || commands === null) return [];
  return Object.entries(commands).flatMap(([key, command]) => {
    if (key === 'evalScript' && typeof command === 'string') {
      const requested = command.match(/\/set\?scene=([a-z0-9-]+)/);
      return requested ? [requested[1]] : [];
    }
    return requestedCppScenes(command);
  });
}

function readinessCommandTransport() {
  let handleRequest:
    | ((
        request: { url: string; socket: { remoteAddress: string } },
        response: { writeHead: (status: number) => void; end: (body?: string) => void },
      ) => void)
    | undefined;
  runInNewContext(buildReadinessServerScript(), {
    URL,
    require: (name: string) => {
      if (name === 'http')
        return {
          createServer: (handler: NonNullable<typeof handleRequest>) => {
            handleRequest = handler;
            return { listen: () => {} };
          },
        };
      if (name === 'fs') return {};
      throw new Error(`Unexpected readiness dependency ${name}`);
    },
  });
  return (url: string, remoteAddress = '127.0.0.1') => {
    let status = 0;
    let body = '';
    if (!handleRequest) throw new Error('Readiness child did not register a request handler');
    handleRequest(
      { url, socket: { remoteAddress } },
      {
        writeHead: (responseStatus) => {
          status = responseStatus;
        },
        end: (responseBody = '') => {
          body = responseBody;
        },
      },
    );
    return { status, body };
  };
}

describe('custom product page captures', () => {
  it('recovers a missing recorded count through at most three real sheet remounts and fresh sequence-bound proof', () => {
    for (const target of CPP_TARGETS) {
      const { coverage } = selectedScenario(target);
      for (const device of IOS_SCREENSHOT_DEVICES) {
        for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
          const documents = parseAllDocuments(renderCppMaestroFlow(target, device, coverage, locale, true));
          expect(documents.flatMap((document) => document.errors)).toEqual([]);
          const steps = documents[1].toJS() as Record<string, unknown>[];
          const index = steps.findIndex(
            (step) =>
              (step.retry as { maxRetries?: number } | undefined)?.maxRetries === 2 &&
              JSON.stringify(step).includes('${output.cppGradeCount.selector}'),
          );
          expect(index).toBeGreaterThan(0);
          expect(JSON.stringify(steps[index - 1])).toContain('/grade-count?sequence=');
          const recovery = steps[index].retry as {
            maxRetries: number;
            commands: [{ runFlow: { when: unknown; commands: Record<string, unknown>[] } }, unknown, unknown];
          };
          expect(recovery.maxRetries).toBe(2);
          expect(recovery.commands[0].runFlow.when).toEqual({ notVisible: '${output.cppGradeCount.selector}' });
          expect(recovery.commands[1]).toEqual({
            assertTrue: `\${output.cppGradeCount.sequence == output.cppSequence && output.cppGradeCount.locale == '${locale}' && output.cppGradeCount.proof.totalCount > 0}`,
          });
          expect(recovery.commands[2]).toEqual({
            extendedWaitUntil: { visible: '${output.cppGradeCount.selector}', timeout: 30000 },
          });
          const nativeSteps = recovery.commands[0].runFlow.commands;
          const selectors = cppGradeFilterSelectors(coverage.scenes.search.gradeFilter!, locale);
          expect(nativeSteps[0]).toEqual({
            tapOn: { id: '^sheet-top-bar-leading$', text: selectors.close, enabled: true },
          });
          expect(nativeSteps[1]).toEqual({
            extendedWaitUntil: { notVisible: { id: 'climb-filter-column' }, timeout: 60000 },
          });
          expect(requestedCppScenes(nativeSteps)).toEqual(['search-results', 'search-grade']);
          for (const command of ['search-results', 'search-grade']) {
            const routeIndex = nativeSteps.findIndex(
              (step) => typeof step.evalScript === 'string' && step.evalScript.includes(`/set?scene=${command}'`),
            );
            expect(JSON.stringify(nativeSteps[routeIndex + 1])).toContain(
              '${output.cppAcknowledged == output.cppSequence}',
            );
          }
          const gradeIndex = nativeSteps.findIndex(
            (step) => typeof step.evalScript === 'string' && step.evalScript.includes("/set?scene=search-grade'"),
          );
          expect(nativeSteps.slice(gradeIndex + 2)).toContainEqual({
            extendedWaitUntil: { visible: { text: selectors.minSelected, selected: true }, timeout: 90000 },
          });
          expect(nativeSteps.slice(gradeIndex + 2)).toContainEqual({
            extendedWaitUntil: { visible: { text: selectors.maxSelected, selected: true }, timeout: 90000 },
          });
          expect(nativeSteps.at(-1)).toEqual(steps[index - 1]);
          expect(JSON.stringify(nativeSteps.at(-1))).toContain(`output.cppGradeCount.locale == '${locale}'`);
          expect(JSON.stringify(nativeSteps.at(-1))).toContain('output.cppGradeCount.sequence == output.cppSequence');
          expect(steps[index + 1]).toEqual({
            extendedWaitUntil: { visible: '${output.cppGradeCount.selector}', timeout: 90000 },
          });
          expect(steps.slice(index + 2)).toContainEqual({ takeScreenshot: '02-search' });
          const replay = renderCppMaestroFlow(target, device, coverage, locale, false);
          expect(replay).not.toContain('maxRetries: 2');
          expect(replay).not.toContain('/grade-count?');
          expect(replay).toContain(`visible: ${JSON.stringify(selectors.count)}\n    timeout: 90000`);
        }
      }
    }
  });
  it('skips count recovery when visible and blocks capture after exhausted remounts or stale proof', () => {
    const { coverage } = selectedScenario('moonboard');
    const steps = parseAllDocuments(
      renderCppMaestroFlow('moonboard', IOS_SCREENSHOT_DEVICES[0], coverage, 'en-US', true),
    )[1].toJS() as Record<string, unknown>[];
    const index = steps.findIndex((step) => (step.retry as { maxRetries?: number } | undefined)?.maxRetries === 2);
    expect(index).toBeGreaterThan(0);
    const run = (visibleAfterRemounts: number, staleProof = false) => {
      let remounts = 0;
      let sequence = 1;
      let countVisible = visibleAfterRemounts === 0;
      let sheetVisible = true;
      let captured = false;
      const context = {
        output: {
          cppSequence: sequence,
          cppAcknowledged: sequence,
          cppGradeCount: { sequence, locale: 'en-US', proof: { totalCount: 14435 }, selector: '^14,435 climbs$' },
        },
        SCREENSHOT_CPP_URL: 'http://localhost/cpp',
        http: {
          get: (endpoint: string) => {
            const url = new URL(endpoint);
            if (url.pathname.endsWith('/set')) {
              sequence += 1;
              if (url.searchParams.get('scene') === 'search-grade') {
                remounts += 1;
                sheetVisible = true;
                countVisible = remounts >= visibleAfterRemounts;
              }
              return { body: JSON.stringify({ sequence }) };
            }
            if (url.pathname.endsWith('/status')) return { body: JSON.stringify({ acknowledged: sequence }) };
            return {
              body: JSON.stringify({
                sequence: staleProof ? sequence - 1 : sequence,
                locale: 'en-US',
                proof: { totalCount: 14435 },
                selector: '^14,435 climbs$',
              }),
            };
          },
        },
      };
      const execute = (commands: Record<string, unknown>[]) => {
        for (const command of commands) {
          if (typeof command.evalScript === 'string') runInNewContext(command.evalScript.slice(2, -1), context);
          if (typeof command.assertTrue === 'string' && !runInNewContext(command.assertTrue.slice(2, -1), context))
            throw new Error('unverified proof');
          if (command.tapOn) sheetVisible = false;
          if (command.runFlow) {
            const flow = command.runFlow as { when: { notVisible: string }; commands: Record<string, unknown>[] };
            expect(flow.when.notVisible).toBe('${output.cppGradeCount.selector}');
            if (!countVisible) execute(flow.commands);
          }
          if (command.retry) {
            const retry = command.retry as { maxRetries: number; commands: Record<string, unknown>[] };
            for (let attempt = 0; ; attempt += 1) {
              try {
                execute(retry.commands);
                break;
              } catch (error) {
                if (attempt === retry.maxRetries) throw error;
              }
            }
          }
          if (command.extendedWaitUntil) {
            const wait = command.extendedWaitUntil as { visible?: unknown; notVisible?: unknown };
            if (wait.visible === '${output.cppGradeCount.selector}' && !countVisible) throw new Error('count absent');
            if (wait.notVisible && sheetVisible) throw new Error('sheet still mounted');
          }
          if (command.takeScreenshot === '02-search') captured = true;
        }
      };
      const captureIndex = steps.findIndex((step) => step.takeScreenshot === '02-search');
      try {
        execute(steps.slice(index, captureIndex + 1));
      } catch {
        captured = false;
      }
      return { remounts, captured, sequence, proofSequence: context.output.cppGradeCount.sequence };
    };
    expect(run(0)).toMatchObject({ remounts: 0, captured: true });
    expect(run(1)).toMatchObject({ remounts: 1, captured: true, sequence: 3, proofSequence: 3 });
    expect(run(2)).toMatchObject({ remounts: 2, captured: true, sequence: 5, proofSequence: 5 });
    expect(run(3)).toMatchObject({ remounts: 3, captured: true, sequence: 7, proofSequence: 7 });
    expect(run(4)).toMatchObject({ remounts: 3, captured: false });
    expect(run(1, true)).toMatchObject({ captured: false });
  });
  it('resets real filters, ACKs genuine grade setup, and verifies selection/count before capturing and resetting again', () => {
    for (const target of CPP_TARGETS) {
      const { coverage } = selectedScenario(target);
      for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
        const labels = cppGradeFilterSelectors(coverage.scenes.search.gradeFilter!, locale);
        const gradeControl = (text: string) => ({ text, selected: true });
        const reset = (enabled: boolean) => ({
          id: '^sheet-top-bar-trailing$',
          text: labels.reset,
          enabled,
        });
        for (const device of IOS_SCREENSHOT_DEVICES) {
          const source = renderCppMaestroFlow(target, device, coverage, locale);
          const steps = parseAllDocuments(source)[1].toJS() as Record<string, unknown>[];
          const searchIndex = steps.findIndex(
            (step) => typeof step.evalScript === 'string' && step.evalScript.includes("/set?scene=search'"),
          );
          const setupIndex = steps.findIndex(
            (step) => typeof step.evalScript === 'string' && step.evalScript.includes('/set?scene=search-grade'),
          );
          const captureIndex = steps.findIndex((step) => step.takeScreenshot === '02-search');
          const selecting = steps.slice(searchIndex, captureIndex);
          expect(selecting).toContainEqual({
            extendedWaitUntil: { visible: { id: 'climb-filter-column' }, timeout: 60000 },
          });
          expect(selecting).toContainEqual({
            extendedWaitUntil: {
              visible: { id: '^sheet-top-bar-leading$', text: labels.close, enabled: true },
              timeout: 90000,
            },
          });
          const resetIndex = selecting.findIndex((step) =>
            JSON.stringify(step.runFlow ?? '').includes('sheet-top-bar-trailing'),
          );
          expect(resetIndex).toBeGreaterThan(0);
          expect(searchIndex + resetIndex).toBeLessThan(setupIndex);
          expect(setupIndex).toBeLessThan(captureIndex);
          expect(selecting[resetIndex]).toEqual({
            runFlow: {
              when: { visible: reset(true) },
              commands: [
                { tapOn: reset(true) },
                { extendedWaitUntil: { visible: reset(false), timeout: 90000 } },
                { waitForAnimationToEnd: { timeout: 30000 } },
              ],
            },
          });
          expect(selecting[resetIndex + 1]).toEqual({ extendedWaitUntil: { visible: reset(false), timeout: 90000 } });
          expect(steps[setupIndex + 1]).toEqual({
            retry: {
              maxRetries: 3,
              commands: [
                {
                  evalScript:
                    "${output.cppAcknowledged = JSON.parse(http.get(SCREENSHOT_CPP_URL + '/status?waitFor=' + output.cppSequence).body).acknowledged}",
                },
                { assertTrue: '${output.cppAcknowledged == output.cppSequence}' },
              ],
            },
          });
          expect(steps[setupIndex + 2]).toEqual({
            extendedWaitUntil: { visible: gradeControl(labels.minSelected), timeout: 90000 },
          });
          expect(steps[setupIndex + 3]).toEqual({
            extendedWaitUntil: { visible: gradeControl(labels.maxSelected!), timeout: 90000 },
          });
          expect(steps[setupIndex + 4]).toEqual({
            extendedWaitUntil: {
              visible: labels.count,
              timeout: 90000,
            },
          });
          // The fixed header can be reset physically; offscreen chips are
          // evidence of the real range, never coordinate tap targets.
          expect(source).not.toContain('cpp-filter-grade-rail');
          expect(selecting.filter((step) => step.tapOn || step.longPressOn)).toEqual([]);
          expect(steps[captureIndex + 1]).toEqual({ extendedWaitUntil: { visible: reset(true), timeout: 90000 } });
          expect(steps[captureIndex + 2]).toEqual({ tapOn: reset(true) });
          expect(steps[captureIndex + 3]).toEqual({ extendedWaitUntil: { visible: reset(false), timeout: 90000 } });
          expect(source).not.toContain('Any grade selected');
          const closing = steps[captureIndex + 5];
          if (device.name.startsWith('iPad'))
            expect(closing).toMatchObject({
              runFlow: { commands: expect.arrayContaining([{ tapOn: { id: 'sheet-top-bar-leading' } }]) },
            });
          else expect(closing).toEqual({ tapOn: { id: 'sheet-top-bar-leading' } });
        }
      }
    }
  });
  it('matches the genuine disabled Reset peer and rejects its enabled flank without invented AX ancestry', () => {
    // Run38242551411 / job114789562154 / retry2's actual failure hierarchy:
    // all these nodes share ancestors with NO resource IDs. The native
    // climb-filter-column is a peer, although JSX nests the toolbar beneath it.
    const actualReset = { 'resource-id': 'sheet-top-bar-trailing', accessibilityText: 'Reset', enabled: 'false' };
    const actualFlank = { 'resource-id': 'sheet-top-bar-trailing-flank', enabled: 'true' };
    const { coverage } = selectedScenario('kilter');
    const steps = parseAllDocuments(
      renderCppMaestroFlow('kilter', IOS_SCREENSHOT_DEVICES[0], coverage),
    )[1].toJS() as Record<string, unknown>[];
    const disabledStep = steps.find((step) => {
      const wait = step.extendedWaitUntil as { visible?: { enabled?: boolean } } | undefined;
      return wait?.visible?.enabled === false;
    })!;
    const selector = (
      disabledStep.extendedWaitUntil as { visible: { id: string; text: string; enabled: boolean; childOf?: unknown } }
    ).visible;
    const matchesReset = (node: { 'resource-id': string; accessibilityText?: string; enabled: string }) =>
      new RegExp(selector.id).test(node['resource-id']) &&
      new RegExp(selector.text).test(node.accessibilityText ?? '') &&
      selector.enabled === (node.enabled === 'true');
    expect(matchesReset(actualReset)).toBe(true);
    expect(matchesReset(actualFlank)).toBe(false);
    expect(matchesReset({ ...actualReset, enabled: 'true' })).toBe(false);
    expect(matchesReset({ ...actualReset, 'resource-id': 'different-control' })).toBe(false);
    expect(matchesReset({ ...actualReset, accessibilityText: 'Apply' })).toBe(false);
    expect(new RegExp(selector.id).test(actualReset['resource-id'])).toBe(true);
    expect(new RegExp(selector.text).test(actualReset.accessibilityText)).toBe(true);
    expect(selector.enabled).toBe(actualReset.enabled === 'true');
    expect(selector).not.toHaveProperty('childOf');
    expect(new RegExp(selector.id).test(actualFlank['resource-id'])).toBe(false);
    expect(new RegExp(selector.text).test('Reset another sheet')).toBe(false);
    expect(new RegExp(selector.text).test('Apply')).toBe(false);
    // Disabled Reset means anyActive=false. The shared native predicate checks
    // either grade bound, all board filters, and the name; Any need not be on screen.
    const captureIndex = steps.findIndex((step) => step.takeScreenshot === '02-search');
    expect(steps[captureIndex + 3]).toEqual({ extendedWaitUntil: { visible: selector, timeout: 90000 } });
    expect(steps[captureIndex + 4]).toEqual({ waitForAnimationToEnd: { timeout: 30000 } });
    expect(steps[captureIndex + 5]).toEqual({ tapOn: { id: 'sheet-top-bar-leading' } });
    expect(JSON.stringify(steps.slice(captureIndex + 1, captureIndex + 5))).not.toContain('Any grade');
  });
  it('uses literal grade labels and actual number/plural formatting and refuses invalid coverage', () => {
    const actualCounts = {
      'en-US': '12,345 climbs',
      es: '12.345 bloques',
      fr: '12\u202f345 blocs',
      de: '12.345 Boulder',
    };
    const grade = { minLabel: 'V3 (left)+[1].', minGradeId: 14, maxGradeId: 15, expectedCount: 12345 };
    for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
      const labels = cppGradeFilterSelectors(grade, locale);
      expect(new RegExp(labels.count).test(actualCounts[locale])).toBe(true);
      expect(new RegExp(labels.count).test(actualCounts[locale].replace('345', '346'))).toBe(false);
      const catalog = JSON.parse(readFileSync(`packages/shared/i18n/locales/${locale}/climbs.json`, 'utf8')) as {
        mobile: { gradeRail: { selectedFilterAria: string } };
      };
      expect(
        new RegExp(labels.minSelected).test(
          catalog.mobile.gradeRail.selectedFilterAria.replace('{{grade}}', grade.minLabel),
        ),
      ).toBe(true);
      expect(
        new RegExp(labels.minSelected).test(
          catalog.mobile.gradeRail.selectedFilterAria.replace('{{grade}}', 'V3 left1'),
        ),
      ).toBe(false);
    }
    for (const invalid of [
      { expectedCount: 0 },
      { expectedCount: 1.5 },
      { minLabel: '' },
      { maxLabel: '' },
      { minGradeId: 16, maxGradeId: 15 },
    ])
      expect(() => cppGradeFilterSelectors({ ...grade, ...invalid }, 'en-US')).toThrow('genuine bounds');
    const { coverage } = scenario('kilter');
    coverage.scenes.search.gradeFilter = grade;
    const source = renderCppMaestroFlow('kilter', IOS_SCREENSHOT_DEVICES[0], coverage);
    expect(source).not.toContain('- longPressOn: {');
  });
  it('binds all optional selected heroes to their own real routes and painted identity while restoring original status', () => {
    for (const target of CPP_TARGETS) {
      const { page, coverage, boards, fixturesDir } = selectedScenario(target);
      expect(() => assertCppCaptureReady(target, page, coverage, boards, fixturesDir)).not.toThrow();
      for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
        const options = {
          ...parseArgs(['--cpp', target, '--fixtures', 'record']),
          cppCoverage: coverage,
          cppRecordedBoards: boards,
        };
        const registry = JSON.parse(
          buildScreenshotEnv(options, { NODE_ENV: 'test' }, locale, '2026-10-12T00:00:00Z', 8090)
            .EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS!,
        ) as Record<string, CppNavigationCommand>;
        for (const device of IOS_SCREENSHOT_DEVICES) {
          const source = renderCppMaestroFlow(target, device, coverage, locale);
          const steps = parseAllDocuments(source)[1].toJS() as Record<string, unknown>[];
          for (const [index, variant] of [...page.heroBoards, ...page.otherBoards].entries()) {
            const hero = coverage.heroClimbs![variant.id];
            const command = `${index < 3 ? 'hero' : 'other'}-${(index % 3) + 1}`;
            const route = new URL(registry[command].route, 'https://capture.invalid');
            expect(route.searchParams.get('screenshotClimbId')).toBe(hero.climbId);
            expect(registry[command].identity.uuid).toBe(hero.boardId);
            expect(steps).toContainEqual({
              extendedWaitUntil: {
                visible: { id: `cpp-climb-painted-${hero.boardId}-${hero.climbId}` },
                timeout: 90000,
              },
            });
            expect(steps).toContainEqual({
              extendedWaitUntil: { visible: cppReadinessSelector(hero.readyText), timeout: 90000 },
            });
            expect(steps).toContainEqual({ extendedWaitUntil: { visible: '^V3$', timeout: 90000 } });
            expect(source).not.toContain(`visible: "${coverage.boardReadyText[variant.id]}"`);
          }
          if (device.name.startsWith('iPad') && target !== 'spray') {
            expect(
              new URL(registry['status-ipad'].route, 'https://capture.invalid').searchParams.get('screenshotClimbId'),
            ).toBe(coverage.scenes.status.climbId);
            expect(steps).toContainEqual({
              extendedWaitUntil: {
                visible: {
                  id: `cpp-climb-painted-${coverage.scenes.status.boardId}-${coverage.scenes.status.climbId}`,
                },
                timeout: 90000,
              },
            });
          }
          const mirror = cppMirrorSelectors(locale);
          if (target === 'tension') {
            const captureIndex = steps.findIndex((step) => step.takeScreenshot === 'hero-2');
            const hero = coverage.heroClimbs![page.primaryBoard.id];
            const mirrorIndex = steps.findIndex((step) => step.tapOn === mirror.mirror);
            expect(mirrorIndex).toBeGreaterThan(0);
            expect(steps[mirrorIndex - 2]).toEqual({
              extendedWaitUntil: {
                visible: { id: `cpp-climb-local-mirror-${hero.boardId}-${hero.climbId}` },
                timeout: 60000,
              },
            });
            expect(steps[mirrorIndex + 2]).toEqual({
              extendedWaitUntil: {
                visible: { id: `cpp-climb-painted-${hero.boardId}-${hero.climbId}-mirrored` },
                timeout: 60000,
              },
            });
            expect(steps.slice(0, captureIndex)).toContainEqual({
              extendedWaitUntil: { visible: { text: mirror.unmirror, selected: true }, timeout: 60000 },
            });
            expect(steps[captureIndex + 1]).toEqual({ tapOn: mirror.unmirror });
            expect(steps[captureIndex + 2]).toEqual({
              extendedWaitUntil: { visible: { text: mirror.mirror, selected: false }, timeout: 60000 },
            });
            expect(steps[captureIndex + 3]).toEqual({
              extendedWaitUntil: {
                visible: { id: `cpp-climb-painted-${hero.boardId}-${hero.climbId}` },
                timeout: 60000,
              },
            });
            expect(
              steps.findIndex(
                (step) => typeof step.evalScript === 'string' && step.evalScript.includes('/set?scene=queue-join'),
              ),
            ).toBeGreaterThan(captureIndex + 2);
          } else expect(steps).not.toContainEqual({ tapOn: mirror.mirror });
        }
      }
      const primary = coverage.heroClimbs![page.primaryBoard.id];
      for (const invalid of [
        { boardId: 'another-board' },
        { climbId: '' },
        { benchmarkDifficulty: 15, statsAngle: 99 },
      ])
        expect(() =>
          assertCppCaptureReady(
            target,
            page,
            { ...coverage, heroClimbs: { ...coverage.heroClimbs, [page.primaryBoard.id]: { ...primary, ...invalid } } },
            boards,
            fixturesDir,
          ),
        ).toThrow('selected hero');
      expect(() =>
        assertCppCaptureReady(
          target,
          page,
          {
            ...coverage,
            scenes: {
              ...coverage.scenes,
              search: {
                ...coverage.scenes.search,
                gradeFilter: { ...coverage.scenes.search.gradeFilter!, expectedCount: 0 },
              },
            },
          },
          boards,
          fixturesDir,
        ),
      ).toThrow('grade-filter');
    }
    const { coverage, page, boards } = scenario('tension');
    const oldSource = renderCppMaestroFlow('tension', IOS_SCREENSHOT_DEVICES[0], coverage);
    expect(oldSource).not.toContain('cpp-climb-painted');
    expect(oldSource).not.toContain('longPressOn: {');
    expect(oldSource).not.toContain('Mirror climb');
    for (const command of Object.values(cppNavigationCommands(page, coverage, boards, true)))
      expect(new URL(command.route, 'https://capture.invalid').searchParams.has('screenshotClimbId')).toBe(false);
  });
  it('closes the real open-state UIKit sidebar before every tablet capture without toggling a hidden sidebar', () => {
    const selector = { id: '^ToggleSidebar$', text: '^${SCREENSHOT_SIDEBAR_HIDE_LABEL}$' };
    const actualControls = [
      { id: 'ToggleSidebar', text: 'Hide Sidebar', matches: true },
      { id: 'ToggleSidebar', text: 'Toggle sidebar', matches: false },
      { id: 'UnrelatedControl', text: 'Hide Sidebar', matches: false },
      { id: 'ToggleSidebarExtra', text: 'Hide Sidebar', matches: false },
      { id: 'ToggleSidebar', text: 'Hide Sidebar elsewhere', matches: false },
    ];
    for (const target of CPP_TARGETS) {
      const { coverage } = scenario(target);
      for (const device of IOS_SCREENSHOT_DEVICES) {
        for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
          const source = renderCppMaestroFlow(target, device, coverage, locale);
          const steps = parseAllDocuments(source)[1].toJS() as (Record<string, unknown> | string)[];
          if (!device.name.startsWith('iPad')) {
            expect(source).not.toContain('ToggleSidebar');
            expect(source).not.toContain('SCREENSHOT_SIDEBAR_HIDE_LABEL');
            continue;
          }
          const captures = steps.flatMap((step, index) =>
            typeof step !== 'string' && typeof step.takeScreenshot === 'string' ? [index] : [],
          );
          expect(captures).toHaveLength(13);
          for (const index of captures) {
            const preceding = steps.slice(index - 3, index);
            expect(preceding).toEqual([
              {
                repeat: {
                  times: 3,
                  while: { visible: selector },
                  commands: [{ tapOn: selector }, { waitForAnimationToEnd: { timeout: 30000 } }],
                },
              },
              { extendedWaitUntil: { notVisible: selector, timeout: 15000 } },
              { waitForAnimationToEnd: { timeout: 30000 } },
            ]);
            const lastAck = steps
              .slice(0, index)
              .reduce((last, step, position) => (typeof step !== 'string' && 'retry' in step ? position : last), -1);
            expect(lastAck).toBeLessThan(index - 3);
            // Actual SDK control identity and open/closed labels were observed
            // in the native hierarchy. The conjunction prevents opening it.
            for (const control of actualControls) {
              const matches =
                new RegExp(selector.id).test(control.id) &&
                new RegExp(selector.text.replace('${SCREENSHOT_SIDEBAR_HIDE_LABEL}', 'Hide Sidebar')).test(
                  control.text,
                );
              expect(matches).toBe(control.matches);
            }
          }
        }
      }
    }
  });
  it('retries a missed real sidebar close and stops before reopening the closed sidebar', () => {
    const { coverage } = scenario('kilter');
    const device = IOS_SCREENSHOT_DEVICES.find((candidate) => candidate.name.startsWith('iPad'))!;
    const steps = parseAllDocuments(renderCppMaestroFlow('kilter', device, coverage))[1].toJS() as Record<
      string,
      unknown
    >[];
    const firstCapture = steps.findIndex((step) => 'takeScreenshot' in step);
    const close = steps[firstCapture - 3].repeat as {
      times: number;
      while: { visible: { id: string; text: string } };
      commands: Array<{ tapOn?: { id: string; text: string }; waitForAnimationToEnd?: { timeout: number } }>;
    };
    const matches = (selector: { id: string; text: string }, opened: boolean) =>
      new RegExp(selector.id).test('ToggleSidebar') &&
      new RegExp(selector.text.replace('${SCREENSHOT_SIDEBAR_HIDE_LABEL}', 'Hide Sidebar')).test(
        opened ? 'Hide Sidebar' : 'Toggle sidebar',
      );
    const execute = (initiallyOpen: boolean, missedTaps: number) => {
      let opened = initiallyOpen;
      let taps = 0;
      let settled = 0;
      for (let attempt = 0; attempt < close.times && matches(close.while.visible, opened); attempt += 1) {
        for (const command of close.commands) {
          if (command.tapOn) {
            expect(matches(command.tapOn, opened)).toBe(true);
            taps += 1;
            if (taps > missedTaps) opened = false;
          }
          if (command.waitForAnimationToEnd) settled += 1;
        }
      }
      return { opened, taps, settled };
    };
    expect(execute(true, 1)).toEqual({ opened: false, taps: 2, settled: 2 });
    expect(execute(true, 0)).toEqual({ opened: false, taps: 1, settled: 1 });
    expect(execute(false, 0)).toEqual({ opened: false, taps: 0, settled: 0 });
    expect(execute(true, 3)).toEqual({ opened: true, taps: 3, settled: 3 });
    expect(steps[firstCapture - 2]).toEqual({
      extendedWaitUntil: { notVisible: close.while.visible, timeout: 15000 },
    });
  });
  it('admits only native localized multiframe badge prefixes and queue suffixes in their real order', () => {
    const labels = {
      'en-US': { frames: 'frames', position: 'position 1', attribution: 'Added by Doe, Jane' },
      es: { frames: 'cuadros', position: 'posición 1', attribution: 'Añadido por Doe, Jane' },
      fr: { frames: 'images', position: 'position 1', attribution: 'Ajouté par Doe, Jane' },
      de: { frames: 'Bilder', position: 'Position 1', attribution: 'Hinzugefügt von Doe, Jane' },
    } as const;
    const title = 'Wax (left)+[1].';
    for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
      const { frames, position, attribution } = labels[locale];
      const row = new RegExp(cppClimbRowReadinessSelector(title, locale));
      const queue = new RegExp(cppQueueReadinessSelectors(title, locale).row);
      expect(row.test(`${title}, rosette, V3`)).toBe(true);
      expect(queue.test(`${title}, ${position}`)).toBe(true);
      expect(queue.test(`${title}, ${position}, ${attribution}`)).toBe(true);
      for (const count of [2, 9, 10, 12, 100]) {
        const badge = `${count} ${frames}`;
        expect(row.test(`${badge}, ${title}, rosette, V3`)).toBe(true);
        expect(row.test(`${badge}, Another climb, rosette, V3`)).toBe(false);
        expect(row.test(`${badge}, ${title} Extended, rosette, V3`)).toBe(false);
        expect(row.test(`${badge}, Wax left1, rosette, V3`)).toBe(false);
        expect(queue.test(`${title}, ${position}, ${badge}`)).toBe(true);
        expect(queue.test(`${title}, ${position}, ${attribution}, ${badge}`)).toBe(true);
        expect(queue.test(`${title}, Extended, ${position}, ${badge}`)).toBe(false);
        expect(queue.test(`${title} Extended, ${position}, ${badge}`)).toBe(false);
        expect(queue.test(`${badge}, ${title}, ${position}`)).toBe(false);
        expect(queue.test(`${title}, ${position}, ${badge}, ${attribution}`)).toBe(false);
        expect(queue.test(`${title}, ${position}, ${badge}, extra metadata`)).toBe(false);
      }
      for (const invalidBadge of [
        `0 ${frames}`,
        `1 ${frames}`,
        `02 ${frames}`,
        `2.5 ${frames}`,
        `-2 ${frames}`,
        '2 arbitrary tokens',
        `2 ${frames} extra`,
      ]) {
        expect(row.test(`${invalidBadge}, ${title}, V3`)).toBe(false);
        // With no attribution, a suffix can only be the native frame badge.
        expect(queue.test(`${title}, ${position}, ${invalidBadge}`)).toBe(false);
      }
      expect(row.test(`Unrelated prefix, ${title}, V3`)).toBe(false);
      expect(queue.test(`${title}, ${position}, unrelated suffix`)).toBe(false);
      const { coverage } = scenario('kilter');
      coverage.boardReadyText[readCppPage('kilter').heroBoards[0].id] = title;
      coverage.scenes.queue.readyText = title;
      for (const device of IOS_SCREENSHOT_DEVICES) {
        const steps = parseAllDocuments(renderCppMaestroFlow('kilter', device, coverage, locale))[1].toJS() as Record<
          string,
          unknown
        >[];
        expect(steps).toContainEqual({
          extendedWaitUntil: { visible: cppQueueReadinessSelectors(title, locale).row, timeout: 90000 },
        });
        if (device.name.startsWith('iPad'))
          expect(steps).toContainEqual({
            extendedWaitUntil: {
              visible: { id: 'climb-row', text: cppClimbRowReadinessSelector(title, locale) },
              timeout: 90000,
            },
          });
      }
    }
  });
  it('gates wall status on the actual localized capsule, never ordinary rows or extended titles', () => {
    const title = 'Floats (left)+[1].';
    for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
      const catalog = JSON.parse(readFileSync(`packages/shared/i18n/locales/${locale}/session.json`, 'utf8')) as {
        mobile: { boardPresence: { stripA11yLabel: string; stripA11yLabelWithSender: string } };
      };
      const selector = new RegExp(cppWallStatusReadinessSelector(title, locale));
      for (const template of [
        catalog.mobile.boardPresence.stripA11yLabel,
        catalog.mobile.boardPresence.stripA11yLabelWithSender,
      ]) {
        for (const grade of ['V3', '']) {
          const label = template
            .replace('{{name}}', title)
            .replace('{{grade}}', grade)
            .replace('{{sender}}', 'Test User');
          expect(selector.test(label)).toBe(true);
          expect(selector.test(label.replace(title, `${title}, Extended`))).toBe(false);
          expect(selector.test(label.replace(title, `${title} Extended`))).toBe(false);
          expect(selector.test(label.replace(title, 'Another climb'))).toBe(false);
          expect(selector.test(`Note: ${label}`)).toBe(false);
        }
      }
      expect(selector.test(`${title}, rosette, 101k sends, V3`)).toBe(false);
      expect(selector.test(`${title}, position 1`)).toBe(false);
      expect(selector.test('On the wall: Floats left1, V3')).toBe(false);
    }
    const actual = 'On the wall: Floats Your Boat, V3, lit by Test User';
    expect(new RegExp(cppWallStatusReadinessSelector('Floats Your Boat', 'en-US')).test(actual)).toBe(true);
  });
  it('uses genuine board names and fresh list/paint identity for tablet trios and real wall hero for status', () => {
    const { page, boards, coverage } = scenario('kilter');
    const variants = [...page.heroBoards, ...page.otherBoards];
    // Both actual Homewall queries have the same title, but different owned
    // UUIDs and geometry. Neither a manifest alias nor the old pane is proof.
    coverage.boardReadyText[variants[1].id] = 'Moon Landing';
    coverage.boardReadyText[variants[2].id] = 'Moon Landing';
    coverage.boardNames![variants[1].id] = 'Actual Homewall (7×10)';
    coverage.boardNames![variants[2].id] = 'Actual Homewall (10×10)';
    for (const device of IOS_SCREENSHOT_DEVICES) {
      const ipad = device.name.startsWith('iPad');
      const steps = parseAllDocuments(renderCppMaestroFlow('kilter', device, coverage))[1].toJS() as Record<
        string,
        unknown
      >[];
      const captures = steps.flatMap((step) => (typeof step.takeScreenshot === 'string' ? [step.takeScreenshot] : []));
      expect(captures.slice(6)).toEqual([
        '02-search',
        '06-workout',
        '07-status',
        '05-queue',
        '03-logbook',
        '04-led',
        ipad ? '08-kiosk' : '08-island',
      ]);
      const statusStart = steps.findIndex(
        (step) =>
          typeof step.evalScript === 'string' &&
          step.evalScript.includes(`/set?scene=${ipad ? 'status-ipad' : 'status'}'`),
      );
      const statusEnd = steps.findIndex((step) => step.takeScreenshot === '07-status');
      const statusSteps = steps.slice(statusStart, statusEnd);
      expect(statusSteps).toContainEqual({ extendedWaitUntil: { visible: { id: 'climbs-screen' }, timeout: 90000 } });
      if (ipad) {
        for (const [index, variant] of variants.entries()) {
          const end = steps.findIndex(
            (step) => step.takeScreenshot === `${index < 3 ? 'hero' : 'other'}-${(index % 3) + 1}`,
          );
          const start =
            index === 0
              ? 0
              : steps.findIndex(
                  (step) => step.takeScreenshot === `${index <= 3 ? 'hero' : 'other'}-${((index - 1) % 3) + 1}`,
                ) + 1;
          const gates = steps.slice(start, end);
          expect(gates).toContainEqual({
            extendedWaitUntil: { visible: { id: `cpp-climb-list-${boards[index].uuid}` }, timeout: 90000 },
          });
          expect(gates).toContainEqual({
            extendedWaitUntil: { visible: cppBoardHeaderReadinessSelector(variant, coverage), timeout: 90000 },
          });
          expect(gates).toContainEqual({
            extendedWaitUntil: { visible: { id: 'play-drawer-board-overlay' }, timeout: 60000 },
          });
        }
        expect(statusSteps).toContainEqual({
          extendedWaitUntil: { visible: { id: 'board-sheet-stats' }, timeout: 60000 },
        });
        expect(statusSteps).toContainEqual({
          extendedWaitUntil: {
            visible: { id: `cpp-wall-hero-${coverage.scenes.status.boardId}-${coverage.scenes.status.climbId}` },
            timeout: 90000,
          },
        });
      } else {
        expect(statusSteps).toContainEqual({
          extendedWaitUntil: { notVisible: { id: 'play-drawer-board-overlay' }, timeout: 60000 },
        });
        expect(statusSteps).toContainEqual({
          extendedWaitUntil: { visible: cppWallStatusReadinessSelector('Ready status', 'en-US'), timeout: 90000 },
        });
      }
    }
    expect(
      new RegExp(cppBoardHeaderReadinessSelector(variants[1], coverage)).test('Actual Homewall (7×10) • 40°'),
    ).toBe(true);
    expect(
      new RegExp(cppBoardHeaderReadinessSelector(variants[1], coverage)).test(`${variants[1].selector} • 40°`),
    ).toBe(false);
    expect(
      new RegExp(cppBoardHeaderReadinessSelector(variants[1], coverage)).test('Actual Homewall (10×10) • 40°'),
    ).toBe(false);
  });
  it('dismisses real queue/player controls before Logbook without rejecting the persistent Spanish queue action', () => {
    const { coverage } = scenario('kilter');
    const persistentButton = 'Cola, 5 bloques';
    for (const device of IOS_SCREENSHOT_DEVICES) {
      const steps = parseAllDocuments(renderCppMaestroFlow('kilter', device, coverage, 'es'))[1].toJS() as Record<
        string,
        unknown
      >[];
      const queueCapture = steps.findIndex((step) => step.takeScreenshot === '05-queue');
      const logbookRoute = steps.findIndex(
        (step) => typeof step.evalScript === 'string' && step.evalScript.includes('/set?scene=logbook'),
      );
      const dismissal = steps.slice(queueCapture + 1, logbookRoute);
      expect(dismissal[0]).toMatchObject({
        repeat: {
          times: 2,
          commands: [
            {
              runFlow: {
                when: { visible: '${SCREENSHOT_CLOSE_LABEL}' },
                commands: [{ tapOn: '${SCREENSHOT_CLOSE_LABEL}' }, 'waitForAnimationToEnd'],
              },
            },
          ],
        },
      });
      for (const step of dismissal) {
        const gate = step.extendedWaitUntil as { notVisible?: unknown } | undefined;
        if (typeof gate?.notVisible === 'string')
          expect(new RegExp(gate.notVisible).test(persistentButton)).toBe(false);
      }
      if (!device.name.startsWith('iPad'))
        expect(dismissal).toContainEqual({
          extendedWaitUntil: { notVisible: { id: 'play-drawer-board-overlay' }, timeout: 60000 },
        });
    }
  });
  it('matches genuine composite Logbook accessibility rows without weakening other scene gates', () => {
    const actualLabel =
      "Sent Drawing the Priest, community grade V6, 1 try, Kilter Original · 40°, Test User's Kilter Original 12×12 with kickboard, 5:40\u202fAM";
    const actualSelector = cppLogbookReadinessSelector('Drawing the Priest', 'en-US', LOGBOOK_ASCENT_ID);
    expect(new RegExp(actualSelector.text).test(actualLabel)).toBe(true);
    expect(new RegExp('Drawing the Priest').test(actualLabel)).toBe(true);
    expect(new RegExp('^Drawing the Priest$').test(actualLabel)).toBe(false);
    const statusesByLocale = {
      'en-US': ['Sent', 'Flashed', 'Project'],
      es: ['Encadenada', 'Flasheada', 'Proyecto'],
      fr: ['Enchaîné', 'Flashé', 'Projet'],
      de: ['Getoppt', 'Geflasht', 'Projekt'],
    } as const;
    const title = 'Priest (left)+[1].';
    const { coverage } = scenario('kilter');
    coverage.scenes.logbook.readyText = title;
    for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
      const documents = parseAllDocuments(renderCppMaestroFlow('kilter', IOS_SCREENSHOT_DEVICES[0], coverage, locale));
      const steps = documents[1].toJS() as {
        extendedWaitUntil?: { visible?: { id?: string; text?: string } | string };
      }[];
      const rowGate = steps.find(
        (step) =>
          typeof step.extendedWaitUntil?.visible === 'object' &&
          step.extendedWaitUntil.visible.id === `logbook-entry-${LOGBOOK_ASCENT_ID}`,
      )?.extendedWaitUntil?.visible;
      if (typeof rowGate !== 'object' || !rowGate?.id || !rowGate.text) throw new Error('Missing native row gate');
      expect(steps).toContainEqual({ extendedWaitUntil: { visible: { id: 'logbook-screen' }, timeout: 90000 } });
      const matches = (id: string, label: string) =>
        new RegExp(rowGate.id!).test(id) && new RegExp(rowGate.text!).test(label);
      for (const status of statusesByLocale[locale]) {
        const label = `${status} ${title}, V6, Kilter Original · 40°, 5:40\u202fAM`;
        expect(matches(`logbook-entry-${LOGBOOK_ASCENT_ID}`, label)).toBe(true);
        expect(matches('climb-row-genuine-ascent', label)).toBe(false);
        expect(matches('logbook-entry-', label)).toBe(false);
        expect(matches(`logbook-entry-${LOGBOOK_ASCENT_ID}`, `${status} Another climb, note: ${title}, V6`)).toBe(
          false,
        );
        expect(matches(`logbook-entry-${LOGBOOK_ASCENT_ID}`, `${status} A ${title}, V6`)).toBe(false);
        expect(matches(`logbook-entry-${LOGBOOK_ASCENT_ID}`, `${status} ${title} Extended, V6`)).toBe(false);
        expect(matches(`logbook-entry-${LOGBOOK_ASCENT_ID}`, `${status} ${title} V6`)).toBe(false);
        expect(matches(`logbook-entry-${LOGBOOK_ASCENT_ID}`, `${status} Priest left1, V6`)).toBe(false);
        expect(matches('logbook-entry-11111111-1111-4111-8111-111111111111', `${status} ${title}, Extended, V6`)).toBe(
          false,
        );
      }
      expect(steps).toContainEqual({ extendedWaitUntil: { visible: 'Ready led', timeout: 90000 } });
    }
    for (const ascentId of [undefined, '', 'invented-entry', 'bad.*']) {
      expect(() => cppLogbookReadinessSelector(title, 'en-US', ascentId)).toThrow('genuine ascent UUID');
      expect(() =>
        renderCppMaestroFlow('kilter', IOS_SCREENSHOT_DEVICES[0], {
          ...coverage,
          scenes: { ...coverage.scenes, logbook: { ...coverage.scenes.logbook, ascentId } },
        }),
      ).toThrow('genuine ascent UUID');
    }
  });
  it('matches the genuine queue row prefix and localized header after opening the sheet', () => {
    const labelsByLocale = {
      'en-US': { header: 'Up next', position: 'position 1', addedBy: 'Added by a genuine climber' },
      es: { header: 'Cola', position: 'posición 1', addedBy: 'Añadido por una persona' },
      fr: { header: "File d'attente", position: 'position 1', addedBy: 'Ajouté par une personne' },
      de: { header: 'Als Nächstes', position: 'Position 1', addedBy: 'Hinzugefügt von einer Person' },
    } as const;
    const title = 'Wax (left)+[1].';
    const { coverage } = scenario('kilter');
    coverage.scenes.queue.readyText = title;
    for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
      const labels = labelsByLocale[locale];
      const selectors = cppQueueReadinessSelectors(title, locale);
      const matches = (label: string) => new RegExp(selectors.row).test(label);
      expect(matches(`${title}, ${labels.position}`)).toBe(true);
      expect(matches(`${title}, ${labels.position}, ${labels.addedBy}`)).toBe(true);
      expect(matches(`A ${title}, ${labels.position}`)).toBe(false);
      expect(matches(`${title} Extended, ${labels.position}`)).toBe(false);
      expect(matches(`${title}, Extended, ${labels.position}`)).toBe(false);
      expect(matches(`${title}, ${labels.position}, ${labels.position}`)).toBe(false);
      expect(matches(`${title} ${labels.position}`)).toBe(false);
      expect(matches(`Another climb, ${labels.position}, added by ${title}`)).toBe(false);
      expect(matches(`Wax left1, ${labels.position}`)).toBe(false);
      expect(new RegExp(selectors.header).test(labels.header)).toBe(true);
      expect(new RegExp(selectors.header).test(`${labels.header}, 3 climbs`)).toBe(true);
      expect(new RegExp(selectors.header).test('Other sheet')).toBe(false);
      for (const device of IOS_SCREENSHOT_DEVICES) {
        const steps = parseAllDocuments(renderCppMaestroFlow('kilter', device, coverage, locale))[1].toJS() as Record<
          string,
          unknown
        >[];
        const openQueue = steps.findIndex((step) => step.tapOn === '${SCREENSHOT_QUEUE_LABEL}');
        const rowGate = steps.findIndex((step) => {
          const gate = step.extendedWaitUntil as { visible?: unknown } | undefined;
          return gate?.visible === selectors.row;
        });
        expect(openQueue).toBeGreaterThan(0);
        expect(rowGate).toBeGreaterThan(openQueue);
        expect(steps.slice(openQueue + 1, rowGate)).toContainEqual({
          extendedWaitUntil: { visible: selectors.header, timeout: 60000 },
        });
        expect(steps[rowGate]).toEqual({ extendedWaitUntil: { visible: selectors.row, timeout: 90000 } });
      }
    }
  });
  it('searches offscreen Logbook ascents with at most five swipes inside the existing list', () => {
    for (const target of CPP_TARGETS) {
      const { coverage } = scenario(target);
      for (const device of IOS_SCREENSHOT_DEVICES) {
        for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
          const steps = parseAllDocuments(renderCppMaestroFlow(target, device, coverage, locale))[1].toJS() as Record<
            string,
            unknown
          >[];
          const rowSelector = cppLogbookReadinessSelector(coverage.scenes.logbook.readyText, locale, LOGBOOK_ASCENT_ID);
          const scrollIndex = steps.findIndex((step) => {
            const repeat = step.repeat as { times?: number } | undefined;
            return repeat?.times === 5;
          });
          expect(scrollIndex).toBeGreaterThan(0);
          expect(
            steps[scrollIndex - (target === 'moonboard' ? cppLogbookAttemptsCommands(locale).length + 1 : 1)],
          ).toEqual({
            extendedWaitUntil: { visible: { id: 'logbook-screen' }, timeout: 90000 },
          });
          expect(steps[scrollIndex]).toEqual({
            repeat: {
              times: 5,
              // An already visible row causes zero swipes; an offscreen row
              // triggers only the bounded search for this exact ascent.
              while: { notVisible: rowSelector },
              commands: [
                { swipe: { from: { id: 'logbook-screen' }, direction: 'UP', duration: 700 } },
                { waitForAnimationToEnd: { timeout: 30000 } },
              ],
            },
          });
          expect(rowSelector.id).toBe(`logbook-entry-${LOGBOOK_ASCENT_ID}`);
          expect(steps[scrollIndex + 1]).toEqual({ extendedWaitUntil: { visible: rowSelector, timeout: 90000 } });
          expect(steps.slice(scrollIndex + 2)).toContainEqual({ takeScreenshot: '03-logbook' });
        }
      }
    }
  });
  it('scrolls only selected manufacturer tablet trios within their exact board list before the final row gate', () => {
    for (const target of CPP_TARGETS) {
      const { page, coverage } = selectedScenario(target);
      const variants = [...page.heroBoards, ...page.otherBoards];
      for (const variant of variants) coverage.heroClimbs![variant.id].readyText += " 'literal'";
      for (const device of IOS_SCREENSHOT_DEVICES) {
        for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
          const documents = parseAllDocuments(renderCppMaestroFlow(target, device, coverage, locale));
          expect(documents.flatMap((document) => document.errors)).toEqual([]);
          const steps = documents[1].toJS() as Record<string, unknown>[];
          const shouldScroll = target !== 'spray' && device.name.startsWith('iPad');
          const heroScrolls = steps.filter((step) => {
            const repeat = step.repeat as { commands?: { swipe?: unknown }[] } | undefined;
            return repeat?.commands?.some((command) => command.swipe);
          });
          // Every flow retains its existing Logbook scroll; only the six
          // selected manufacturer tablet trios gain this new bounded search.
          expect(heroScrolls).toHaveLength(shouldScroll ? 7 : 1);
          for (const [index, variant] of variants.entries()) {
            const scene = `${index < 3 ? 'hero' : 'other'}-${(index % 3) + 1}`;
            const start = steps.findIndex(
              (step) => typeof step.evalScript === 'string' && step.evalScript.includes(`/set?scene=${scene}'`),
            );
            const end = steps.findIndex((step) => step.takeScreenshot === scene);
            const gates = steps.slice(start, end);
            const hero = coverage.heroClimbs![variant.id];
            const paintGate = {
              extendedWaitUntil: {
                visible: { id: `cpp-climb-painted-${hero.boardId}-${hero.climbId}` },
                timeout: 90000,
              },
            };
            expect(gates).toContainEqual(paintGate);
            expect(gates).toContainEqual({
              extendedWaitUntil: { visible: `^${hero.gradeLabel}$`, timeout: 90000 },
            });
            if (!shouldScroll) continue;
            const listSelector = { id: `^cpp-climb-list-${hero.boardId}$` };
            const rowSelector = { id: '^climb-row$', text: cppClimbRowReadinessSelector(hero.readyText, locale) };
            const scrollIndex = gates.findIndex((step) => {
              const repeat = step.repeat as { while?: { notVisible?: unknown } } | undefined;
              return repeat?.while?.notVisible !== undefined;
            });
            expect(scrollIndex).toBeGreaterThan(1);
            expect(gates[scrollIndex - 2]).toEqual({
              extendedWaitUntil: { visible: listSelector, timeout: 90000 },
            });
            expect(gates[scrollIndex - 1]).toEqual({
              extendedWaitUntil: { visible: cppBoardHeaderReadinessSelector(variant, coverage), timeout: 90000 },
            });
            expect(gates[scrollIndex]).toEqual({
              repeat: {
                times: 3,
                while: { notVisible: rowSelector },
                commands: [
                  { swipe: { from: listSelector, direction: 'UP', duration: 700 } },
                  { waitForAnimationToEnd: { timeout: 30000 } },
                ],
              },
            });
            expect(gates[scrollIndex + 1]).toEqual({
              extendedWaitUntil: { visible: rowSelector, timeout: 90000 },
            });
            expect(gates[scrollIndex + 2]).toEqual({
              extendedWaitUntil: { visible: { id: 'play-drawer-board-overlay' }, timeout: 60000 },
            });
            expect(gates.findIndex((step) => JSON.stringify(step) === JSON.stringify(paintGate))).toBeLessThan(
              scrollIndex,
            );
            expect(new RegExp(listSelector.id).test(`cpp-climb-list-${hero.boardId}-other`)).toBe(false);
            expect(new RegExp(rowSelector.id).test('board-sheet-climb-row')).toBe(false);
            expect(new RegExp(rowSelector.id).test('climb-row-more-button')).toBe(false);
            const rowText = new RegExp(rowSelector.text);
            expect(rowText.test(`${hero.readyText}, rosette, V3`)).toBe(true);
            expect(rowText.test(`${hero.readyText} Extended, rosette, V3`)).toBe(false);
            expect(rowText.test(`${hero.readyText.replace('(left)+[1].', 'left1X')}, rosette, V3`)).toBe(false);
          }
        }
      }
    }
  });
  it('preserves literal replacement tokens in parsed CPP titles and native row selectors', () => {
    const { page, coverage } = selectedScenario('moonboard');
    const hero = coverage.heroClimbs![page.heroBoards[2].id];
    hero.readyText = "DUNES (left)+[1]. $& $' $` $$ literal";
    for (const device of IOS_SCREENSHOT_DEVICES) {
      for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
        const documents = parseAllDocuments(renderCppMaestroFlow('moonboard', device, coverage, locale));
        expect(documents.flatMap((document) => document.errors)).toEqual([]);
        const steps = documents[1].toJS() as Record<string, unknown>[];
        expect(steps).toContainEqual({
          extendedWaitUntil: { visible: cppReadinessSelector(hero.readyText), timeout: 90000 },
        });
        if (device.name.startsWith('iPad'))
          expect(steps).toContainEqual({
            extendedWaitUntil: {
              visible: { id: '^climb-row$', text: cppClimbRowReadinessSelector(hero.readyText, locale) },
              timeout: 90000,
            },
          });
      }
    }
  });
  it('stops a parsed tablet hero scroll when visible and fails closed on missing lists or rows after three swipes', () => {
    const { page, coverage } = selectedScenario('moonboard');
    const hero = coverage.heroClimbs![page.heroBoards[2].id];
    hero.readyText = "DUNES (left)+[1]. $' literal";
    const device = IOS_SCREENSHOT_DEVICES.find((device) => device.name === 'iPad Pro 13-inch (M5)')!;
    const steps = parseAllDocuments(renderCppMaestroFlow('moonboard', device, coverage))[1].toJS() as Record<
      string,
      unknown
    >[];
    const start = steps.findIndex(
      (step) => typeof step.evalScript === 'string' && step.evalScript.includes("/set?scene=hero-3'"),
    );
    const end = steps.findIndex((step) => step.takeScreenshot === 'hero-3');
    const gates = steps.slice(start, end);
    const scrollIndex = gates.findIndex((step) => {
      const repeat = step.repeat as { while?: { notVisible?: unknown } } | undefined;
      return repeat?.while?.notVisible !== undefined;
    });
    expect(scrollIndex).toBeGreaterThan(1);
    const listGate = gates[scrollIndex - 2].extendedWaitUntil as { visible: { id: string } };
    const scroll = gates[scrollIndex].repeat as {
      times: number;
      while: { notVisible: { id: string; text: string } };
      commands: [{ swipe: { from: { id: string } } }, { waitForAnimationToEnd: { timeout: number } }];
    };
    const rowGate = gates[scrollIndex + 1].extendedWaitUntil as { visible: { id: string; text: string } };
    const run = (visibleAfter: number, listId: string | undefined, rowId = 'climb-row', title = hero.readyText) => {
      let swipes = 0;
      const visible = (selector: { id: string; text?: string }) =>
        swipes >= visibleAfter &&
        new RegExp(selector.id).test(rowId) &&
        (selector.text === undefined || new RegExp(selector.text).test(`${title}, rosette, V5`));
      const listMatches = (selector: { id: string }) => listId !== undefined && new RegExp(selector.id).test(listId);
      if (!listMatches(listGate.visible)) return { swipes, captured: false };
      for (let attempt = 0; attempt < scroll.times && !visible(scroll.while.notVisible); attempt += 1) {
        if (!listMatches(scroll.commands[0].swipe.from)) return { swipes, captured: false };
        swipes += 1;
      }
      return { swipes, captured: visible(rowGate.visible) };
    };
    const listId = `cpp-climb-list-${hero.boardId}`;
    expect(run(0, listId)).toEqual({ swipes: 0, captured: true });
    expect(run(1, listId)).toEqual({ swipes: 1, captured: true });
    expect(run(3, listId)).toEqual({ swipes: 3, captured: true });
    expect(run(4, listId)).toEqual({ swipes: 3, captured: false });
    expect(run(0, undefined)).toEqual({ swipes: 0, captured: false });
    expect(run(0, `${listId}-other-board`)).toEqual({ swipes: 0, captured: false });
    expect(run(0, listId, 'board-sheet-climb-row')).toEqual({ swipes: 3, captured: false });
    expect(run(0, listId, 'climb-row', `${hero.readyText} Extended`)).toEqual({ swipes: 3, captured: false });
    expect(run(0, listId, 'climb-row', 'DUNES left1X literal')).toEqual({ swipes: 3, captured: false });
  });
  it('retries only real manufacturer hero list errors during tablet recording and keeps the final gates', () => {
    for (const target of CPP_TARGETS) {
      const { page, coverage } = selectedScenario(target);
      for (const locale of ['en-US', 'es', 'fr', 'de'] as const)
        for (const device of IOS_SCREENSHOT_DEVICES) {
          const nativeError = JSON.parse(
            readFileSync(join('packages/shared/i18n/locales', locale, 'common.json'), 'utf8'),
          ).mobile.offlineState as { errorTitle: string; retry: string };
          const errorSelectors = cppClimbListErrorSelectors(locale);
          expect(new RegExp(errorSelectors.error.text).test(nativeError.errorTitle)).toBe(true);
          expect(new RegExp(errorSelectors.retry.text).test(nativeError.retry)).toBe(true);
          expect(new RegExp(errorSelectors.retry.text).test(`${nativeError.retry} elsewhere`)).toBe(false);
          expect(errorSelectors.error.childOf).toEqual({ id: '^climb-list$' });
          expect(new RegExp(errorSelectors.retry.childOf.id).test('another-climb-list')).toBe(false);
          const replay = renderCppMaestroFlow(target, device, coverage, locale);
          expect(replay).not.toContain(JSON.stringify(errorSelectors.error));
          const steps = parseAllDocuments(
            renderCppMaestroFlow(target, device, coverage, locale, true),
          )[1].toJS() as Record<string, unknown>[];
          for (const [boardIndex, board] of [...page.heroBoards, ...page.otherBoards].entries()) {
            const scene = `${boardIndex < 3 ? 'hero' : 'other'}-${(boardIndex % 3) + 1}`;
            const start = steps.findIndex(
              (step) => typeof step.evalScript === 'string' && step.evalScript.includes(`/set?scene=${scene}'`),
            );
            const end = steps.findIndex((step) => step.takeScreenshot === scene);
            const gates = steps.slice(start + 2, end);
            const recovery = gates.find((step) => JSON.stringify(step).includes(JSON.stringify(errorSelectors.error)));
            const shouldRecover = device.name.startsWith('iPad') && board.boardType !== 'spray';
            expect(!!recovery).toBe(shouldRecover);
            if (!shouldRecover) continue;
            const hero = coverage.heroClimbs![board.id];
            expect(recovery).toMatchObject({
              retry: {
                maxRetries: 2,
                commands: [
                  {
                    runFlow: {
                      when: { visible: errorSelectors.error },
                      commands: [
                        { assertVisible: { id: '^climbs-screen$' } },
                        { assertVisible: cppBoardHeaderReadinessSelector(board, coverage) },
                        { tapOn: errorSelectors.retry },
                        {
                          extendedWaitUntil: {
                            visible: { id: `^cpp-climb-painted-${hero.boardId}-${hero.climbId}$` },
                            timeout: 30000,
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            });
            expect(gates).toContainEqual({
              extendedWaitUntil: { visible: cppReadinessSelector(hero.readyText), timeout: 90000 },
            });
            expect(gates).toContainEqual({
              extendedWaitUntil: {
                visible: { id: `cpp-climb-painted-${hero.boardId}-${hero.climbId}` },
                timeout: 90000,
              },
            });
            expect(gates).toContainEqual({
              extendedWaitUntil: {
                visible: {
                  id: target === 'spray' ? 'climb-row' : '^climb-row$',
                  text: cppClimbRowReadinessSelector(hero.readyText, locale),
                },
                timeout: 90000,
              },
            });
          }
        }
    }
  });
  it('bounds actual native Retry taps and rejects a stale board or paint after a list error', () => {
    const { page, coverage } = selectedScenario('moonboard');
    const board = page.otherBoards[2];
    const hero = coverage.heroClimbs![board.id];
    const device = IOS_SCREENSHOT_DEVICES.find((candidate) => candidate.name === 'iPad Pro 13-inch (M5)')!;
    const steps = parseAllDocuments(
      renderCppMaestroFlow('moonboard', device, coverage, 'en-US', true),
    )[1].toJS() as Record<string, unknown>[];
    const recovery = steps.find((step) => {
      const serialized = JSON.stringify(step);
      return serialized.includes('childOf') && serialized.includes(`cpp-climb-painted-${hero.boardId}`);
    })!.retry as {
      maxRetries: number;
      commands: [
        {
          runFlow: {
            when: { visible: { text: string; childOf: { id: string } } };
            commands: [
              { assertVisible: { id: string } },
              { assertVisible: string },
              { tapOn: { text: string; childOf: { id: string }; enabled: boolean } },
              { extendedWaitUntil: { visible: { id: string }; timeout: number } },
            ];
          };
        },
      ];
    };
    const run = (
      successfulTap: number,
      currentBoard = coverage.boardNames![board.id],
      parent = 'climb-list',
      paintedBoard = hero.boardId,
    ) => {
      let taps = 0;
      let painted = successfulTap === 0;
      const branch = recovery.commands[0].runFlow;
      for (let attempt = 0; attempt <= recovery.maxRetries; attempt += 1) {
        if (!painted && new RegExp(branch.when.visible.childOf.id).test(parent)) {
          if (!new RegExp(branch.commands[1].assertVisible).test(`${currentBoard} • ${board.angle}°`)) continue;
          taps += 1;
          painted = taps >= successfulTap;
        }
        if (
          painted &&
          new RegExp(branch.commands[3].extendedWaitUntil.visible.id).test(
            `cpp-climb-painted-${paintedBoard}-${hero.climbId}`,
          )
        )
          return { taps, ready: true };
      }
      return { taps, ready: false };
    };
    expect(run(0)).toEqual({ taps: 0, ready: true });
    expect(run(1)).toEqual({ taps: 1, ready: true });
    expect(run(3)).toEqual({ taps: 3, ready: true });
    expect(run(4)).toEqual({ taps: 3, ready: false });
    expect(run(1, 'Previous Tension board')).toEqual({ taps: 0, ready: false });
    expect(run(1, undefined, 'board-sheet-climb-list')).toEqual({ taps: 0, ready: false });
    expect(run(1, undefined, undefined, 'previous-tension-uuid')).toEqual({ taps: 1, ready: false });
  });
  it('resolves all 128 legacy/selected CPP flows through the real Metro registry and strict readiness handler', () => {
    let checkedDocuments = 0;
    const readinessRequest = readinessCommandTransport();
    for (const target of CPP_TARGETS)
      for (const makeScenario of [scenario, selectedScenario]) {
        const { coverage, page, boards } = makeScenario(target);
        coverage.boardIds = Object.fromEntries(
          [...page.heroBoards, ...page.otherBoards].map((board, index) => [board.id, boards[index].uuid]),
        );
        const options = {
          ...parseArgs(['--cpp', target, '--fixtures', 'record']),
          cppCoverage: coverage,
          cppRecordedBoards: boards,
        };
        for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
          const env = buildScreenshotEnv(options, { NODE_ENV: 'test' }, locale, '2026-10-12T00:00:00Z', 8090);
          const registry = JSON.parse(env.EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS!) as Record<string, CppNavigationCommand>;
          for (const device of IOS_SCREENSHOT_DEVICES) {
            const ipad = device.name.startsWith('iPad');
            const finalScene = target !== 'spray' && ipad ? 'kiosk' : 'island';
            const source = renderMaestroFlowForIosDevice(
              renderCppMaestroFlow(target, device, coverage, locale),
              device,
            );
            const documents = parseAllDocuments(source);
            expect(documents.flatMap((document) => document.errors)).toEqual([]);
            const steps = documents[1].toJS() as Record<string, unknown>[];
            const requestedScenes = requestedCppScenes(steps);
            // This list is the approved capture sequence, independently of the
            // implementation's registry and scene builder (including the join).
            expect(requestedScenes).toEqual([
              'hero-1',
              'hero-2',
              'hero-3',
              'other-1',
              'other-2',
              'other-3',
              ...(coverage.accessoryClimb ? ['accessory-prepare'] : []),
              'search',
              ...(coverage.scenes.search.gradeFilter ? ['search-grade'] : []),
              'search-results',
              'workout',
              target !== 'spray' && ipad ? 'status-ipad' : 'status',
              'queue-join',
              'queue',
              'logbook',
              'led',
              finalScene,
            ]);
            for (const [index, scene] of requestedScenes.entries()) {
              const board = index < 6 ? [...page.heroBoards, ...page.otherBoards][index] : page.primaryBoard;
              expect(registry[scene], `${target}/${device.name}/${locale}: ${scene}`).toMatchObject({
                selector: board.selector,
                identity: { uuid: coverage.boardIds[board.id], boardType: board.boardType },
              });
              expect(
                new URL(registry[scene].route, 'https://capture.invalid').searchParams.get('screenshotCppScene'),
              ).toBe(scene);
              const response = readinessRequest(`/cpp/set?scene=${scene}`);
              expect(response.status).toBe(200);
              expect(JSON.parse(response.body)).toMatchObject({ scene });
            }
            if (coverage.scenes.search.gradeFilter) {
              const gradeRoute = new URL(registry['search-grade'].route, 'https://capture.invalid');
              expect(gradeRoute.pathname).toBe('/climbs');
              expect(gradeRoute.searchParams.get('screenshotOpenFilters')).toBe('1');
              expect(gradeRoute.searchParams.get('screenshotMinGrade')).toBe(
                String(coverage.scenes.search.gradeFilter.minGradeId),
              );
              expect(gradeRoute.searchParams.get('screenshotMaxGrade')).toBe(
                String(coverage.scenes.search.gradeFilter.maxGradeId),
              );
            } else expect(registry['search-grade']).toBeUndefined();
            const resultsRoute = new URL(registry['search-results'].route, 'https://capture.invalid');
            expect(resultsRoute.pathname).toBe('/climbs');
            expect(resultsRoute.searchParams.has('screenshotOpenFilters')).toBe(false);
            expect(resultsRoute.searchParams.get('screenshotBoardIndex')).toBe(
              new URL(registry.search.route, 'https://capture.invalid').searchParams.get('screenshotBoardIndex'),
            );
            const statusRoute = new URL(
              registry[target !== 'spray' && ipad ? 'status-ipad' : 'status'].route,
              'https://capture.invalid',
            );
            expect(statusRoute.searchParams.has('screenshotOpenFirst')).toBe(target !== 'spray' && ipad);
            expect(registry[target !== 'spray' && ipad ? 'status-ipad' : 'status'].identity.uuid).toBe(
              coverage.scenes.status.boardId,
            );
            const finalRoute = new URL(registry[finalScene].route, 'https://capture.invalid');
            expect(finalRoute.pathname).toBe(target === 'spray' ? '/boards/spray/holds' : ipad ? '/wall' : '/climbs');
            if (target === 'spray')
              expect(finalRoute.searchParams.get('wallUuid')).toBe(coverage.scenes.island.boardId);
            if (!ipad && target !== 'spray') expect(finalRoute.searchParams.get('screenshotOpenFirst')).toBe('1');
            const captures = steps.flatMap((step) =>
              typeof step.takeScreenshot === 'string' ? [`${step.takeScreenshot}.png`] : [],
            );
            expect(captures.sort()).toEqual(cppCaptureNames(page, deviceSlug(device.name)));
            expect(captures).toContain(target === 'spray' ? '08-holds.png' : ipad ? '08-kiosk.png' : '08-island.png');
            checkedDocuments += 1;
          }
        }
      }
    expect(checkedDocuments).toBe(128);
  });
  it('keeps the readiness command transport restricted to known scenes and loopback clients', () => {
    const request = readinessCommandTransport();
    expect(request('/cpp/set?scene=accessory-prepare').status).toBe(200);
    expect(request('/cpp/set?scene=search-grade').status).toBe(200);
    const accepted = request('/cpp/set?scene=search-results');
    expect(accepted.status).toBe(200);
    const command = JSON.parse(accepted.body) as { sequence: number };
    for (const scene of [
      '',
      'search-results-other-board',
      'search-grade-other-board',
      'accessory-prepare-other-board',
      'unregistered',
      'search%26anything',
    ]) {
      expect(request(`/cpp/set?scene=${scene}`).status).toBe(400);
    }
    expect(request('/cpp/set?scene=search-results', '192.0.2.1').status).toBe(403);
    expect(request('/cpp/unregistered').status).toBe(404);
    expect(JSON.parse(request('/cpp/command').body)).toMatchObject({
      sequence: command.sequence,
      scene: 'search-results',
    });
    expect(JSON.parse(request(`/cpp/ack?sequence=${command.sequence}`).body)).toMatchObject({
      acknowledged: command.sequence,
    });
  });
  it('generates a valid Maestro command document rather than expanding the marker inside a comment', () => {
    for (const target of CPP_TARGETS) {
      const { coverage, page } = scenario(target);
      for (const device of IOS_SCREENSHOT_DEVICES) {
        const source = renderMaestroFlowForIosDevice(renderCppMaestroFlow(target, device, coverage), device);
        const documents = parseAllDocuments(source);
        expect(documents.flatMap((document) => document.errors)).toEqual([]);
        expect(documents).toHaveLength(2);
        expect(documents[0].toJS()).toMatchObject({ appId: 'com.boardsesh.app' });
        const commands: unknown = documents[1].toJS();
        expect(Array.isArray(commands)).toBe(true);
        if (!Array.isArray(commands)) throw new Error('Maestro commands must be a YAML sequence');
        expect(commands[0]).toHaveProperty('setOrientation', device.orientation);
        const captures = commands
          .filter(
            (command): command is { takeScreenshot: string } =>
              typeof command === 'object' && command !== null && typeof command.takeScreenshot === 'string',
          )
          .map((command) => `${command.takeScreenshot}.png`);
        expect(captures.sort()).toEqual(cppCaptureNames(page, deviceSlug(device.name)));
        expect(source).toContain('# The orchestrator expands CPP_COMMANDS');
        expect(source).not.toMatch(/^CPP_COMMANDS$/m);
      }
    }
  });
  it('closes the real filter sheet after capturing search and before navigating to Logbook', () => {
    const expectedDismissal = [
      { tapOn: { id: 'sheet-top-bar-leading' } },
      {
        evalScript:
          "${output.cppSequence = JSON.parse(http.get(SCREENSHOT_CPP_URL + '/set?scene=search-results').body).sequence}",
      },
      {
        retry: {
          maxRetries: 3,
          commands: [
            {
              evalScript:
                "${output.cppAcknowledged = JSON.parse(http.get(SCREENSHOT_CPP_URL + '/status?waitFor=' + output.cppSequence).body).acknowledged}",
            },
            { assertTrue: '${output.cppAcknowledged == output.cppSequence}' },
          ],
        },
      },
      { extendedWaitUntil: { notVisible: { id: 'climb-filter-column' }, timeout: 60000 } },
      { waitForAnimationToEnd: { timeout: 30000 } },
    ];
    for (const target of CPP_TARGETS) {
      const { coverage } = scenario(target);
      for (const device of IOS_SCREENSHOT_DEVICES) {
        for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
          const documents = parseAllDocuments(renderCppMaestroFlow(target, device, coverage, locale));
          expect(documents.flatMap((document) => document.errors)).toEqual([]);
          const steps = documents[1].toJS() as Record<string, unknown>[];
          const searchCapture = steps.findIndex((step) => step.takeScreenshot === '02-search');
          const logbookNavigation = steps.findIndex(
            (step) => typeof step.evalScript === 'string' && step.evalScript.includes('/set?scene=logbook'),
          );
          expect(searchCapture).toBeGreaterThan(0);
          if (device.name.startsWith('iPad')) {
            expect(steps[searchCapture + 1]).toEqual({
              runFlow: {
                when: { visible: { id: 'sheet-top-bar-leading' } },
                commands: expectedDismissal,
              },
            });
            expect(searchCapture + 1).toBeLessThan(logbookNavigation);
          } else {
            expect(steps.slice(searchCapture + 1, searchCapture + 1 + expectedDismissal.length)).toEqual(
              expectedDismissal,
            );
            expect(searchCapture + expectedDismissal.length).toBeLessThan(logbookNavigation);
          }
        }
      }
    }
  });
  it('waits for real roster responses after home rather than failing on an in-flight recording', () => {
    const { page, boards, coverage, fixturesDir } = scenario('kilter');
    const observed: CppRecordedBoard[][] = [[], boards.slice(0, 2), [...boards, ...boards]];
    let polls = 0;
    let pauses = 0;
    expect(
      waitForCppRecordedRoster(
        'kilter',
        page,
        coverage,
        fixturesDir,
        () => observed[polls++],
        () => {
          pauses += 1;
        },
        3,
      ),
    ).toEqual(boards);
    expect(polls).toBe(3);
    expect(pauses).toBe(2);
    expect(() =>
      waitForCppRecordedRoster(
        'kilter',
        page,
        coverage,
        fixturesDir,
        () => [],
        () => {},
        2,
      ),
    ).toThrow('recorded roster=0');
  });

  it('uses verified UUID/config identity when distinct real boards share the same name', () => {
    const { page, boards, coverage, fixturesDir } = scenario('kilter');
    const correct = boards[1];
    const wrong = { ...correct, uuid: 'old-board', sizeId: 19, setIds: '27' };
    const duplicateRoster = [wrong, ...boards];
    expect(() => assertCppCaptureReady('kilter', page, coverage, duplicateRoster, fixturesDir)).not.toThrow();
    const commands = cppNavigationCommands(page, coverage, duplicateRoster, false);
    expect(commands['hero-2'].identity).toMatchObject({
      uuid: correct.uuid,
      layoutId: 8,
      sizeId: 17,
      setIds: [26, 27],
    });
    coverage.boardIds = Object.fromEntries(
      [...page.heroBoards, ...page.otherBoards].map((board, index) => [board.id, boards[index].uuid]),
    );
    expect(() =>
      assertCppCaptureReady(
        'kilter',
        page,
        coverage,
        [...duplicateRoster, { ...correct, uuid: 'same-config-copy' }],
        fixturesDir,
      ),
    ).not.toThrow();
    expect(cppNavigationCommands(page, coverage, [], false)['hero-2'].identity.uuid).toBe(correct.uuid);
    coverage.boardIds[page.heroBoards[1].id] = wrong.uuid;
    expect(() => assertCppCaptureReady('kilter', page, coverage, duplicateRoster, fixturesDir)).toThrow(
      'same-name candidates=',
    );
  });
  it('selects iOS CPP replay and rejects incompatible inputs', () => {
    expect(parseArgs(['--cpp', 'all'])).toMatchObject({
      cpp: 'all',
      flow: 'app-store-cpp',
      fixtures: 'replay',
      appLocales: ['en-US', 'es', 'fr', 'de'],
    });
    expect(() => parseArgs(['--cpp', 'kilter', '--platform', 'android'])).toThrow('iOS');
    expect(() => parseArgs(['--cpp', 'kilter', '--boards', 'wrong'])).toThrow('board selectors');
    expect(() => parseArgs(['--cpp', 'kilter', '--fixtures', 'off'])).toThrow('record or replay');
    expect(() => parseArgs(['--cpp', 'all', '--fixtures', 'record'])).toThrow('one CPP target per scenario');
    expect(
      parseArgs(['--cpp', 'kilter', '--fixtures', 'record', '--cpp-scenario', '/tmp/scenario.json']).cppScenarioFile,
    ).toBe('/tmp/scenario.json');
    expect(() => parseArgs(['--cpp', 'kilter', '--cpp-scenario', '/tmp/scenario.json'])).toThrow('fixtures record');
  });
  it('requires a target-specific fixture pin and distinct complete compositions', () => {
    for (const target of CPP_TARGETS) {
      const { page } = scenario(target);
      if (!page.fixtureReference)
        expect(() => screenshotFixtureReference(parseArgs(['--cpp', target]))).toThrow('verified fixtureReference');
      for (const device of ['iphone-16-pro', 'ipad-pro-11-inch-m5']) {
        const names = cppCaptureNames(page, device);
        const recipes = resolveCppRecipes(page, device, names);
        expect(recipes).toHaveLength(9);
        expect(recipes[0].layout).toBe('store-boards');
        expect(recipes[0].sources).toHaveLength(3);
        expect(recipes[1].layout).toBe('store-boards');
        expect(recipes[1].caption).toBe('cppOtherBoards');
        expect(recipes[1].sources).toEqual(['other-1.png', 'other-2.png', 'other-3.png']);
        const targetTrio = recipes.find(
          (recipe) => recipe.layout === 'store-boards' && recipe.sources.includes('hero-3.png'),
        )!;
        expect(targetTrio.layout).toBe('store-boards');
        expect(targetTrio.sources).toEqual(
          target === 'kilter' ? ['hero-2.png', 'hero-1.png', 'hero-3.png'] : ['hero-1.png', 'hero-2.png', 'hero-3.png'],
        );
        if (target === 'kilter') {
          const centerVariant = page.heroBoards[Number(targetTrio.sources[1].match(/hero-(\d+)/)?.[1]) - 1];
          expect(centerVariant.id).toBe('kilter-original-12x12');
          expect(recipes[3].caption).toBe('cppKilterLogbookImport');
          expect(recipes[5].caption).toBe(device.startsWith('ipad-') ? 'cppKiosk' : 'cppIsland');
          expect(recipes[3].sources).toEqual(['03-logbook.png']);
        }
        expect(recipes.find((recipe) => recipe.sources.includes('other-1.png'))!.sources).toEqual([
          'other-1.png',
          'other-2.png',
          'other-3.png',
        ]);
        expect(names).toHaveLength(13);
        expect(cppCaptureNames({ ...page, recipes: { phone: [], ipad: [] } }, device)).toEqual(names);
        expect(() => resolveCppRecipes(page, device, names.slice(1))).toThrow('Incomplete CPP capture');
        expect(() => resolveCppRecipes(page, device, [...names, names[0]])).toThrow('Incomplete CPP capture');
      }
    }
  });
  it('rejects recipe sources outside the genuine target and device capture contract', () => {
    const manifest = JSON.parse(readFileSync(CPP_MANIFEST_PATH, 'utf8'));
    const directory = mkdtempSync(join(tmpdir(), 'cpp-invalid-recipe-'));
    directories.push(directory);
    const manifestPath = join(directory, 'manifest.json');
    for (const sources of [['invented.png'], ['08-kiosk.png'], ['04-setting.png']]) {
      manifest.targets.kilter.recipes.phone[0].sources = sources;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(() => readCppPage('kilter', manifestPath)).toThrow('Invalid CPP recipe');
    }
  });
  it('rejects a trio label that names a different source variant', () => {
    const manifest = JSON.parse(readFileSync(CPP_MANIFEST_PATH, 'utf8'));
    const trio = manifest.targets.kilter.recipes.phone.find(
      (recipe: { layout: string }) => recipe.layout === 'store-boards',
    );
    const directory = mkdtempSync(join(tmpdir(), 'cpp-mislabelled-trio-'));
    directories.push(directory);
    const manifestPath = join(directory, 'manifest.json');
    [trio.boardLabels[0], trio.boardLabels[1]] = [trio.boardLabels[1], trio.boardLabels[0]];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => readCppPage('kilter', manifestPath)).toThrow('board labels do not match variant source order');
  });
  it('verifies board geometry, target-specific scenes and distinct real source photos', () => {
    for (const target of CPP_TARGETS) {
      const { page, boards, coverage, fixturesDir } = scenario(target);
      expect(() => assertCppCaptureReady(target, page, coverage, boards, fixturesDir)).not.toThrow();
      const reorderedSets = boards.map((board) => ({
        ...board,
        setIds: board.setIds?.split(',').reverse().join(',') ?? null,
      }));
      expect(() => assertCppCaptureReady(target, page, coverage, reorderedSets, fixturesDir)).not.toThrow();
      expect(() =>
        assertCppCaptureReady(
          target,
          page,
          { ...coverage, target: target === 'kilter' ? 'tension' : 'kilter' },
          boards,
          fixturesDir,
        ),
      ).toThrow('coverage');
      const mismatched = boards.map((board, index) =>
        index === 5 ? { ...board, layoutId: board.layoutId + 1 } : board,
      );
      expect(() => assertCppCaptureReady(target, page, coverage, mismatched, fixturesDir)).toThrow('verified board');
      expect(() =>
        assertCppCaptureReady(
          target,
          page,
          { ...coverage, scenes: { ...coverage.scenes, logbook: { boardId: 'other-board', readyText: 'Logbook' } } },
          boards,
          fixturesDir,
        ),
      ).toThrow('logbook');
    }
    const { page, boards, coverage, fixturesDir } = scenario('spray');
    const repeated = coverage.boardPhotoAssets![page.heroBoards[0].id];
    expect(() =>
      assertCppCaptureReady(
        'spray',
        page,
        { ...coverage, boardPhotoAssets: Object.fromEntries(page.heroBoards.map((board) => [board.id, repeated])) },
        boards,
        fixturesDir,
      ),
    ).toThrow('distinct recorded wall photos');
    expect(() =>
      assertCppCaptureReady('spray', page, { ...coverage, boardPhotoSha256: {} }, boards, fixturesDir),
    ).toThrow('source photo');
  });
  it('requires genuine six-board names and wall status climb identity while allowing actual duplicate names', () => {
    const { page, boards, coverage, fixturesDir } = scenario('kilter');
    const variants = [...page.heroBoards, ...page.otherBoards];
    for (const names of [
      undefined,
      {},
      { ...coverage.boardNames, [variants[1].id]: '' },
      { ...coverage.boardNames, [variants[1].id]: 'A manifest alias, not this real board' },
    ]) {
      expect(() =>
        assertCppCaptureReady('kilter', page, { ...coverage, boardNames: names }, boards, fixturesDir),
      ).toThrow();
    }
    const renamedBoards = boards.map((board, index) => ({
      ...board,
      name: index === 1 || index === 2 ? 'My Homewall' : `Actual ${board.name}`,
    }));
    const names = Object.fromEntries(variants.map((variant, index) => [variant.id, renamedBoards[index].name]));
    const namedVariants = variants.map((variant, index) => ({ ...variant, selector: renamedBoards[index].name }));
    const namedPage = {
      ...page,
      heroBoards: namedVariants.slice(0, 3),
      otherBoards: namedVariants.slice(3),
      primaryBoard: namedVariants.find((variant) => variant.id === page.primaryBoard.id)!,
    };
    expect(() =>
      assertCppCaptureReady('kilter', namedPage, { ...coverage, boardNames: names }, renamedBoards, fixturesDir),
    ).not.toThrow();
    for (const climbId of [undefined, '', 'invented-climb', '999000']) {
      expect(() =>
        assertCppCaptureReady(
          'kilter',
          page,
          { ...coverage, scenes: { ...coverage.scenes, status: { ...coverage.scenes.status, climbId } } },
          boards,
          fixturesDir,
        ),
      ).toThrow('climb identifier');
    }
  });
  it('rejects changed photo provenance before generating any CPP', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cpp-manifest-'));
    try {
      const manifest = JSON.parse(readFileSync(CPP_MANIFEST_PATH, 'utf8'));
      manifest.sourcePhotos.bowlo.sha256 = '0'.repeat(64);
      const filename = join(directory, 'manifest.json');
      writeFileSync(filename, JSON.stringify(manifest));
      expect(() => readCppPage('kilter', filename)).toThrow('photo integrity');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('waits for navigation acknowledgements and captures workouts before joining the crew', () => {
    for (const target of CPP_TARGETS) {
      const { page, boards, coverage } = scenario(target);
      const commands = cppNavigationCommands(page, coverage, boards, false);
      expect(commands['hero-1'].route).toContain('screenshotCppScene=hero-1');
      expect(commands.search.route).toContain('screenshotOpenFilters=1');
      expect(commands.logbook.route).toContain(`screenshotBoardType=${target}`);
      expect(commands.island.route).toContain('screenshotCppScene=island');
      for (const device of IOS_SCREENSHOT_DEVICES) {
        const source = renderCppMaestroFlow(target, device, coverage);
        expect(source).toContain('acknowledged');
        expect(source).toContain('/status?waitFor=');
        expect(source).toContain('maxRetries: 3');
        expect(source).not.toContain('maxRetries: 60');
        expect(source.indexOf('takeScreenshot: 06-workout')).toBeLessThan(source.indexOf('scene=queue-join'));
        const queueScene = source.slice(source.indexOf('scene=queue-join'), source.indexOf('takeScreenshot: 05-queue'));
        expect(queueScene.indexOf('tapOn: ${SCREENSHOT_QUEUE_LABEL}')).toBeLessThan(queueScene.indexOf('Ready queue'));
        expect(source).not.toContain('openLink:');
        expect(source.match(/takeScreenshot:/g)).toHaveLength(13);
      }
      if (target === 'spray') {
        expect(commands.status.route).toContain('/discover/smart/PROJECTS');
        expect(renderCppMaestroFlow(target, IOS_SCREENSHOT_DEVICES[0], coverage)).toContain(
          'id: spray-hold-editor-board',
        );
      }
    }
  });
  it('waits for Session before selecting the native Climbs tab after joining with either sidebar state', () => {
    const expectedHandoff = [
      {
        extendedWaitUntil: {
          visible: { text: '${SCREENSHOT_SIDEBAR_RECORD_LABEL}', selected: true },
          timeout: 90000,
        },
      },
      {
        extendedWaitUntil: {
          visible: { text: '${SCREENSHOT_SIDEBAR_CLIMBS_LABEL}', selected: false },
          timeout: 90000,
        },
      },
      { tapOn: { text: '${SCREENSHOT_SIDEBAR_CLIMBS_LABEL}', selected: false } },
      {
        extendedWaitUntil: {
          visible: { text: '${SCREENSHOT_SIDEBAR_CLIMBS_LABEL}', selected: true },
          timeout: 90000,
        },
      },
    ];
    for (const target of CPP_TARGETS) {
      const { coverage } = scenario(target);
      for (const device of IOS_SCREENSHOT_DEVICES) {
        for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
          const documents = parseAllDocuments(renderCppMaestroFlow(target, device, coverage, locale));
          expect(documents.flatMap((document) => document.errors)).toEqual([]);
          const steps = documents[1].toJS() as Record<string, unknown>[];
          const joinTap = steps.findIndex((step) => step.tapOn === '${SCREENSHOT_JOIN_LABEL}');
          const queueCommand = steps.findIndex(
            (step) => typeof step.evalScript === 'string' && step.evalScript.includes("'/set?scene=queue'"),
          );
          expect(joinTap).toBeGreaterThan(-1);
          expect(queueCommand).toBeGreaterThan(joinTap);
          expect(steps.slice(joinTap + 2, queueCommand)).toEqual(device.name.startsWith('iPad') ? expectedHandoff : []);
          expect(steps[queueCommand + 1]).toMatchObject({
            retry: { maxRetries: 3, commands: [{}, { assertTrue: '${output.cppAcknowledged == output.cppSequence}' }] },
          });
        }
      }
    }
  });
  it('requires the closed tablet sidebar before the queue modal can hide its controls', () => {
    const openSidebar = { id: '^ToggleSidebar$', text: '^${SCREENSHOT_SIDEBAR_HIDE_LABEL}$' };
    // UIKit uses a distinct resource ID for the closed toggle in native hierarchies.
    const closedSidebar = { id: '^ToggleSideBar$', text: '^${SCREENSHOT_SIDEBAR_TOGGLE_LABEL}$' };
    for (const target of CPP_TARGETS) {
      const { coverage } = scenario(target);
      for (const device of IOS_SCREENSHOT_DEVICES) {
        const steps = parseAllDocuments(renderCppMaestroFlow(target, device, coverage))[1].toJS() as Record<
          string,
          unknown
        >[];
        const queueTap = steps.findIndex((step) => step.tapOn === '${SCREENSHOT_QUEUE_LABEL}');
        expect(queueTap).toBeGreaterThan(0);
        if (!device.name.startsWith('iPad')) continue;
        expect(steps.slice(queueTap - 4, queueTap)).toEqual([
          {
            repeat: {
              times: 3,
              while: { visible: openSidebar },
              commands: [{ tapOn: openSidebar }, { waitForAnimationToEnd: { timeout: 30000 } }],
            },
          },
          { extendedWaitUntil: { notVisible: openSidebar, timeout: 15000 } },
          { waitForAnimationToEnd: { timeout: 30000 } },
          { extendedWaitUntil: { visible: closedSidebar, timeout: 15000 } },
        ]);
      }
    }
  });
  it('prepares a genuine distinct primary accessory before search and proves its actual solo phone host', () => {
    for (const target of CPP_TARGETS) {
      const { page, boards, coverage, fixturesDir } = selectedScenario(target);
      const accessory = coverage.accessoryClimb!;
      expect(() => assertCppCaptureReady(target, page, coverage, boards, fixturesDir)).not.toThrow();
      const registry = cppNavigationCommands(page, coverage, boards, false);
      const route = new URL(registry['accessory-prepare'].route, 'https://capture.invalid');
      expect(route.searchParams.get('screenshotClimbId')).toBe(accessory.climbId);
      expect(route.searchParams.get('screenshotBoardIndex')).toBe(
        String(page.heroBoards.findIndex((board) => board.id === page.primaryBoard.id)),
      );
      for (const device of IOS_SCREENSHOT_DEVICES) {
        const source = renderCppMaestroFlow(target, device, coverage);
        const preparation = source.slice(source.indexOf('scene=accessory-prepare'), source.indexOf('scene=search'));
        expect(preparation).toContain(`cpp-climb-painted-${accessory.boardId}-${accessory.climbId}`);
        expect(preparation).toContain(JSON.stringify(cppReadinessSelector(accessory.readyText)));
        expect(preparation).not.toContain('takeScreenshot:');
        if (!device.name.startsWith('iPad')) {
          const marker = `cpp-accessory-climb-${accessory.climbId}`;
          expect(preparation.indexOf('notVisible:')).toBeLessThan(preparation.indexOf(marker));
          expect(preparation.indexOf('play-drawer-board-overlay')).toBeLessThan(preparation.indexOf(marker));
          for (const scene of ['workout', 'status']) {
            const beginning = source.indexOf(`scene=${scene}`);
            const ending = source.indexOf('takeScreenshot:', beginning);
            expect(source.slice(beginning, ending)).toContain(marker);
          }
        }
        expect(source.match(/takeScreenshot:/g)).toHaveLength(13);
      }
      for (const invalid of [
        { boardId: 'different-board' },
        { climbId: coverage.scenes.status.climbId! },
        { climbId: 'invalid-id' },
        { readyText: ' ' },
      ])
        expect(() =>
          assertCppCaptureReady(
            target,
            page,
            { ...coverage, accessoryClimb: { ...accessory, ...invalid } },
            boards,
            fixturesDir,
          ),
        ).toThrow('distinct primary accessory');
    }
  });
  it('shows genuine empty spray wall canvases only for explicitly verified zero-climb walls', () => {
    const { page, boards, coverage, fixturesDir } = scenario('spray');
    const cherry = page.heroBoards[1];
    coverage.boardHeroModes = { [cherry.id]: 'wall-editor' };
    coverage.boardClimbCounts = { [cherry.id]: 0 };
    coverage.boardReadyTextByLocale = {
      [cherry.id]: { 'en-US': 'Name your climb', es: 'Pon nombre al bloque', fr: 'Nom du bloc', de: 'Bouldername' },
    };
    expect(() => assertCppCaptureReady('spray', page, coverage, boards, fixturesDir)).not.toThrow();
    expect(cppNavigationCommands(page, coverage, boards, false)['hero-2'].route).toBe(
      '/climbs/create?screenshotCppScene=hero-2',
    );
    for (const device of IOS_SCREENSHOT_DEVICES) {
      const source = renderCppMaestroFlow('spray', device, coverage, 'de');
      const cherryCapture = source.slice(source.indexOf('scene=hero-2'), source.indexOf('takeScreenshot: hero-2'));
      expect(cherryCapture).toContain('Bouldername');
      expect(cherryCapture).toContain('create-climb-editor');
      expect(cherryCapture).not.toContain('play-drawer-board-overlay');
      expect(cherryCapture).not.toContain('swipe:');
      expect(parseAllDocuments(source).flatMap((document) => document.errors)).toEqual([]);
    }
    expect(() =>
      assertCppCaptureReady('spray', page, { ...coverage, boardClimbCounts: { [cherry.id]: 1 } }, boards, fixturesDir),
    ).toThrow('explicit empty spray wall');
    const kilter = scenario('kilter');
    kilter.coverage.boardHeroModes = { [kilter.page.heroBoards[0].id]: 'wall-editor' };
    kilter.coverage.boardClimbCounts = { [kilter.page.heroBoards[0].id]: 0 };
    expect(() => assertCppCaptureReady('kilter', kilter.page, kilter.coverage, kilter.boards)).toThrow(
      'explicit empty spray wall',
    );
  });
  it('uses localized content gates for screens without user-generated labels', () => {
    const { page, boards, coverage, fixturesDir } = scenario('kilter');
    coverage.scenes.search.readyTextByLocale = {
      'en-US': 'Filter climbs',
      es: 'Filtrar bloques',
      fr: 'Filtrer les blocs',
      de: 'Boulder filtern',
    };
    expect(() => assertCppCaptureReady('kilter', page, coverage, boards, fixturesDir)).not.toThrow();
    expect(renderCppMaestroFlow('kilter', IOS_SCREENSHOT_DEVICES[0], coverage, 'es')).toContain('Filtrar bloques');
    expect(renderCppMaestroFlow('kilter', IOS_SCREENSHOT_DEVICES[0], coverage, 'fr')).toContain('Filtrer les blocs');
  });
  it('matches literal climb punctuation instead of executing regex patterns', () => {
    const label = 'Dyno (left) + [sloper].';
    const selector = cppReadinessSelector(label);
    expect(new RegExp(`^${selector}$`).test(label)).toBe(true);
    expect(new RegExp(`^${selector}$`).test('Dyno left sloperX')).toBe(false);
    const { coverage } = scenario('moonboard');
    coverage.boardReadyText[readCppPage('moonboard').heroBoards[0].id] = label;
    expect(renderCppMaestroFlow('moonboard', IOS_SCREENSHOT_DEVICES[0], coverage)).toContain(JSON.stringify(selector));
  });
  it('passes target identity into isolated framing', () => {
    expect(
      parseFrameArguments([
        '--platform',
        'ios',
        '--cpp',
        'moonboard',
        '--input',
        '/tmp/raw',
        '--output',
        '/tmp/framed',
        '--device',
        'iphone-16-pro',
        '--locale',
        'de',
      ]).cpp,
    ).toBe('moonboard');
    expect(() =>
      parseFrameArguments([
        '--platform',
        'android',
        '--cpp',
        'kilter',
        '--input',
        '/tmp/raw',
        '--output',
        '/tmp/framed',
      ]),
    ).toThrow('iOS target');
  });
});

describe('prepared MoonBoard native Attempts scene', () => {
  it('requires a proof bound to the original ascent in replay, while original record scenes stay unfiltered', () => {
    const { coverage } = scenario('moonboard');
    expect(() => renderCppMaestroFlowWithoutProof('moonboard', IOS_SCREENSHOT_DEVICES[0], coverage)).toThrow(
      'prepared genuine Attempts',
    );
    expect(() =>
      renderCppMaestroFlowWithoutProof('moonboard', IOS_SCREENSHOT_DEVICES[0], coverage, 'en-US', false, {
        ...logbookProof(coverage),
        ascentId: 'another-ascent',
      }),
    ).toThrow();
    const record = renderCppMaestroFlowWithoutProof('moonboard', IOS_SCREENSHOT_DEVICES[0], coverage, 'en-US', true);
    expect(record).not.toContain(cppLogbookAttemptsCommands('en-US')[2]);
  });
  it('preserves an already-selected Attempts capsule on simulator retry without reopening its menu', () => {
    const labels = { 'en-US': 'Attempts', es: 'Intentos', fr: 'Essais', de: 'Versuche' };
    for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
      const commands = parseAllDocuments(
        `appId: test\n---\n${cppLogbookAttemptsCommands(locale).join('\n')}`,
      )[1].toJS() as Record<string, unknown>[];
      const first = commands[0].extendedWaitUntil as { visible: string };
      const conditional = commands[2].runFlow as { when: { visible: string }; commands: unknown[] };
      const final = commands.at(-1)!.extendedWaitUntil as { visible: string };
      expect(new RegExp(first.visible).test(labels[locale])).toBe(true);
      expect(new RegExp(conditional.when.visible).test(labels[locale])).toBe(false);
      expect(new RegExp(final.visible).test(labels[locale])).toBe(true);
      expect(commands.filter((command) => command.tapOn)).toEqual([]);
      expect(commands[1]).toHaveProperty('extendedWaitUntil.notVisible');
      expect(commands.at(-2)).toHaveProperty('extendedWaitUntil.notVisible');
    }
  });
  it('uses actual localized native menu labels on every device and keeps the exact ascent gate afterward', () => {
    const { coverage } = scenario('moonboard');
    for (const locale of ['en-US', 'es', 'fr', 'de'] as const)
      for (const device of IOS_SCREENSHOT_DEVICES) {
        const source = renderCppMaestroFlow('moonboard', device, coverage, locale);
        const commands = cppLogbookAttemptsCommands(locale);
        const row = cppLogbookReadinessSelector(
          coverage.scenes.logbook.readyText,
          locale,
          coverage.scenes.logbook.ascentId,
        );
        const logbookStart = source.indexOf('id: logbook-screen');
        const gate = source.indexOf(JSON.stringify(row.id), logbookStart);
        for (const command of commands) {
          expect(source.indexOf(command, logbookStart)).toBeGreaterThan(logbookStart);
          expect(source.indexOf(command, logbookStart)).toBeLessThan(gate);
        }
        const steps = parseAllDocuments(source)[1].toJS() as Record<string, unknown>[];
        expect(steps).toContainEqual({
          extendedWaitUntil: { visible: { id: row.id, text: row.text }, timeout: 90000 },
        });
        expect(source.indexOf('takeScreenshot: 03-logbook', gate)).toBeGreaterThan(gate);
      }
  });
});
