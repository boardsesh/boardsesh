import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
});
