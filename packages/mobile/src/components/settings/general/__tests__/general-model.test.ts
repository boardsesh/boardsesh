import { describe, expect, it, vi } from 'vitest';
import { buildGeneralModel, type GeneralModelInput } from '../general-model';
import type { MoreRow } from '../../../MoreForm.types';

const echo = (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key);

function makeInput(overrides: Partial<GeneralModelInput> = {}): GeneralModelInput {
  return {
    t: echo,
    appearance: 'system',
    onAppearanceChange: vi.fn(),
    language: 'system',
    onLanguageChange: vi.fn(),
    activeLocale: 'fr',
    onHelpTranslate: vi.fn(),
    onReplayWalkthrough: vi.fn(),
    onReplayBoardLook: vi.fn(),
    ...overrides,
  };
}

function findRow(input: GeneralModelInput, key: string): MoreRow {
  const row = buildGeneralModel(input)
    .sections.flatMap((section) => section.rows)
    .find((candidate) => candidate.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
}

describe('buildGeneralModel', () => {
  it('runs appearance, language, help translate, then the walkthroughs', () => {
    expect(buildGeneralModel(makeInput()).sections.map((section) => section.key)).toEqual([
      'appearance',
      'language',
      'languageContribute',
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
