import { describe, expect, it, vi } from 'vitest';
import { buildAccountModel, type AccountModelInput } from '../account-model';
import { buildSettingsRootModel } from '../../root/settings-root-model';
import type { MoreButtonRow } from '../../../MoreForm.types';

const echo = (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key);

function makeInput(overrides: Partial<AccountModelInput> = {}): AccountModelInput {
  return {
    t: echo,
    syncIssues: null,
    email: 'alex@example.com',
    onEditProfile: vi.fn(),
    onExportData: vi.fn(),
    onSignOut: vi.fn(),
    onDeleteAccount: vi.fn(),
    ...overrides,
  };
}

function button(input: AccountModelInput, key: string): MoreButtonRow {
  const row = buildAccountModel(input)
    .sections.flatMap((section) => section.rows)
    .find((candidate) => candidate.key === key);
  if (!row || row.kind !== 'button') throw new Error(`no button ${key}`);
  return row;
}

describe('buildAccountModel', () => {
  it('leads with Edit profile, then your data, and ends with the two ways out', () => {
    expect(
      buildAccountModel(makeInput()).sections.map((section) => [section.key, section.rows.map((row) => row.key)]),
    ).toEqual([
      ['profile', ['editProfile']],
      ['yourData', ['exportData']],
      ['accountActions', ['signOut', 'deleteAccount']],
    ]);
  });

  it('carries the export under Your data, and no Privacy row, which has its own page', () => {
    const model = buildAccountModel(makeInput());
    expect(model.sections.flatMap((section) => section.rows.map((row) => row.key))).not.toContain('privacy');
    const yourData = model.sections.find((section) => section.key === 'yourData');
    expect(yourData?.title).toBe('settings:privacy.yourData');
    const exportRow = yourData?.rows[0];
    if (exportRow?.kind !== 'nav') throw new Error('exportData is not a nav row');
    expect(exportRow.label).toBe('settings:export.title');
    expect(exportRow.icon).toBe('export');
  });

  it('shows the email under Edit profile, and nothing while it is unknown', () => {
    expect(buildAccountModel(makeInput()).sections[0].footer).toBe('alex@example.com');
    expect(buildAccountModel(makeInput({ email: null })).sections[0].footer).toBeUndefined();
  });

  it('makes Sign out the full-strength red action and Delete account the quiet one', () => {
    const input = makeInput();
    expect(button(input, 'signOut')).toMatchObject({ role: 'destructive', emphasis: 'primary' });
    expect(button(input, 'deleteAccount')).toMatchObject({ role: 'destructive', emphasis: 'subtle' });
  });

  it('puts stuck writes and Retry above everything, as the root does, so Retry sits beside Sign out', () => {
    // The sign-out dialog tells a climber with stuck writes to cancel and hit
    // Retry sync first; Sign out lives here, so Retry has to be here too.
    const onRetry = vi.fn();
    const model = buildAccountModel(makeInput({ syncIssues: { count: 2, onRetry } }));
    expect(model.sections.map((section) => [section.key, section.rows.map((row) => row.key)])).toEqual([
      ['syncIssues', ['retrySync']],
      ['profile', ['editProfile']],
      ['yourData', ['exportData']],
      ['accountActions', ['signOut', 'deleteAccount']],
    ]);
    const [syncIssues] = model.sections;
    expect(syncIssues.title).toBe('mobile.settings.syncIssues.title');
    expect(syncIssues.footer).toBe('mobile.settings.syncIssues.description:{"count":2}');
    const retry = button(makeInput({ syncIssues: { count: 2, onRetry } }), 'retrySync');
    expect(retry.label).toBe('mobile.settings.syncIssues.retry');
    retry.onPress();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows the same alert the root shows, built by the same function', () => {
    const syncIssues = { count: 4, onRetry: vi.fn() };
    const rootSection = buildSettingsRootModel({
      t: echo,
      syncIssues,
      visible: { account: true, earlyAccess: false, developer: false },
      values: {},
      onOpen: vi.fn(),
    }).sections[0];
    expect(buildAccountModel(makeInput({ syncIssues })).sections[0]).toEqual(rootSection);
  });

  it('wires each row to its own action', () => {
    const input = makeInput();
    button(input, 'signOut').onPress();
    button(input, 'deleteAccount').onPress();
    const [profile, yourData] = buildAccountModel(input).sections;
    const editProfile = profile.rows[0];
    const exportData = yourData.rows[0];
    if (editProfile.kind !== 'nav' || exportData.kind !== 'nav') throw new Error('expected nav rows');
    editProfile.onPress();
    exportData.onPress();
    expect(input.onExportData).toHaveBeenCalledOnce();
    expect(input.onSignOut).toHaveBeenCalledOnce();
    expect(input.onDeleteAccount).toHaveBeenCalledOnce();
    expect(input.onEditProfile).toHaveBeenCalledOnce();
  });
});
