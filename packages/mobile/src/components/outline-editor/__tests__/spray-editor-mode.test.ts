import { describe, expect, it } from 'vitest';
import {
  modeForTool,
  needsHold,
  planModeSwitch,
  SPRAY_MODES,
  toolForMode,
  type SprayEditorMode,
  type SprayModeSwitchPlan,
} from '../spray-editor-mode';
import type { SprayHoldRole } from '../spray-hold-editor-reducer';

const MODES: readonly SprayEditorMode[] = ['select', 'add', 'trace', 'refine', 'join'];
const ROLES: readonly (SprayHoldRole | null)[] = [null, 'on', 'off', 'maybe'];

describe('SPRAY_MODES', () => {
  it('lists the five modes in the switcher order, each with its own icon', () => {
    expect(SPRAY_MODES.map((spec) => spec.mode)).toEqual(MODES);
    expect(new Set(SPRAY_MODES.map((spec) => spec.iconName)).size).toBe(MODES.length);
  });

  it('runs Select as the resting edit tool and every other mode as its own tool', () => {
    expect(SPRAY_MODES.map((spec) => spec.tool)).toEqual(['edit', 'add', 'trace', 'refine', 'join']);
    for (const spec of SPRAY_MODES) {
      expect(toolForMode(spec.mode)).toBe(spec.tool);
      expect(modeForTool(spec.tool)).toBe(spec.mode);
    }
  });

  it('marks Trace, Refine and Join as working on one hold', () => {
    expect(MODES.filter(needsHold)).toEqual(['trace', 'refine', 'join']);
  });
});

describe('planModeSwitch', () => {
  /** The whole table: what each mode does on the way to each other mode, for each picked hold. */
  function expected(from: SprayEditorMode, to: SprayEditorMode, role: SprayHoldRole | null): SprayModeSwitchPlan {
    if (from === to) return 'refuse';
    if (to === 'select') return 'exit';
    if (to === 'add') return 'enter';
    return role === 'on' ? 'enter' : 'pick';
  }

  for (const from of MODES) {
    for (const to of MODES) {
      for (const role of ROLES) {
        it(`${from} → ${to} with ${role ?? 'nothing'} picked: ${expected(from, to, role)}`, () => {
          expect(planModeSwitch(from, to, { selectedHoldRole: role })).toBe(expected(from, to, role));
        });
      }
    }
  }

  it('starts a hold-needing mode on the picked ON hold straight away', () => {
    expect(planModeSwitch('select', 'trace', { selectedHoldRole: 'on' })).toBe('enter');
    expect(planModeSwitch('trace', 'refine', { selectedHoldRole: 'on' })).toBe('enter');
    expect(planModeSwitch('refine', 'join', { selectedHoldRole: 'on' })).toBe('enter');
  });

  it('asks for an ON hold when the picked one is off or a maybe', () => {
    expect(planModeSwitch('select', 'trace', { selectedHoldRole: 'off' })).toBe('pick');
    expect(planModeSwitch('select', 'join', { selectedHoldRole: 'maybe' })).toBe('pick');
  });

  it('refuses everything while the wall is locked', () => {
    for (const from of MODES) {
      for (const to of MODES) {
        expect(planModeSwitch(from, to, { selectedHoldRole: 'on', locked: true })).toBe('refuse');
      }
    }
  });
});
