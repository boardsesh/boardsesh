// A timed stage's pacing names the rest timer's cadence: the shared
// `StagePacingMode` and this app's `RestTimerMode` must be the same two
// literals. The shared package cannot import the app, so the check lives here,
// as a type: adding, dropping or renaming a mode on either side fails
// `vp run typecheck:mobile`, which covers test files.

import { describe, expect, it } from 'vitest';
import type { StagePacingMode } from '@boardsesh/playlist-generator';
import type { RestTimerMode } from '../rest-timer';

type Same<First, Second> = [First] extends [Second] ? ([Second] extends [First] ? true : false) : false;

const stageModesMatchRestTimerModes: Same<StagePacingMode, RestTimerMode> = true;

describe('StagePacingMode', () => {
  it('names the same modes as RestTimerMode', () => {
    expect(stageModesMatchRestTimerModes).toBe(true);
  });
});
