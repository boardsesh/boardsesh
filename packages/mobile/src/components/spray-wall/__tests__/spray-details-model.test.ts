import { describe, expect, it, vi } from 'vitest';
import {
  buildSprayDetailsModel,
  parseSprayVisibility,
  snapSprayAngle,
  sprayAngleStep,
  type SprayDetailsModelInput,
} from '../spray-details-model';
import type { MoreRow } from '../../MoreForm.types';

const echo = (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key);
const ANGLES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70];

function makeInput(overrides: Partial<SprayDetailsModelInput> = {}): SprayDetailsModelInput {
  return {
    t: echo,
    name: 'Garage wall',
    defaultName: "Marco's Spray wall",
    onRename: vi.fn(),
    visibility: 'private',
    onVisibilitySelect: vi.fn(),
    angle: 40,
    angles: ANGLES,
    onAngleChange: vi.fn(),
    onAngleCommit: vi.fn(),
    formatAngle: (angle) => `${angle}°`,
    gymName: null,
    onOpenGym: vi.fn(),
    saveError: null,
    wallCap: 10,
    ...overrides,
  };
}

function findRow(input: SprayDetailsModelInput, key: string): MoreRow {
  const row = buildSprayDetailsModel(input)
    .sections.flatMap((section) => section.rows)
    .find((candidate) => candidate.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
}

describe('buildSprayDetailsModel', () => {
  it('runs name, who can see it, angle, then the gym', () => {
    expect(buildSprayDetailsModel(makeInput()).sections.map((section) => section.key)).toEqual([
      'name',
      'visibility',
      'angle',
      'gym',
    ]);
  });

  it('puts a failed save first, as an info row in its own words', () => {
    const model = buildSprayDetailsModel(makeInput({ saveError: "Couldn't save your wall's details." }));
    expect(model.sections[0]).toEqual({
      key: 'saveError',
      rows: [
        { kind: 'info', key: 'saveError', label: 'sprayWizard.notSaved', body: "Couldn't save your wall's details." },
      ],
    });
  });

  it('shows the name as a row that opens the rename sheet', () => {
    const onRename = vi.fn();
    const row = findRow(makeInput({ onRename }), 'name');
    if (row.kind !== 'value') throw new Error('name is not a value row');
    expect(row.value).toBe('Garage wall');
    expect(row.label).toBe('sprayWizard.details.name');
    expect(row.accessibilityHint).toBe('sprayWizard.details.renameHint');
    row.onPress?.();
    expect(onRename).toHaveBeenCalledOnce();
  });

  it('falls back to the default name while the name is blank', () => {
    const row = findRow(makeInput({ name: '   ' }), 'name');
    if (row.kind !== 'value') throw new Error('name is not a value row');
    expect(row.value).toBe("Marco's Spray wall");
  });

  it.each([
    ['private', 'mobile.sprayVisibility.privateHint'],
    ['unlisted', 'mobile.sprayVisibility.unlistedHint'],
    ['public', 'mobile.sprayVisibility.publicHint'],
  ] as const)('says what %s means in the footer', (visibility, hint) => {
    const section = buildSprayDetailsModel(makeInput({ visibility })).sections.find((s) => s.key === 'visibility');
    expect(section?.title).toBe('mobile.sprayVisibility.label');
    expect(section?.footer).toBe(hint);
  });

  it('offers the three visibilities in one control, wired to the stable handler it is given', () => {
    const onVisibilitySelect = vi.fn();
    const row = findRow(makeInput({ onVisibilitySelect }), 'visibility');
    if (row.kind !== 'segmented') throw new Error('visibility is not segmented');
    expect(row.options.map((option) => option.key)).toEqual(['private', 'unlisted', 'public']);
    expect(row.selectedKey).toBe('private');
    // The same function, not a fresh closure per build: the form rebuilds on every drag frame.
    expect(row.onSelect).toBe(onVisibilitySelect);
  });

  it('steps the angle slider by the gap between offered angles, with the stable handlers it is given', () => {
    const onAngleChange = vi.fn();
    const onAngleCommit = vi.fn();
    const row = findRow(makeInput({ onAngleChange, onAngleCommit }), 'angle');
    if (row.kind !== 'slider') throw new Error('angle is not a slider');
    expect({ min: row.min, max: row.max, step: row.step, value: row.value }).toEqual({
      min: 0,
      max: 70,
      step: 5,
      value: 40,
    });
    expect(row.format(45)).toBe('45°');
    expect(row.onValueChange).toBe(onAngleChange);
    expect(row.onCommit).toBe(onAngleCommit);
  });

  it('says the angle is fixed once published', () => {
    const section = buildSprayDetailsModel(makeInput()).sections.find((s) => s.key === 'angle');
    expect(section?.footer).toBe('sprayWizard.details.angleHint');
  });

  it('shows the gym, or that the wall is not at one, and ends on the wall cap', () => {
    const onOpenGym = vi.fn();
    const none = findRow(makeInput({ onOpenGym }), 'gym');
    if (none.kind !== 'nav') throw new Error('gym is not a nav row');
    expect(none.value).toBe('mobile.create.gymNone');
    none.onPress();
    expect(onOpenGym).toHaveBeenCalledOnce();

    const linked = findRow(makeInput({ gymName: 'The Arch' }), 'gym');
    if (linked.kind !== 'nav') throw new Error('gym is not a nav row');
    expect(linked.value).toBe('The Arch');

    const sections = buildSprayDetailsModel(makeInput()).sections;
    expect(sections.at(-1)?.footer).toBe('sprayCaps.wallsHint:{"max":10}');
  });
});

describe('parseSprayVisibility', () => {
  it('reads the three keys back and refuses anything else', () => {
    expect(parseSprayVisibility('private')).toBe('private');
    expect(parseSprayVisibility('unlisted')).toBe('unlisted');
    expect(parseSprayVisibility('public')).toBe('public');
    expect(parseSprayVisibility('everyone')).toBeNull();
  });
});

describe('the angle helpers', () => {
  it('snaps to the nearest offered angle, clamping past either end', () => {
    expect(snapSprayAngle(42, ANGLES)).toBe(40);
    expect(snapSprayAngle(43, ANGLES)).toBe(45);
    expect(snapSprayAngle(-10, ANGLES)).toBe(0);
    expect(snapSprayAngle(99, ANGLES)).toBe(70);
  });

  it('reads the step from the list, and falls back to 1 for a list too short to say', () => {
    expect(sprayAngleStep(ANGLES)).toBe(5);
    expect(sprayAngleStep([40])).toBe(1);
  });
});
