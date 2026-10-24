// @vitest-environment jsdom
// The timed blocks' fields: their counts with the bounds the player and the
// partner API need, and their rests on the rest timer's own picker, where a
// stage rest can be Off (no rest) and an interval cannot.
import { render } from '@testing-library/react';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FOUR_BY_FOUR_OPTIONS,
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_LIMIT_BOULDERING_OPTIONS,
  DEFAULT_ON_THE_MINUTE_OPTIONS,
  DEFAULT_PYRAMID_OPTIONS,
  type GeneratorOptions,
} from '@boardsesh/playlist-generator';

type PickerProps = {
  value: number | null;
  allowOff?: boolean;
  accessibilityName?: string;
  onChange: (next: number | null) => void;
};
const pickers = vi.hoisted(() => ({ rendered: [] as PickerProps[] }));

vi.mock('react-native', () => ({
  DynamicColorIOS: (colors: unknown) => colors,
  Platform: { OS: 'ios', select: (choices: { ios?: unknown }) => choices.ios },
  PlatformColor: (name: string) => name,
  Pressable: () => null,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: () => () => null },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: number) => ({ value }),
  withSpring: (value: number) => value,
}));
vi.mock('../../../Stepper', () => ({ Stepper: () => null }));
vi.mock('../../../SwitchRow', () => ({ SwitchRow: () => null }));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../queue-control/RestLengthPicker', () => ({
  RestLengthPicker: (props: PickerProps) => {
    pickers.rendered.push(props);
    return null;
  },
}));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, variant: 'liquidGlass', m3: {} }),
}));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));

import { workoutStepperRows } from '../generator-controls';

const t = (key: string) => key;

type RowElement = ReactElement<Record<string, unknown>>;

function rowsFor(options: GeneratorOptions, onOptionsChange: (options: GeneratorOptions) => void = vi.fn()) {
  return workoutStepperRows(options, t, onOptionsChange).map((row) => {
    if (!isValidElement(row.node)) throw new Error(`row ${row.key} is not an element`);
    return { key: row.key, element: row.node as RowElement };
  });
}

/** Renders one rest row and returns the props its picker got. */
function pickerFor(element: RowElement): PickerProps {
  pickers.rendered = [];
  render(element);
  const props = pickers.rendered.at(-1);
  if (!props) throw new Error('no picker rendered');
  return props;
}

describe('workoutStepperRows for a ladder', () => {
  it('ends with a Hardest first switch that sets descending', () => {
    const onOptionsChange = vi.fn();
    const options = { ...DEFAULT_LADDER_OPTIONS, targetGrade: 18 };
    const rows = rowsFor(options, onOptionsChange);

    expect(rows.map((row) => row.key)).toEqual(['numberOfSteps', 'climbsPerStep', 'descending']);
    const switchProps = rows[2].element.props as { value: boolean; onValueChange: (next: boolean) => void };
    expect(rows[2].element.props).toMatchObject({
      label: 'mobile.session.preGeneratorHardestFirst',
      value: false,
    });
    switchProps.onValueChange(true);
    expect(onOptionsChange).toHaveBeenCalledWith({ ...options, descending: true });
  });

  it('shows the switch on when descending', () => {
    const rows = rowsFor({ ...DEFAULT_LADDER_OPTIONS, targetGrade: 18, descending: true });
    expect(rows[2].element.props).toMatchObject({ value: true });
  });

  it('gives a pyramid no switch', () => {
    const rows = rowsFor({ ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 18 });
    expect(rows.map((row) => row.key)).toEqual(['numberOfSteps', 'climbsPerStep']);
  });
});

describe('workoutStepperRows for timed blocks', () => {
  it('gives a 4x4 its climbs per round (2 to 10), rounds (1 to 10) and both rests', () => {
    const rows = rowsFor({ ...DEFAULT_FOUR_BY_FOUR_OPTIONS, targetGrade: 18 });

    expect(rows.map((row) => row.key)).toEqual([
      'climbsPerRound',
      'rounds',
      'restBetweenClimbsSeconds',
      'restBetweenRoundsSeconds',
    ]);
    expect(rows[0].element.props).toMatchObject({
      label: 'mobile.session.preGeneratorClimbsPerRound',
      min: 2,
      max: 10,
    });
    expect(rows[1].element.props).toMatchObject({ label: 'mobile.session.preGeneratorRounds', min: 1, max: 10 });
    expect(rows[2].element.props).toMatchObject({
      label: 'mobile.session.preGeneratorRestBetweenClimbs',
      allowOff: true,
    });
    expect(rows[3].element.props).toMatchObject({
      label: 'mobile.session.preGeneratorRestBetweenRounds',
      allowOff: true,
    });
  });

  it('gives on the minute 1 to 40 climbs and an interval that cannot be Off', () => {
    const rows = rowsFor({ ...DEFAULT_ON_THE_MINUTE_OPTIONS, targetGrade: 18 });

    expect(rows.map((row) => row.key)).toEqual(['numberOfClimbs', 'intervalSeconds']);
    expect(rows[0].element.props).toMatchObject({ min: 1, max: 40 });
    expect(rows[1].element.props).toMatchObject({ label: 'mobile.session.preGeneratorInterval', allowOff: false });
  });

  it('gives limit bouldering 1 to 10 climbs and the rest after each attempt', () => {
    const rows = rowsFor({ ...DEFAULT_LIMIT_BOULDERING_OPTIONS, targetGrade: 22 });

    expect(rows.map((row) => row.key)).toEqual(['numberOfClimbs', 'restSeconds']);
    expect(rows[0].element.props).toMatchObject({ min: 1, max: 10 });
    expect(rows[1].element.props).toMatchObject({ label: 'mobile.session.preGeneratorRestAfterEachAttempt' });
  });

  it('shows no rest as Off and writes Off back as no rest', () => {
    const onOptionsChange = vi.fn();
    const fourByFour = { ...DEFAULT_FOUR_BY_FOUR_OPTIONS, targetGrade: 18 };
    const rows = rowsFor(fourByFour, onOptionsChange);

    const climbRest = pickerFor(rows[2].element);
    expect(climbRest).toMatchObject({
      value: null,
      allowOff: true,
      accessibilityName: 'mobile.session.preGeneratorRestBetweenClimbs',
    });
    climbRest.onChange(90);
    expect(onOptionsChange).toHaveBeenLastCalledWith({ ...fourByFour, restBetweenClimbsSeconds: 90 });

    const roundRest = pickerFor(rows[3].element);
    expect(roundRest.value).toBe(180);
    roundRest.onChange(null);
    expect(onOptionsChange).toHaveBeenLastCalledWith({ ...fourByFour, restBetweenRoundsSeconds: 0 });
  });

  it('always shows the interval as a length', () => {
    const onOptionsChange = vi.fn();
    const onTheMinute = { ...DEFAULT_ON_THE_MINUTE_OPTIONS, targetGrade: 18 };
    const interval = pickerFor(rowsFor(onTheMinute, onOptionsChange)[1].element);

    expect(interval).toMatchObject({ value: 60, allowOff: false });
    interval.onChange(45);
    expect(onOptionsChange).toHaveBeenLastCalledWith({ ...onTheMinute, intervalSeconds: 45 });
  });
});
