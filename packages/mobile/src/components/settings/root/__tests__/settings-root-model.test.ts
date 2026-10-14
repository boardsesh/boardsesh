import { describe, expect, it, vi } from 'vitest';
import { buildSettingsRootModel, SETTINGS_ROOT_ORDER, type SettingsRootModelInput } from '../settings-root-model';
import { SETTINGS_ROOT_ROUTES, settingsPageTitle } from '../settings-pages';
import type { MoreNavRow } from '../../../MoreForm.types';

const echo = (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key);

const ALL_VISIBLE = { account: true, earlyAccess: true, developer: true } as const;

function makeInput(overrides: Partial<SettingsRootModelInput> = {}): SettingsRootModelInput {
  return {
    t: echo,
    syncIssues: null,
    visible: { account: true, earlyAccess: false, developer: false },
    values: {},
    onOpen: vi.fn(),
    ...overrides,
  };
}

function rowKeysBySection(input: SettingsRootModelInput): [string, string[]][] {
  return buildSettingsRootModel(input).sections.map((section) => [section.key, section.rows.map((row) => row.key)]);
}

function navRow(input: SettingsRootModelInput, key: string): MoreNavRow {
  const row = buildSettingsRootModel(input)
    .sections.flatMap((section) => section.rows)
    .find((candidate) => candidate.key === key);
  if (!row || row.kind !== 'nav') throw new Error(`no nav row ${key}`);
  return row;
}

describe('buildSettingsRootModel — order', () => {
  it('signed in: General, Privacy, Account, Connected apps; then Board and Climbs & grades', () => {
    expect(rowKeysBySection(makeInput())).toEqual([
      ['app', ['general', 'privacy', 'account', 'integrations']],
      ['climbing', ['board', 'climbs']],
    ]);
  });

  it('signed out: the same groups, without Account', () => {
    expect(rowKeysBySection(makeInput({ visible: { account: false, earlyAccess: false, developer: false } }))).toEqual([
      ['app', ['general', 'privacy', 'integrations']],
      ['climbing', ['board', 'climbs']],
    ]);
  });

  it('takes every group straight from the one ordered constant', () => {
    expect(rowKeysBySection(makeInput({ visible: ALL_VISIBLE }))).toEqual(
      SETTINGS_ROOT_ORDER.map((group) => [group.key, [...group.pages]]),
    );
  });

  it('keeps sync issues above everything, General included', () => {
    const onRetry = vi.fn();
    const model = buildSettingsRootModel(makeInput({ syncIssues: { count: 3, onRetry } }));
    expect(model.sections.map((section) => section.key)).toEqual(['syncIssues', 'app', 'climbing']);
    const [syncIssues] = model.sections;
    expect(syncIssues.footer).toBe('mobile.settings.syncIssues.description:{"count":3}');
    const retry = syncIssues.rows[0];
    if (retry.kind !== 'button') throw new Error('retry is not a button');
    retry.onPress();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('puts Early access and Developer last, in their own group', () => {
    const sections = rowKeysBySection(makeInput({ visible: ALL_VISIBLE }));
    expect(sections.at(-1)).toEqual(['testing', ['earlyAccess', 'developer']]);
  });
});

describe('buildSettingsRootModel — who sees what', () => {
  it('leaves the testing group out entirely when neither page applies', () => {
    expect(rowKeysBySection(makeInput()).map(([key]) => key)).not.toContain('testing');
  });

  it('shows Developer without Early access', () => {
    const sections = rowKeysBySection(makeInput({ visible: { account: true, earlyAccess: false, developer: true } }));
    expect(sections.at(-1)).toEqual(['testing', ['developer']]);
  });

  it('no longer lists Offline or Board lighting, which live on General and Board', () => {
    const keys = rowKeysBySection(makeInput({ visible: ALL_VISIBLE })).flatMap(([, rows]) => rows);
    expect(keys).not.toContain('offline');
    expect(keys).not.toContain('boardLighting');
  });
});

describe('buildSettingsRootModel — rows', () => {
  it('labels each row with the title of the page it opens', () => {
    for (const page of SETTINGS_ROOT_ORDER.flatMap((group) => group.pages)) {
      expect(navRow(makeInput({ visible: ALL_VISIBLE }), page).label).toBe(settingsPageTitle(page, echo));
    }
    expect(settingsPageTitle('board', echo)).toBe('mobile.settings.pages.board.title');
  });

  it('gives every row an icon and no subtitle', () => {
    const rows = buildSettingsRootModel(makeInput({ visible: ALL_VISIBLE })).sections.flatMap(
      (section) => section.rows,
    );
    for (const row of rows) {
      if (row.kind !== 'nav') throw new Error(`${row.key} is not a nav row`);
      expect(row.icon).toBeDefined();
      expect(row.subtitle).toBeUndefined();
    }
  });

  it('shows the current look and grade format as values', () => {
    const input = makeInput({ values: { board: 'Aura', climbs: 'V grade' } });
    expect(navRow(input, 'board').value).toBe('Aura');
    expect(navRow(input, 'climbs').value).toBe('V grade');
    expect(navRow(input, 'general').value).toBeUndefined();
  });

  it('opens the page the row names', () => {
    const onOpen = vi.fn();
    navRow(makeInput({ onOpen }), 'board').onPress();
    expect(onOpen).toHaveBeenCalledWith('board');
    expect(SETTINGS_ROOT_ROUTES.board).toBe('/settings/board-look');
    expect(SETTINGS_ROOT_ROUTES.climbs).toBe('/settings/climbs');
  });
});
