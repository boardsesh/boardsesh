import { describe, expect, it, vi } from 'vitest';
import { buildCustomLookModel, type CustomLookModelInput } from '../custom-look-model';
import { DEFAULT_BOARDSESH_RENDER_SETTINGS, type BoardseshRenderSettings } from '../../../../lib/board-render-settings';
import type { MoreRow, MoreSegmentedRow, MoreSliderRow } from '../../../MoreForm.types';

function makeInput(overrides: Partial<CustomLookModelInput> = {}): CustomLookModelInput {
  const boardsesh: BoardseshRenderSettings = { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, ...overrides.boardsesh };
  return {
    boardsesh,
    mode: 'boardsesh',
    selectedMode: 'boardsesh',
    effectiveGlowFalloff: 'soft',
    boardseshRendererAvailable: true,
    t: (key: string) => key,
    setMode: vi.fn(),
    setBoardseshField: vi.fn(),
    draft: {
      glowReach: { value: boardsesh.glowReach, onValueChange: vi.fn() },
      plateauShare: { value: boardsesh.plateauShare, onValueChange: vi.fn() },
      veilOpacity: { value: boardsesh.veilOpacity, onValueChange: vi.fn() },
      fillOpacity: { value: boardsesh.fillOpacity, onValueChange: vi.fn() },
    },
    ...overrides,
    // `boardsesh` is spread above from the override, so re-pin it after the spread.
    ...(overrides.boardsesh ? { boardsesh } : {}),
  };
}

function rowKeys(input: CustomLookModelInput): string[] {
  return buildCustomLookModel(input).sections.flatMap((section) => section.rows.map((row) => row.key));
}

function findRow(input: CustomLookModelInput, key: string): MoreRow | undefined {
  return buildCustomLookModel(input)
    .sections.flatMap((section) => section.rows)
    .find((row) => row.key === key);
}

describe('buildCustomLookModel — the plateau-share slider', () => {
  // The one that has to key off the EFFECTIVE falloff, not the picker. A climber
  // on `default` whose render resolves to plateau still needs the control that
  // shapes what is actually on their wall.
  it('appears when the effective falloff is plateau even though the picker says default', () => {
    const input = makeInput({ boardsesh: { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, glowFalloff: 'default' } });
    expect(rowKeys({ ...input, effectiveGlowFalloff: 'plateau' })).toContain('plateauShare');
  });

  it('stays hidden when the render is not actually on plateau', () => {
    const input = makeInput({ boardsesh: { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, glowFalloff: 'plateau' } });
    expect(rowKeys({ ...input, effectiveGlowFalloff: 'soft' })).not.toContain('plateauShare');
  });
});

describe('buildCustomLookModel — the other conditional sliders', () => {
  it('shows veil strength only for a custom veil', () => {
    expect(rowKeys(makeInput())).not.toContain('veilOpacity');
    expect(rowKeys(makeInput({ boardsesh: { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, veil: 'custom' } }))).toContain(
      'veilOpacity',
    );
  });

  it('shows fill strength only when the mark style actually fills', () => {
    expect(rowKeys(makeInput())).not.toContain('fillOpacity');
    for (const markStyle of ['fill', 'glow-fill'] as const) {
      expect(rowKeys(makeInput({ boardsesh: { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, markStyle } }))).toContain(
        'fillOpacity',
      );
    }
  });
});

describe('buildCustomLookModel — the drag/commit split', () => {
  // The single most important property of a slider row: a drag must never reach
  // the persisted store, because it fires on every frame.
  it('routes a drag to the draft and only a release to the settings store', () => {
    const setBoardseshField = vi.fn();
    const onValueChange = vi.fn();
    const input = makeInput({ setBoardseshField });
    input.draft.glowReach = { value: 1, onValueChange };

    const row = findRow(input, 'glowReach') as MoreSliderRow;
    row.onValueChange(1.4);
    expect(onValueChange).toHaveBeenCalledWith(1.4);
    expect(setBoardseshField).not.toHaveBeenCalled();

    row.onCommit(1.4);
    expect(setBoardseshField).toHaveBeenCalledWith('glowReach', 1.4);
  });
});

describe('buildCustomLookModel — the render mode control', () => {
  it('disables the Boardsesh segment when this build cannot draw it', () => {
    const row = findRow(makeInput({ boardseshRendererAvailable: false }), 'mode') as MoreSegmentedRow;
    expect(row.disabledKeys?.has('boardsesh')).toBe(true);
    expect(row.disabledKeys?.has('classic')).toBe(false);
  });

  it('leaves both segments live once the probe says the renderer is there', () => {
    const row = findRow(makeInput({ boardseshRendererAvailable: true }), 'mode') as MoreSegmentedRow;
    expect(row.disabledKeys).toBeUndefined();
  });

  it('shows the mode the climber is actually getting before they have chosen one', () => {
    const row = findRow(makeInput({ mode: 'default', selectedMode: 'classic' }), 'mode') as MoreSegmentedRow;
    expect(row.selectedKey).toBe('classic');
  });
});
