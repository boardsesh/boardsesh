import { describe, expect, it, vi } from 'vitest';
import type { MoreSegmentedRow, MoreSelectRow, MoreToggleRow } from '../../../MoreForm.types';
import {
  buildTimersModel,
  REST_LENGTH_LADDER_SECONDS,
  restLengthKey,
  restLengthSummary,
  type TimersModelInput,
} from '../timers-model';

const echo = (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key);

function makeInput(
  overrides: { rest?: Partial<TimersModelInput['rest']>; cues?: Partial<TimersModelInput['cues']> } = {},
) {
  return {
    t: echo,
    rest: {
      targetSeconds: 180,
      mode: 'afterTick',
      autoAdvance: false,
      autoAdvanceBlockedByCrew: false,
      onTargetChange: vi.fn(),
      onModeChange: vi.fn(),
      onAutoAdvanceChange: vi.fn(),
      ...overrides.rest,
    },
    cues: {
      countdownCues: null,
      sound: null,
      ...overrides.cues,
    },
  } satisfies TimersModelInput;
}

function rowsOf(input: TimersModelInput) {
  return buildTimersModel(input).sections.flatMap((section) => section.rows);
}
function find<T>(input: TimersModelInput, key: string, kind: string): T {
  const row = rowsOf(input).find((candidate) => candidate.key === key);
  if (row?.kind !== kind) throw new Error(`no ${kind} row ${key}`);
  return row as T;
}

