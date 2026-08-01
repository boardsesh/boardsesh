import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

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

function widgetVisibleRecorderLines(source: string): string[] {
  // Each entry says whether that conditional branch is provably excluded when
  // WIDGET_EXTENSION is defined. Looking for `some(true)` keeps an outer guard
  // effective through nested #if/#else blocks; #elseif starts a distinct branch
  // instead of corrupting the parent stack.
  const widgetExcludedBranches: boolean[] = [];
  const visibleRecorderLines: string[] = [];

  for (const line of source.split('\n')) {
    const directive = line.trim();
    if (directive.startsWith('#if ')) {
      widgetExcludedBranches.push(directive === '#if !WIDGET_EXTENSION');
      continue;
    }
    if (directive.startsWith('#elseif ')) {
      if (widgetExcludedBranches.length > 0) {
        widgetExcludedBranches[widgetExcludedBranches.length - 1] = directive === '#elseif !WIDGET_EXTENSION';
      }
      continue;
    }
    if (directive === '#else') {
      if (widgetExcludedBranches.length > 0) {
        widgetExcludedBranches[widgetExcludedBranches.length - 1] = false;
      }
      continue;
    }
    if (directive === '#endif') {
      widgetExcludedBranches.pop();
      continue;
    }
    if (!widgetExcludedBranches.includes(true) && RECORDER_SYMBOL_PATTERN.test(line)) {
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

  it('keeps an outer widget guard through nested branches and handles #elseif separately', () => {
    const syntheticSource = `
#if !WIDGET_EXTENSION
  #if DEBUG
    diagnosticRun.mark(.networkStarted)
  #else
    completionClass = .serverRejected
  #endif
#elseif BOARDSESH_TESTS
  let diagnosticRun = testRecorder
#endif
`;

    expect(widgetVisibleRecorderLines(syntheticSource)).toEqual(['let diagnosticRun = testRecorder']);
  });

  it('keeps a fixed diagnostic kind for every shared LiveActivityIntent', () => {
    const recorderSource = readFileSync(join(MODULE_IOS, 'LiveActivityIntentDiagnostics.swift'), 'utf8');
    const diagnosticKinds = [
      ...recorderSource.matchAll(/^\s*case (nextClimb|previousClimb|takeControl|reconnectBoard)$/gm),
    ]
      .map((match) => match[1])
      .sort();

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
    expect(diagnosticKinds).toEqual(['nextClimb', 'previousClimb', 'reconnectBoard', 'takeControl']);
  });
});
