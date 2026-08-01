import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  InterruptedLiveActivityIntentDiagnostic,
  LiveActivityIntentCompletionClass,
  LiveActivityIntentDiagnosticKind,
  LiveActivityIntentDiagnosticStage,
} from '../../../../modules/live-activity/src/index';

// Each Xcode target compiles its own binary, so the shared Swift files
// (ActivityKit attributes, shared App Group keys, keychain helper, intent
// definitions) MUST be byte-identical between the live-activity Expo Module
// (main app target) and the BoardseshWidgets widget extension target. Drift
// means the JSON encoded into shared UserDefaults will mismatch between
// processes — the widget's Next button will silently no-op or render a stale
// climb.
//
// This is enforced here rather than via a symlink because Xcode targets
// don't follow symlinks reliably on all CI environments, and a generator
// step would split the source of truth across a tool and a config file.
// File-as-source + a parity test is the simplest invariant.

const MODULE_IOS = join(__dirname, '../../../../modules/live-activity/ios');
const WIDGET_TARGET = join(__dirname, '../../../../targets/BoardseshWidgets');

const DUPLICATED_FILES = [
  'ClimbNavigationIntent.swift',
  'ClimbSessionAttributes.swift',
  'NextClimbIntent.swift',
  'PreviousClimbIntent.swift',
  'ReconnectBoardIntent.swift',
  'SharedConstants.swift',
  'SharedKeychain.swift',
  'TakeControlIntent.swift',
  'WidgetNetworking.swift',
];

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const RECORDER_SYMBOL_PATTERN = /LiveActivityIntentDiagnostic|diagnosticRun|completionClass/;

const PRODUCTION_WIDGET_COMPILATION_CONDITIONS = new Set(['WIDGET_EXTENSION']);

const TYPESCRIPT_DIAGNOSTIC_KINDS = {
  nextClimb: true,
  previousClimb: true,
  takeControl: true,
  reconnectBoard: true,
} as const satisfies Record<LiveActivityIntentDiagnosticKind, true>;

const TYPESCRIPT_DIAGNOSTIC_STAGES = {
  entered: true,
  networkStarted: true,
  networkFinishedSuccess: true,
  networkFinishedRetryable: true,
  networkFinishedTerminal: true,
  activityKitUpdated: true,
  bleStarted: true,
  bleFinishedSuccess: true,
  bleFinishedFailure: true,
  darwinPosted: true,
  completed: true,
} as const satisfies Record<LiveActivityIntentDiagnosticStage, true>;

const TYPESCRIPT_INTERRUPTED_DIAGNOSTIC_STAGES = {
  entered: true,
  networkStarted: true,
  networkFinishedSuccess: true,
  networkFinishedRetryable: true,
  networkFinishedTerminal: true,
  activityKitUpdated: true,
  bleStarted: true,
  bleFinishedSuccess: true,
  bleFinishedFailure: true,
  darwinPosted: true,
} as const satisfies Record<InterruptedLiveActivityIntentDiagnostic['lastStage'], true>;

const TYPESCRIPT_COMPLETION_CLASSES = {
  success: true,
  sharedDefaultsUnavailable: true,
  navigationOutOfBounds: true,
  serverRejected: true,
  retryableNetworkFailure: true,
  localNavigationEnabled: true,
  alreadyAllowed: true,
  bleFailure: true,
} as const satisfies Record<LiveActivityIntentCompletionClass, true>;

type SwiftConditionalBranch = {
  parentIsVisible: boolean;
  hasMatchedBranch: boolean;
  isVisible: boolean;
};

function evaluateSwiftCompilationCondition(
  condition: string,
  definedConditions: ReadonlySet<string> = PRODUCTION_WIDGET_COMPILATION_CONDITIONS,
): boolean {
  const tokens = condition.match(/[A-Za-z_][A-Za-z0-9_]*|&&|\|\||!|\(|\)/g) ?? [];
  let tokenPosition = 0;

  function consume(expectedToken?: string): string | undefined {
    const token = tokens[tokenPosition];
    if (expectedToken && token !== expectedToken) {
      throw new Error(
        `Expected ${expectedToken} in Swift compilation condition ${condition}, received ${token ?? 'end'}`,
      );
    }
    tokenPosition += 1;
    return token;
  }

  function parsePrimary(): boolean {
    if (tokens[tokenPosition] === '(') {
      consume('(');
      const nestedValue = parseOr();
      consume(')');
      return nestedValue;
    }

    const conditionName = consume();
    if (!conditionName || !/^[A-Za-z_]/.test(conditionName)) {
      throw new Error(`Expected a Swift compilation condition name in ${condition}`);
    }
    return definedConditions.has(conditionName);
  }

  function parseNot(): boolean {
    if (tokens[tokenPosition] === '!') {
      consume('!');
      return !parseNot();
    }
    return parsePrimary();
  }

  function parseAnd(): boolean {
    let result = parseNot();
    while (tokens[tokenPosition] === '&&') {
      consume('&&');
      const rightOperand = parseNot();
      result = result && rightOperand;
    }
    return result;
  }

  function parseOr(): boolean {
    let result = parseAnd();
    while (tokens[tokenPosition] === '||') {
      consume('||');
      const rightOperand = parseAnd();
      result = result || rightOperand;
    }
    return result;
  }

  const result = parseOr();
  if (tokenPosition !== tokens.length) {
    throw new Error(`Unexpected Swift compilation condition token ${tokens[tokenPosition]} in ${condition}`);
  }
  return result;
}

