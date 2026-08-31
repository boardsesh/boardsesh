import { describe, expect, it, vi } from 'vitest';
import { buildBoardLookModel, type BoardLookModelInput } from '../board-look-model';
import type { MoreNavRow } from '../../../MoreForm.types';

function makeInput(overrides: Partial<BoardLookModelInput> = {}): BoardLookModelInput {
  return {
    carousel: 'CAROUSEL',
    carouselHeight: 240,
    matchingOptionId: 'boardsesh',
    currentLookLabel: 'Boardsesh',
    overriddenCount: 0,
    boardseshRendererAvailable: true,
    requestedMode: 'boardsesh',
    // Echo the key plus any interpolation, so a test can assert WHICH string was
    // chosen and what was substituted into it without a real catalog.
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key),
    onOpenCustomLook: vi.fn(),
    onOpenAccessibility: vi.fn(),
    onResetBoardLook: vi.fn(),
    ...overrides,
  };
}

function sectionKeys(input: BoardLookModelInput): string[] {
  return buildBoardLookModel(input).sections.map((section) => section.key);
}

function navRow(input: BoardLookModelInput, key: string): MoreNavRow {
  const row = buildBoardLookModel(input)
    .sections.flatMap((section) => section.rows)
    .find((candidate) => candidate.key === key);
  if (!row || row.kind !== 'nav') throw new Error(`no nav row ${key}`);
  return row;
}

describe('buildBoardLookModel — what the screen leads with', () => {
  it('puts the presets rail first, then the two destinations, then the reset', () => {
    expect(sectionKeys(makeInput())).toEqual(['presets', 'destinations', 'reset']);
  });

  it('drops the rail entirely when there is no board to draw', () => {
    expect(sectionKeys(makeInput({ carousel: null }))).toEqual(['destinations', 'reset']);
  });

  it('hosts the rail full-bleed at the height it was given', () => {
    const row = buildBoardLookModel(makeInput()).sections[0].rows[0];
    expect(row.kind).toBe('custom');
    if (row.kind !== 'custom') return;
    expect(row.height).toBe(240);
    expect(row.fullBleed).toBe(true);
  });
});

describe('buildBoardLookModel — the "update the app" banner', () => {
  it('appears only when they have asked for the look this build cannot draw', () => {
    expect(sectionKeys(makeInput({ boardseshRendererAvailable: false, requestedMode: 'boardsesh' }))).toContain(
      'rendererUnavailable',
    );
  });

  it('stays quiet for a climber on Classic, who is not missing anything', () => {
    expect(sectionKeys(makeInput({ boardseshRendererAvailable: false, requestedMode: 'classic' }))).not.toContain(
      'rendererUnavailable',
    );
  });

  it('stays quiet while the capability probe has not answered yet', () => {
    expect(sectionKeys(makeInput({ boardseshRendererAvailable: null }))).not.toContain('rendererUnavailable');
  });
});

describe('buildBoardLookModel — what the nav rows say is behind them', () => {
  it('names the look you are currently on', () => {
    expect(navRow(makeInput({ currentLookLabel: 'Bold' }), 'customLook').subtitle).toContain('"look":"Bold"');
  });

  it('says the tuning is yours once you are off every preset', () => {
    expect(navRow(makeInput({ matchingOptionId: 'custom' }), 'customLook').subtitle).toBe(
      'mobile.more.boardLook.customLook.rowSubtitleCustom',
    );
  });

  it('reports default markers when nothing has been customised', () => {
    expect(navRow(makeInput(), 'accessibility').subtitle).toBe(
      'mobile.more.boardLook.accessibility.rowSubtitleDefault',
    );
  });

  it('counts the customised markers when some have moved', () => {
    expect(navRow(makeInput({ overriddenCount: 3 }), 'accessibility').subtitle).toContain('"count":3');
  });
});

describe('buildBoardLookModel — the reset', () => {
  it('carries the note promising hold colours are left alone', () => {
    const reset = buildBoardLookModel(makeInput()).sections.at(-1);
    expect(reset?.footer).toBe('mobile.more.boardLook.resetAllNote');
  });

  it('fires only the board-look reset', () => {
    const onResetBoardLook = vi.fn();
    const row = buildBoardLookModel(makeInput({ onResetBoardLook }))
      .sections.flatMap((section) => section.rows)
      .find((candidate) => candidate.key === 'resetBoardLook');
    if (row?.kind !== 'button') throw new Error('no reset button');
    row.onPress();
    expect(onResetBoardLook).toHaveBeenCalledTimes(1);
  });
});
