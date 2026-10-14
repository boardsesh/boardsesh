import { describe, expect, it, vi } from 'vitest';
import { buildSettingsRootModel, SETTINGS_ROOT_ORDER, type SettingsRootModelInput } from '../settings-root-model';
import { SETTINGS_ROOT_ROUTES, settingsPageTitle } from '../settings-pages';
import type { MoreNavRow } from '../../../MoreForm.types';

const echo = (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key);

function makeInput(overrides: Partial<SettingsRootModelInput> = {}): SettingsRootModelInput {
  return {
    t: echo,
    syncIssues: null,
    visible: { account: true, offline: true, earlyAccess: false, developer: false },
    values: {},
    onOpen: vi.fn(),
    ...overrides,
  };
}

function rowKeysBySection(input: SettingsRootModelInput): Record<string, string[]> {
  return Object.fromEntries(
    buildSettingsRootModel(input).sections.map((section) => [section.key, section.rows.map((row) => row.key)]),
  );
}

function navRow(input: SettingsRootModelInput, key: string): MoreNavRow {
  const row = buildSettingsRootModel(input)
    .sections.flatMap((section) => section.rows)
    .find((candidate) => candidate.key === key);
  if (!row || row.kind !== 'nav') throw new Error(`no nav row ${key}`);
  return row;
}

describe('buildSettingsRootModel — order', () => {
  it('leads with Privacy, then the pages in SETTINGS_ROOT_ORDER', () => {
    expect(rowKeysBySection(makeInput())).toEqual({
      privacy: ['privacy'],
      pages: ['integrations', 'account', 'boardLook', 'offline', 'general', 'climbs', 'boardLighting'],
    });
  });

  it('takes its middle group straight from the one ordered constant', () => {
    expect(rowKeysBySection(makeInput()).pages).toEqual([...SETTINGS_ROOT_ORDER]);
  });

  it('keeps sync issues above everything, Privacy included', () => {
    const onRetry = vi.fn();
    const model = buildSettingsRootModel(makeInput({ syncIssues: { count: 3, onRetry } }));
    expect(model.sections.map((section) => section.key)).toEqual(['syncIssues', 'privacy', 'pages']);
    const [syncIssues] = model.sections;
    expect(syncIssues.footer).toBe('mobile.settings.syncIssues.description:{"count":3}');
    const retry = syncIssues.rows[0];
    if (retry.kind !== 'button') throw new Error('retry is not a button');
    retry.onPress();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('puts Early access and Developer last, in their own group', () => {
    const keys = rowKeysBySection(
      makeInput({ visible: { account: true, offline: true, earlyAccess: true, developer: true } }),
    );
    expect(keys.testing).toEqual(['earlyAccess', 'developer']);
  });
});

describe('buildSettingsRootModel — who sees what', () => {
  it('shows Privacy to a signed-out climber, and drops Account', () => {
    const keys = rowKeysBySection(
      makeInput({ visible: { account: false, offline: true, earlyAccess: false, developer: false } }),
    );
    expect(keys.privacy).toEqual(['privacy']);
    expect(keys.pages).not.toContain('account');
  });

  it('drops Offline & storage when neither offline nor storage applies', () => {
    const keys = rowKeysBySection(
      makeInput({ visible: { account: true, offline: false, earlyAccess: false, developer: false } }),
    );
    expect(keys.pages).not.toContain('offline');
  });

  it('leaves the testing group out entirely when neither page applies', () => {
    expect(Object.keys(rowKeysBySection(makeInput()))).not.toContain('testing');
  });

  it('shows Developer without Early access', () => {
    const keys = rowKeysBySection(
      makeInput({ visible: { account: true, offline: true, earlyAccess: false, developer: true } }),
    );
    expect(keys.testing).toEqual(['developer']);
  });
});

describe('buildSettingsRootModel — rows', () => {
  it('labels each row with the title of the page it opens', () => {
    for (const page of ['privacy', ...SETTINGS_ROOT_ORDER] as const) {
      expect(navRow(makeInput(), page).label).toBe(settingsPageTitle(page, echo));
    }
  });

  it('gives every row an icon and no subtitle', () => {
    const rows = buildSettingsRootModel(
      makeInput({ visible: { account: true, offline: true, earlyAccess: true, developer: true } }),
    ).sections.flatMap((section) => section.rows);
    for (const row of rows) {
      if (row.kind !== 'nav') throw new Error(`${row.key} is not a nav row`);
      expect(row.icon).toBeDefined();
      expect(row.subtitle).toBeUndefined();
    }
  });

  it('shows the current look, grade format and offline state as values', () => {
    const input = makeInput({ values: { boardLook: 'Bold', climbs: 'V grade', offline: 'On' } });
    expect(navRow(input, 'boardLook').value).toBe('Bold');
    expect(navRow(input, 'climbs').value).toBe('V grade');
    expect(navRow(input, 'offline').value).toBe('On');
    expect(navRow(input, 'general').value).toBeUndefined();
  });

  it('opens the page the row names', () => {
    const onOpen = vi.fn();
    navRow(makeInput({ onOpen }), 'climbs').onPress();
    expect(onOpen).toHaveBeenCalledWith('climbs');
    expect(SETTINGS_ROOT_ROUTES.climbs).toBe('/settings/climbs');
  });
});
