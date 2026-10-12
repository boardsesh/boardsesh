import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  renderCppMaestroFlow,
  renderMaestroFlowForIosDevice,
  deviceSlug,
  IOS_SCREENSHOT_DEVICES,
  screenshotFixtureReference,
  waitForCppRecordedRoster,
} from '../mobile-screenshots';
import { parseFrameArguments } from '../frame-screenshots';

const directories: string[] = [];
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
        { boardId: primaryId, readyText: `Ready ${scene}`, sessionId: scene === 'queue' ? 'crew-session' : undefined },
      ]),
    ),
  };
  return { page, boards, coverage, fixturesDir };
}

describe('custom product page captures', () => {
  it('resolves every emitted command through the actual Metro registry for all 64 CPP recipes', () => {
    let checkedDocuments = 0;
    for (const target of CPP_TARGETS) {
      const { coverage, page, boards } = scenario(target);
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
          const source = renderMaestroFlowForIosDevice(renderCppMaestroFlow(target, device, coverage, locale), device);
          const documents = parseAllDocuments(source);
          expect(documents.flatMap((document) => document.errors)).toEqual([]);
          const steps = documents[1].toJS() as Record<string, unknown>[];
          const requestedScenes = steps.flatMap((step) => {
            if (typeof step.evalScript !== 'string') return [];
            const requested = step.evalScript.match(/\/set\?scene=([a-z0-9-]+)/);
            return requested ? [requested[1]] : [];
          });
          // This list is the approved capture sequence, independently of the
          // implementation's registry and scene builder (including the join).
          expect(requestedScenes).toEqual([
            'hero-1',
            'hero-2',
            'hero-3',
            'other-1',
            'other-2',
            'other-3',
            'search',
            'logbook',
            'led',
            'workout',
            'status',
            'queue-join',
            'queue',
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
          }
          const finalRoute = new URL(registry[finalScene].route, 'https://capture.invalid');
          expect(finalRoute.pathname).toBe(target === 'spray' ? '/boards/spray/holds' : ipad ? '/wall' : '/climbs');
          if (target === 'spray') expect(finalRoute.searchParams.get('wallUuid')).toBe(coverage.scenes.island.boardId);
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
    expect(checkedDocuments).toBe(64);
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
        expect(recipes[0].sources).toEqual(['hero-1.png', 'hero-2.png', 'hero-3.png']);
        expect(recipes[1].sources).toEqual(['other-1.png', 'other-2.png', 'other-3.png']);
        expect(() => resolveCppRecipes(page, device, names.slice(1))).toThrow('Incomplete CPP capture');
        expect(() => resolveCppRecipes(page, device, [...names, names[0]])).toThrow('Incomplete CPP capture');
      }
    }
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
    const source = renderCppMaestroFlow('spray', IOS_SCREENSHOT_DEVICES[0], coverage, 'de');
    const cherryCapture = source.slice(source.indexOf('scene=hero-2'), source.indexOf('takeScreenshot: hero-2'));
    expect(cherryCapture).toContain('Bouldername');
    expect(cherryCapture).toContain('create-climb-editor');
    expect(cherryCapture).not.toContain('play-drawer-board-overlay');
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
