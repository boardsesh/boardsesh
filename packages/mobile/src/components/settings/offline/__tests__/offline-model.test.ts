import { describe, expect, it, vi } from 'vitest';
import { buildOfflineModel, type OfflineModelInput } from '../offline-model';
import type { MoreToggleRow } from '../../../MoreForm.types';

const echo = (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key);

const offlineModeRow: MoreToggleRow = {
  kind: 'toggle',
  key: 'offlineMode',
  label: 'Offline mode',
  value: false,
  onValueChange: vi.fn(),
};

function makeInput(overrides: Partial<OfflineModelInput> = {}): OfflineModelInput {
  return {
    t: echo,
    offlineEnabled: true,
    offlineModeRow,
    autoOfflineBoards: false,
    onAutoOfflineBoardsChange: vi.fn(),
    pendingCount: 0,
    effectiveOffline: false,
    showStorage: true,
    onOpenStorage: vi.fn(),
    ...overrides,
  };
}

function layout(input: OfflineModelInput): [string, string[]][] {
  return buildOfflineModel(input).sections.map((section) => [section.key, section.rows.map((row) => row.key)]);
}

describe('buildOfflineModel', () => {
  it('puts Offline mode first, then keeping boards offline, then Storage', () => {
    expect(layout(makeInput())).toEqual([
      ['offline', ['offlineMode', 'autoOfflineBoards']],
      ['storage', ['storage']],
    ]);
  });

  it('leaves Offline mode out where the switch can do nothing', () => {
    expect(layout(makeInput({ offlineModeRow: null }))[0]).toEqual(['offline', ['autoOfflineBoards']]);
  });

  it('still offers Storage with offline downloads switched off, so old downloads can be cleared', () => {
    expect(layout(makeInput({ offlineEnabled: false }))).toEqual([['storage', ['storage']]]);
  });

  it('shows the offline switches without Storage when nothing is downloaded', () => {
    expect(layout(makeInput({ showStorage: false }))).toEqual([['offline', ['offlineMode', 'autoOfflineBoards']]]);
  });

  it('is empty, not broken, when neither half applies', () => {
    expect(buildOfflineModel(makeInput({ offlineEnabled: false, showStorage: false })).sections).toEqual([]);
  });

  it('says nothing about pending writes when there are none', () => {
    expect(buildOfflineModel(makeInput()).sections[0].footer).toBeUndefined();
  });

  it('says queued writes wait for a connection while offline, and are sending once online', () => {
    expect(buildOfflineModel(makeInput({ pendingCount: 2, effectiveOffline: true })).sections[0].footer).toBe(
      'mobile.settings.offline.pendingFooter:{"count":2}',
    );
    expect(buildOfflineModel(makeInput({ pendingCount: 2, effectiveOffline: false })).sections[0].footer).toBe(
      'mobile.settings.offline.syncingFooter:{"count":2}',
    );
  });

  it('hands the keep-offline switch to its handler', () => {
    const onAutoOfflineBoardsChange = vi.fn();
    const row = buildOfflineModel(makeInput({ autoOfflineBoards: true, onAutoOfflineBoardsChange })).sections[0]
      .rows[1];
    if (row.kind !== 'toggle') throw new Error('autoOfflineBoards is not a toggle');
    expect(row.value).toBe(true);
    row.onValueChange(false);
    expect(onAutoOfflineBoardsChange).toHaveBeenCalledWith(false);
  });

  it('names the Storage row after the page it opens, with the detail in the footer', () => {
    const onOpenStorage = vi.fn();
    const storage = buildOfflineModel(makeInput({ onOpenStorage })).sections[1];
    expect(storage.footer).toBe('mobile.settings.storage.rowSubtitle');
    const row = storage.rows[0];
    if (row.kind !== 'nav') throw new Error('storage is not a nav row');
    expect(row.label).toBe('mobile.settings.storage.title');
    expect(row.subtitle).toBeUndefined();
    row.onPress();
    expect(onOpenStorage).toHaveBeenCalledOnce();
  });
});