function widgetVisibleRecorderLines(source: string): string[] {
  // Model the production widget's compilation conditions: WIDGET_EXTENSION is
  // defined, BOARDSESH_TESTS is not. Each branch tracks visibility inherited
  // from its parent plus whether an earlier sibling branch already matched.
  // That preserves nested #if/#elseif/#else semantics instead of treating a
  // test-only #elseif as visible in the shipped widget extension.
  const conditionalBranches: SwiftConditionalBranch[] = [];
  const visibleRecorderLines: string[] = [];

  for (const line of source.split('\n')) {
    const directive = line.trim();
    if (directive.startsWith('#if ')) {
      const conditionResult = evaluateSwiftCompilationCondition(directive.slice('#if '.length));
      const parentIsVisible = conditionalBranches.every((branch) => branch.isVisible);
      conditionalBranches.push({
        parentIsVisible,
        hasMatchedBranch: conditionResult,
        isVisible: parentIsVisible && conditionResult,
      });
      continue;
    }
    if (directive.startsWith('#elseif ')) {
      const currentBranch = conditionalBranches.at(-1);
      if (currentBranch) {
        const conditionResult = evaluateSwiftCompilationCondition(directive.slice('#elseif '.length));
        currentBranch.isVisible = currentBranch.parentIsVisible && !currentBranch.hasMatchedBranch && conditionResult;
        currentBranch.hasMatchedBranch ||= conditionResult;
      }
      continue;
    }
    if (directive === '#else') {
      const currentBranch = conditionalBranches.at(-1);
      if (currentBranch) {
        currentBranch.isVisible = currentBranch.parentIsVisible && !currentBranch.hasMatchedBranch;
        currentBranch.hasMatchedBranch = true;
      }
      continue;
    }
    if (directive === '#endif') {
      conditionalBranches.pop();
      continue;
    }
    if (conditionalBranches.every((branch) => branch.isVisible) && RECORDER_SYMBOL_PATTERN.test(line)) {
      visibleRecorderLines.push(line.trim());
    }
  }

  return visibleRecorderLines;
}

