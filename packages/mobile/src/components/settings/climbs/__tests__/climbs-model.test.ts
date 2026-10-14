import { describe, expect, it, vi } from 'vitest';
import { buildClimbsModel, gradeFormatOptions, type ClimbsModelInput } from '../climbs-model';
import type { MoreRow } from '../../../MoreForm.types';

const echo = (key: string) => key;

function makeInput(overrides: Partial<ClimbsModelInput> = {}): ClimbsModelInput {
  return {
    t: echo,
    gradeFormat: 'v-grade',
    onGradeFormatChange: vi.fn(),
    personalGrades: false,
    onPersonalGradesChange: vi.fn(),
    boardseshGrades: null,
    climbListPresetLabel: 'Default',
    onOpenClimbList: vi.fn(),
    climbDrawerSection: { key: 'climbDrawer', title: 'Below the climb', rows: [] },
    ...overrides,
  };
}

function findRow(input: ClimbsModelInput, key: string): MoreRow {
  const row = buildClimbsModel(input)
    .sections.flatMap((section) => section.rows)
    .find((candidate) => candidate.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
}

describe('buildClimbsModel', () => {
  it('runs grades, then the climb list, then the climb view', () => {
    // The Maestro tutorial finds the "Use my grades" switch by its neighbours:
    // the Below the climb section has to stay below it.
    expect(buildClimbsModel(makeInput()).sections.map((section) => section.key)).toEqual([
      'grades',
      'climbList',
      'climbDrawer',
    ]);
  });

  it('keeps the grade format description as the grades footer', () => {
    expect(buildClimbsModel(makeInput()).sections[0].footer).toBe('mobile.settings.gradeFormat.description');
  });

  it('only lists Boardsesh grades when the flag is on', () => {
    const keys = (input: ClimbsModelInput) => buildClimbsModel(input).sections[0].rows.map((row) => row.key);
    expect(keys(makeInput())).toEqual(['gradeFormat', 'personalGrades']);
    expect(keys(makeInput({ boardseshGrades: { enabled: true, onChange: vi.fn() } }))).toEqual([
      'gradeFormat',
      'personalGrades',
      'boardseshGrades',
    ]);
  });

  it('changes the grade format to a known option only', () => {
    const onGradeFormatChange = vi.fn();
    const row = findRow(makeInput({ onGradeFormatChange }), 'gradeFormat');
    if (row.kind !== 'segmented') throw new Error('gradeFormat is not segmented');
    row.onSelect('font');
    row.onSelect('not-a-format');
    expect(onGradeFormatChange).toHaveBeenCalledTimes(1);
    expect(onGradeFormatChange).toHaveBeenCalledWith('font');
  });

  it('shows the resolved personal-grades value and hands a flip straight on', () => {
    const onPersonalGradesChange = vi.fn();
    const row = findRow(makeInput({ personalGrades: true, onPersonalGradesChange }), 'personalGrades');
    if (row.kind !== 'toggle') throw new Error('personalGrades is not a toggle');
    expect(row.value).toBe(true);
    row.onValueChange(false);
    expect(onPersonalGradesChange).toHaveBeenCalledWith(false);
  });

  it('shows the current climb-list preset as the row value, with the New badge', () => {
    const onOpenClimbList = vi.fn();
    const row = findRow(makeInput({ climbListPresetLabel: 'Names only', onOpenClimbList }), 'climbList');
    if (row.kind !== 'nav') throw new Error('climbList is not a nav row');
    expect(row.value).toBe('Names only');
    expect(row.subtitle).toBeUndefined();
    expect(row.badge).toBe('userDrawer.newBadge');
    row.onPress();
    expect(onOpenClimbList).toHaveBeenCalledOnce();
  });
});

describe('gradeFormatOptions', () => {
  it('labels every format', () => {
    expect(gradeFormatOptions(echo)).toEqual([
      { key: 'v-grade', label: 'mobile.settings.gradeFormat.vGrade' },
      { key: 'font', label: 'mobile.settings.gradeFormat.font' },
      { key: 'both', label: 'mobile.settings.gradeFormat.both' },
    ]);
  });
});