describe('buildTimersModel', () => {
  it('leaves the cues section out when it has no rows', () => {
    expect(buildTimersModel(makeInput()).sections.map((section) => section.key)).toEqual(['rest']);
  });

  it('runs the rest section, then the cues when one is available', () => {
    const input = makeInput({ cues: { sound: { enabled: true, onChange: vi.fn() } } });
    expect(buildTimersModel(input).sections.map((section) => section.key)).toEqual(['rest', 'cues']);
    expect(rowsOf(makeInput()).map((row) => row.key)).toEqual(['restLength', 'restMode', 'autoAdvance']);
  });

  describe('rest length', () => {
    it('offers Off then 0:30 to 10:00 in 30 s rungs', () => {
      const row = find<MoreSelectRow>(makeInput(), 'restLength', 'select');
      expect(row.options[0]).toEqual({ key: 'off', label: 'mobile.settings.timers.restLengthOff' });
      expect(row.options.slice(1).map((option) => option.label)).toEqual(
        REST_LENGTH_LADDER_SECONDS.map(
          (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
        ),
      );
      expect(row.options).toHaveLength(21);
      expect(row.options[1].label).toBe('0:30');
      expect(row.options.at(-1)?.label).toBe('10:00');
    });

    it('selects the saved length, or Off when there is none', () => {
      expect(find<MoreSelectRow>(makeInput(), 'restLength', 'select').selectedKey).toBe('180');
      expect(
        find<MoreSelectRow>(makeInput({ rest: { targetSeconds: null } }), 'restLength', 'select').selectedKey,
      ).toBe('off');
    });

    it('keeps an off-ladder length as a choice, in order', () => {
      const row = find<MoreSelectRow>(makeInput({ rest: { targetSeconds: 100 } }), 'restLength', 'select');
      expect(row.selectedKey).toBe('100');
      expect(row.options.map((option) => option.label).slice(0, 5)).toEqual([
        'mobile.settings.timers.restLengthOff',
        '0:30',
        '1:00',
        '1:30',
        '1:40',
      ]);
    });

    it('keeps a length past 10:00 at the end', () => {
      const row = find<MoreSelectRow>(makeInput({ rest: { targetSeconds: 1800 } }), 'restLength', 'select');
      expect(row.options.at(-1)).toEqual({ key: '1800', label: '30:00' });
    });

    it('turns a pick into seconds, and Off into null', () => {
      const onTargetChange = vi.fn();
      const row = find<MoreSelectRow>(makeInput({ rest: { onTargetChange } }), 'restLength', 'select');
      row.onSelect('90');
      row.onSelect('off');
      expect(onTargetChange.mock.calls).toEqual([[90], [null]]);
    });
  });

  describe('cadence', () => {
    it('names the fixed window by its length', () => {
      const row = find<MoreSegmentedRow>(makeInput(), 'restMode', 'segmented');
      expect(row.options).toEqual([
        { key: 'afterTick', label: 'mobile.settings.timers.modeAfterTick' },
        { key: 'onTheMinute', label: 'mobile.settings.timers.modeEvery {"length":"3:00"}' },
      ]);
    });

    it('falls back to the plain name with no length', () => {
      const row = find<MoreSegmentedRow>(makeInput({ rest: { targetSeconds: null } }), 'restMode', 'segmented');
      expect(row.options[1].label).toBe('mobile.settings.timers.modeOnTheMinute');
    });

    it('reports the chosen cadence and explains it in the footer', () => {
      const onModeChange = vi.fn();
      const input = makeInput({ rest: { mode: 'onTheMinute', onModeChange } });
      const row = find<MoreSegmentedRow>(input, 'restMode', 'segmented');
      expect(row.selectedKey).toBe('onTheMinute');
      expect(buildTimersModel(input).sections[0].footer).toBe('mobile.settings.timers.modeOnTheMinuteHint');
      row.onSelect('afterTick');
      expect(onModeChange).toHaveBeenCalledWith('afterTick');
    });

    it('ignores a key that is not a cadence', () => {
      const onModeChange = vi.fn();
      find<MoreSegmentedRow>(makeInput({ rest: { onModeChange } }), 'restMode', 'segmented').onSelect('nonsense');
      expect(onModeChange).not.toHaveBeenCalled();
    });
  });

  describe('auto-advance', () => {
    it('is available with a length', () => {
      const row = find<MoreToggleRow>(makeInput(), 'autoAdvance', 'toggle');
      expect(row.disabled).toBe(false);
      expect(row.subtitle).toBe('mobile.settings.timers.autoAdvanceHint');
    });

    it('needs a length, and says so', () => {
      const row = find<MoreToggleRow>(makeInput({ rest: { targetSeconds: null } }), 'autoAdvance', 'toggle');
      expect(row.disabled).toBe(true);
      expect(row.subtitle).toBe('mobile.settings.timers.autoAdvanceNeedsLength');
    });

    it('gives the crew reason before the missing-length one', () => {
      const row = find<MoreToggleRow>(
        makeInput({ rest: { targetSeconds: null, autoAdvanceBlockedByCrew: true } }),
        'autoAdvance',
        'toggle',
      );
      expect(row.disabled).toBe(true);
      expect(row.subtitle).toBe('mobile.settings.timers.autoAdvanceBlocked');
    });
  });

  describe('cues', () => {
    it('has no sound row on a build that cannot play one', () => {
      expect(rowsOf(makeInput()).map((row) => row.key)).not.toContain('sound');
    });

    it('adds the sound row where a sound can play', () => {
      const onChange = vi.fn();
      const row = find<MoreToggleRow>(makeInput({ cues: { sound: { enabled: true, onChange } } }), 'sound', 'toggle');
      expect(row.value).toBe(true);
      row.onValueChange(false);
      expect(onChange).toHaveBeenCalledWith(false);
    });

    it('writes the countdown switch', () => {
      const onChange = vi.fn();
      const row = find<MoreToggleRow>(
        makeInput({ cues: { countdownCues: { enabled: true, onChange } } }),
        'countdownCues',
        'toggle',
      );
      expect(row.value).toBe(true);
      row.onValueChange(false);
      expect(onChange).toHaveBeenCalledWith(false);
    });

    it('leaves the countdown row out until something reads it', () => {
      expect(rowsOf(makeInput()).map((row) => row.key)).not.toContain('countdownCues');
    });
  });
});

describe('restLengthKey and restLengthSummary', () => {
  it('treat null and zero as Off', () => {
    expect(restLengthKey(null)).toBe('off');
    expect(restLengthKey(0)).toBe('off');
    expect(restLengthSummary(echo, 0)).toBe('mobile.settings.timers.restLengthOff');
  });

  it('shows a saved length as m:ss', () => {
    expect(restLengthSummary(echo, 90)).toBe('1:30');
  });
});
