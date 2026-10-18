import { describe, expect, it, vi } from 'vitest';
import { buildGeneralModel, type GeneralModelInput, type GeneralOfflineInput } from '../general-model';
import type { MoreRow, MoreToggleRow } from '../../../MoreForm.types';

const echo = (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key);

const offlineModeRow: MoreToggleRow = {
  kind: 'toggle',
  key: 'offlineMode',
  label: 'Offline mode',
  value: false,
  onValueChange: vi.fn(),
};

function makeOffline(overrides: Partial<GeneralOfflineInput> = {}): GeneralOfflineInput {
  return {
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

function makeInput(overrides: Partial<GeneralModelInput> = {}): GeneralModelInput {
  return {
    t: echo,
    appearance: 'system',
    onAppearanceChange: vi.fn(),
    language: 'system',
    onLanguageChange: vi.fn(),
    activeLocale: 'fr',
    onHelpTranslate: vi.fn(),
    startupScreen: 'climbs',
    onStartupScreenChange: vi.fn(),
    offline: makeOffline(),
    onReplayWalkthrough: vi.fn(),
    onReplayBoardLook: vi.fn(),
    ...overrides,
  };
}

/** The Offline part of the page: its groups, their rows, and the title over them. */
function offlineLayout(offline: GeneralOfflineInput): [string, string | undefined, string[]][] {
  return buildGeneralModel(makeInput({ offline }))
    .sections.filter((section) => section.key === 'offline' || section.key === 'storage')
    .map((section) => [section.key, section.title, section.rows.map((row) => row.key)]);
}

function offlineSection(offline: GeneralOfflineInput) {
  const section = buildGeneralModel(makeInput({ offline })).sections.find((candidate) => candidate.key === 'offline');
  if (!section) throw new Error('no offline section');
  return section;
}

function findRow(input: GeneralModelInput, key: string): MoreRow {
  const row = buildGeneralModel(input)
    .sections.flatMap((section) => section.rows)
    .find((candidate) => candidate.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
}

describe('buildGeneralModel', () => {
  it('runs appearance, language, help translate, start-up tab, offline, then the walkthroughs', () => {
    expect(buildGeneralModel(makeInput()).sections.map((section) => section.key)).toEqual([
      'appearance',
      'language',
      'languageContribute',
      'startup',
      'offline',
      'storage',
      'replay',
      'replayBoardLook',
    ]);
  });

  it('opens Help translate outside the app, explained in the footer for the language on screen', () => {
    const onHelpTranslate = vi.fn();
    const model = buildGeneralModel(makeInput({ onHelpTranslate }));
    const contribute = model.sections.find((section) => section.key === 'languageContribute');
    expect(contribute?.footer).toBe('mobile.settings.language.contributeSubtitle:{"language":"Français"}');
    const row = contribute?.rows[0];
    if (row?.kind !== 'nav') throw new Error('helpTranslate is not a nav row');
    expect(row.external).toBe(true);
    expect(row.subtitle).toBeUndefined();
    row.onPress();
    expect(onHelpTranslate).toHaveBeenCalledOnce();
  });

  it('offers System first, then every supported language in its own script', () => {
    const row = findRow(makeInput(), 'language');
    if (row.kind !== 'select') throw new Error('language is not a select');
    expect(row.options.map((option) => option.key)).toEqual(['system', 'en-US', 'es', 'fr', 'de']);
    expect(row.options.find((option) => option.key === 'es')?.label).toBe('Español');
  });

  describe('the start-up tab', () => {
    it('offers Climbs then Home under the tab names, with Climbs chosen by default', () => {
      const row = findRow(makeInput(), 'startupScreen');
      if (row.kind !== 'segmented') throw new Error('startupScreen is not a segmented row');
      expect(row.options).toEqual([
        { key: 'climbs', label: 'mobile.nav.climbs' },
        { key: 'home', label: 'mobile.nav.home' },
      ]);
      expect(row.selectedKey).toBe('climbs');
      expect(row.label).toBe('mobile.settings.startup.title');
    });

    it('shows a stored Home choice', () => {
      const row = findRow(makeInput({ startupScreen: 'home' }), 'startupScreen');
      if (row.kind !== 'segmented') throw new Error('startupScreen is not a segmented row');
      expect(row.selectedKey).toBe('home');
    });

    it('says when it applies and what still opens elsewhere', () => {
      const section = buildGeneralModel(makeInput()).sections.find((candidate) => candidate.key === 'startup');
      expect(section?.title).toBe('mobile.settings.startup.title');
      expect(section?.footer).toBe('mobile.settings.startup.footer');
    });

    it('saves known tabs only', () => {
      const onStartupScreenChange = vi.fn();
      const row = findRow(makeInput({ onStartupScreenChange }), 'startupScreen');
      if (row.kind !== 'segmented') throw new Error('startupScreen is not a segmented row');
      row.onSelect('home');
      row.onSelect('profile');
      expect(onStartupScreenChange).toHaveBeenCalledTimes(1);
      expect(onStartupScreenChange).toHaveBeenCalledWith('home');
    });
  });

  it('changes appearance and language to known options only', () => {
    const onAppearanceChange = vi.fn();
    const onLanguageChange = vi.fn();
    const input = makeInput({ onAppearanceChange, onLanguageChange });
    const appearance = findRow(input, 'appearance');
    const language = findRow(input, 'language');
    if (appearance.kind !== 'segmented' || language.kind !== 'select') throw new Error('wrong row kinds');
    appearance.onSelect('dark');
    appearance.onSelect('sepia');
    language.onSelect('de');
    language.onSelect('xx');
    expect(onAppearanceChange).toHaveBeenCalledTimes(1);
    expect(onAppearanceChange).toHaveBeenCalledWith('dark');
    expect(onLanguageChange).toHaveBeenCalledTimes(1);
    expect(onLanguageChange).toHaveBeenCalledWith('de');
  });

  it('makes both replays buttons, since they open over Settings rather than inside it', () => {
    const onReplayWalkthrough = vi.fn();
    const onReplayBoardLook = vi.fn();
    const input = makeInput({ onReplayWalkthrough, onReplayBoardLook });
    const walkthrough = findRow(input, 'replay');
    const boardLook = findRow(input, 'replay-board-look');
    if (walkthrough.kind !== 'button' || boardLook.kind !== 'button') throw new Error('replays are not buttons');
    walkthrough.onPress();
    boardLook.onPress();
    expect(onReplayWalkthrough).toHaveBeenCalledOnce();
    expect(onReplayBoardLook).toHaveBeenCalledOnce();
  });

  it('puts the board-look description under its own button, not under the walkthrough', () => {
    // The line only describes the board look picker; under both buttons it read
    // as if replaying the walkthrough also kept your colours.
    const sections = buildGeneralModel(makeInput()).sections;
    const walkthrough = sections.find((section) => section.key === 'replay');
    const boardLook = sections.find((section) => section.key === 'replayBoardLook');
    expect(walkthrough?.title).toBe('mobile.onboarding.replaySection');
    expect(walkthrough?.rows.map((row) => row.key)).toEqual(['replay']);
    expect(walkthrough?.footer).toBeUndefined();
    expect(boardLook?.rows.map((row) => row.key)).toEqual(['replay-board-look']);
    expect(boardLook?.footer).toBe('mobile.settings.boardLook.intro.replaySubtitle');
  });
});

describe('buildGeneralModel — offline', () => {
  it('puts Offline mode first, then keeping boards offline, then Storage, under one Offline title', () => {
    expect(offlineLayout(makeOffline())).toEqual([
      ['offline', 'mobile.settings.offline.title', ['offlineMode', 'autoOfflineBoards']],
      ['storage', undefined, ['storage']],
    ]);
  });

  it('leaves Offline mode out where the switch can do nothing', () => {
    expect(offlineLayout(makeOffline({ offlineModeRow: null }))[0]).toEqual([
      'offline',
      'mobile.settings.offline.title',
      ['autoOfflineBoards'],
    ]);
  });

  it('still offers Storage, titled Offline, with offline downloads switched off, so old downloads can be cleared', () => {
    expect(offlineLayout(makeOffline({ offlineEnabled: false }))).toEqual([
      ['storage', 'mobile.settings.offline.title', ['storage']],
    ]);
  });

  it('shows the offline switches without Storage when nothing is downloaded', () => {
    expect(offlineLayout(makeOffline({ showStorage: false }))).toEqual([
      ['offline', 'mobile.settings.offline.title', ['offlineMode', 'autoOfflineBoards']],
    ]);
  });

  it('drops the whole section when neither half applies', () => {
    expect(offlineLayout(makeOffline({ offlineEnabled: false, showStorage: false }))).toEqual([]);
  });

  it('says nothing about pending writes when there are none', () => {
    expect(offlineSection(makeOffline()).footer).toBeUndefined();
  });

  it('says queued writes wait for a connection while offline, and are sending once online', () => {
    expect(offlineSection(makeOffline({ pendingCount: 2, effectiveOffline: true })).footer).toBe(
      'mobile.settings.offline.pendingFooter:{"count":2}',
    );
    expect(offlineSection(makeOffline({ pendingCount: 2, effectiveOffline: false })).footer).toBe(
      'mobile.settings.offline.syncingFooter:{"count":2}',
    );
  });

  it('hands the keep-offline switch to its handler', () => {
    const onAutoOfflineBoardsChange = vi.fn();
    const row = findRow(
      makeInput({ offline: makeOffline({ autoOfflineBoards: true, onAutoOfflineBoardsChange }) }),
      'autoOfflineBoards',
    );
    if (row.kind !== 'toggle') throw new Error('autoOfflineBoards is not a toggle');
    expect(row.value).toBe(true);
    row.onValueChange(false);
    expect(onAutoOfflineBoardsChange).toHaveBeenCalledWith(false);
  });

  it('names the Storage row after the page it opens, with the detail in the footer', () => {
    const onOpenStorage = vi.fn();
    const storage = buildGeneralModel(makeInput({ offline: makeOffline({ onOpenStorage }) })).sections.find(
      (section) => section.key === 'storage',
    );
    expect(storage?.footer).toBe('mobile.settings.storage.rowSubtitle');
    const row = storage?.rows[0];
    if (row?.kind !== 'nav') throw new Error('storage is not a nav row');
    expect(row.label).toBe('mobile.settings.storage.title');
    expect(row.subtitle).toBeUndefined();
    row.onPress();
    expect(onOpenStorage).toHaveBeenCalledOnce();
  });
});