describe('Widget target Swift drift', () => {
  for (const file of DUPLICATED_FILES) {
    it(`${file} stays byte-identical between module and widget target`, () => {
      const moduleHash = sha(join(MODULE_IOS, file));
      const widgetHash = sha(join(WIDGET_TARGET, file));
      expect(
        widgetHash,
        `${file}: widget target copy drifted from module copy. ` + 'Update both copies and re-run this test.',
      ).toBe(moduleHash);
    });
  }

  it('keeps the durable recorder out of the production widget extension', () => {
    const recorderName = 'LiveActivityIntentDiagnostics.swift';
    const recorderSource = readFileSync(join(MODULE_IOS, recorderName), 'utf8');

    // BOARDSESH_TESTS compiles the production store into the generated XCTest
    // target only. The real widget target defines WIDGET_EXTENSION but never
    // BOARDSESH_TESTS, so it excludes the entire file and has no copied source.
    expect(recorderSource.trimStart().startsWith('#if !WIDGET_EXTENSION || BOARDSESH_TESTS')).toBe(true);
    expect(existsSync(join(WIDGET_TARGET, recorderName))).toBe(false);
  });

  it('guards every shared-intent recorder call from widget compilation', () => {
    const instrumentedFiles = ['ClimbNavigationIntent.swift', 'TakeControlIntent.swift', 'ReconnectBoardIntent.swift'];

    for (const file of instrumentedFiles) {
      const source = readFileSync(join(WIDGET_TARGET, file), 'utf8');
      expect(widgetVisibleRecorderLines(source), `${file} leaks recorder symbols into WIDGET_EXTENSION`).toEqual([]);
    }
  });

  it('models production widget #if, #elseif, and #else branches through nested guards', () => {
    const syntheticSource = `
#if !WIDGET_EXTENSION
  #if DEBUG
    diagnosticRun.mark(.networkStarted)
  #elseif BOARDSESH_TESTS
    completionClass = .serverRejected
  #else
    diagnosticRun.mark(.networkFinishedSuccess)
  #endif
#elseif BOARDSESH_TESTS
  let diagnosticRun = testRecorder
#else
  #if DEBUG
    completionClass = .localNavigationEnabled
  #elseif !BOARDSESH_TESTS
    let diagnosticRun = productionWidgetRecorder
  #else
    diagnosticRun.mark(.completed)
  #endif
#endif
`;

    expect(widgetVisibleRecorderLines(syntheticSource)).toEqual(['let diagnosticRun = productionWidgetRecorder']);
  });

  it('keeps the TypeScript diagnostic contracts aligned with every Swift CaseIterable enum', () => {
    const recorderSource = readFileSync(join(MODULE_IOS, 'LiveActivityIntentDiagnostics.swift'), 'utf8');
    const swiftCaseIterableMembers = (enumName: string): string[] => {
      const enumPattern = new RegExp(`enum ${enumName}: String, Codable, CaseIterable \\{([\\s\\S]*?)\\n\\}`, 'm');
      const enumMatch = recorderSource.match(enumPattern);
      if (!enumMatch) throw new Error(`Could not find ${enumName} CaseIterable enum`);
      return [...enumMatch[1].matchAll(/^\s*case (\w+)$/gm)].map((match) => match[1]).sort();
    };

    const diagnosticKinds = swiftCaseIterableMembers('LiveActivityIntentDiagnosticKind');
    const diagnosticStages = swiftCaseIterableMembers('LiveActivityIntentDiagnosticStage');
    const interruptedDiagnosticStages = swiftCaseIterableMembers('LiveActivityInterruptedIntentDiagnosticStage');
    const completionClasses = swiftCaseIterableMembers('LiveActivityIntentCompletionClass');

    const intentTypes = DUPLICATED_FILES.flatMap((file) => {
      const source = readFileSync(join(MODULE_IOS, file), 'utf8');
      return [...source.matchAll(/struct (\w+): LiveActivityIntent/g)].map((match) => match[1]);
    }).sort();

    expect(intentTypes).toEqual([
      'NextClimbIntent',
      'PreviousClimbIntent',
      'ReconnectBoardIntent',
      'TakeControlIntent',
    ]);
    expect(diagnosticKinds).toEqual(Object.keys(TYPESCRIPT_DIAGNOSTIC_KINDS).sort());
    expect(diagnosticStages).toEqual(Object.keys(TYPESCRIPT_DIAGNOSTIC_STAGES).sort());
    expect(interruptedDiagnosticStages).toEqual(Object.keys(TYPESCRIPT_INTERRUPTED_DIAGNOSTIC_STAGES).sort());
    expect(interruptedDiagnosticStages).toEqual(diagnosticStages.filter((stage) => stage !== 'completed'));
    expect(completionClasses).toEqual(Object.keys(TYPESCRIPT_COMPLETION_CLASSES).sort());
  });

  it('pins the main-app BLE budget, background-task lifetime, and Darwin ordering', () => {
    const managerSource = readFileSync(join(MODULE_IOS, 'BoardBleManager.swift'), 'utf8');
    const bridgeSource = readFileSync(join(MODULE_IOS, 'LiveActivityBleBridge.swift'), 'utf8');
    const navigationSource = readFileSync(join(MODULE_IOS, 'ClimbNavigationIntent.swift'), 'utf8');

    expect(managerSource).toMatch(/drainTimeout: TimeInterval = 1\.5/);
    expect(managerSource).toContain('return drainedBeforeTimeout && displayOutcome.succeeded == true');
    expect(bridgeSource).toContain('readyTimeout: 3.0');

    const backgroundTaskBegin = bridgeSource.indexOf('task.begin(name: "ble-display-intent")');
    const backgroundTaskDefer = bridgeSource.indexOf('defer { task.end() }', backgroundTaskBegin);
    const managerAwait = bridgeSource.indexOf('return await BoardBleManager.shared', backgroundTaskDefer);
    expect(backgroundTaskBegin).toBeGreaterThanOrEqual(0);
    expect(backgroundTaskDefer).toBeGreaterThan(backgroundTaskBegin);
    expect(managerAwait).toBeGreaterThan(backgroundTaskDefer);

    const bleAwait = navigationSource.indexOf('let writeSucceeded = await bleWriteTask.value');
    const bleDiagnostic = navigationSource.indexOf('diagnosticRun.mark(writeSucceeded ?', bleAwait);
    const darwinPost = navigationSource.indexOf('postQueueNavigateDarwinNotification()', bleDiagnostic);
    expect(bleAwait).toBeGreaterThanOrEqual(0);
    expect(bleDiagnostic).toBeGreaterThan(bleAwait);
    expect(darwinPost).toBeGreaterThan(bleDiagnostic);
  });
});
