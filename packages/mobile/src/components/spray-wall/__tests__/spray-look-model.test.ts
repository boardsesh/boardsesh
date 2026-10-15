import { describe, expect, it, vi } from 'vitest';
import {
  buildSprayBackgroundModel,
  buildSprayLookModel,
  type SprayBackgroundModelInput,
  type SprayLookModelInput,
} from '../spray-look-model';
import type { SprayBackgroundGate } from '../spray-background-gate';
import type { MoreRow } from '../../MoreForm.types';

const echo = (key: string) => key;
const OPEN: SprayBackgroundGate = { kind: 'open', soft: false, status: 'none' };

function backgroundInput(overrides: Partial<SprayBackgroundModelInput> = {}): SprayBackgroundModelInput {
  return {
    t: echo,
    preview: 'preview',
    previewHeight: 360,
    gate: OPEN,
    value: 'wall-crop',
    unavailable: false,
    ...overrides,
  };
}

function rowOf(rows: MoreRow[], key: string): MoreRow | undefined {
  return rows.find((row) => row.key === key);
}

describe('buildSprayBackgroundModel', () => {
  it('hosts swipeable previews in one full-bleed row without a separate selector', () => {
    const model = buildSprayBackgroundModel(backgroundInput());
    expect(model.sections.map((section) => section.key)).toEqual(['preview']);
    expect(model.sections[0].rows).toEqual([
      {
        kind: 'custom',
        key: 'backgroundPreview',
        content: 'preview',
        height: 360,
        fullBleed: true,
      },
    ]);
    expect(model.sections[0].footer).toBe('sprayBackground.note.preview');
  });

  it('adds the volumes warning under Holds only', () => {
    const model = buildSprayBackgroundModel(backgroundInput({ value: 'hold-cutouts' }));
    expect(model.sections[0].footer).toBe('sprayBackground.note.preview sprayBackground.note.volumes');
  });

  it('explains why only the photo is offered while the server has not answered', () => {
    const model = buildSprayBackgroundModel(backgroundInput({ gate: { kind: 'loading' } }));
    expect(model.sections[0].footer).toBe('sprayWizard.look.loading');
  });

  it.each([
    [{ kind: 'unsupported' } as const, 'sprayWizard.background.unsupported'],
    [{ kind: 'locked', reason: 'no-pins' } as const, 'sprayBackground.note.lockedNoPins'],
    [{ kind: 'locked', reason: 'retake' } as const, 'sprayBackground.note.lockedRetake'],
  ])('explains a photo-only gate (%o)', (gate, why) => {
    const model = buildSprayBackgroundModel(backgroundInput({ gate }));
    expect(model.sections[0].footer).toBe(why);
  });

  it('says when the photo cannot be drawn here', () => {
    const model = buildSprayBackgroundModel(backgroundInput({ unavailable: true, gate: { kind: 'unsupported' } }));
    expect(model.sections[0].footer).toBe('sprayWizard.look.unavailable sprayWizard.background.unsupported');
  });
});

function lookInput(overrides: Partial<SprayLookModelInput> = {}): SprayLookModelInput {
  return {
    t: echo,
    carousel: 'carousel',
    carouselHeight: 420,
    notes: [],
    saveError: null,
    confirmWithoutLabel: 'Keep going anyway',
    onConfirmWithout: vi.fn(),
    saving: false,
    dim: {
      value: 0.4,
      min: 0,
      max: 0.9,
      step: 0.05,
      format: (value) => `${Math.round(value * 100)}%`,
      onValueChange: vi.fn(),
      onCommit: vi.fn(),
    },
    ...overrides,
  };
}

describe('buildSprayLookModel', () => {
  it('hosts the rail as one pinned full-bleed row, with the dim slider under it', () => {
    const model = buildSprayLookModel(lookInput());
    expect(model.sections.map((section) => section.key)).toEqual(['looks', 'dim']);
    expect(model.sections[0].rows[0]).toEqual({
      kind: 'custom',
      key: 'lookCarousel',
      content: 'carousel',
      height: 420,
      fullBleed: true,
    });
    const dim = model.sections[1].rows[0];
    if (dim.kind !== 'slider') throw new Error('not a slider');
    expect({ label: dim.label, value: dim.value, min: dim.min, max: dim.max, step: dim.step }).toEqual({
      label: 'sprayWizard.look.dimTitle',
      value: 0.4,
      min: 0,
      max: 0.9,
      step: 0.05,
    });
  });

  it('drops the slider for a look with nothing to dim', () => {
    expect(buildSprayLookModel(lookInput({ dim: null })).sections.map((section) => section.key)).toEqual(['looks']);
  });

  it('says the notes under the rail', () => {
    const model = buildSprayLookModel(lookInput({ notes: ['Previewed on your photo.', 'The old wall is archived.'] }));
    expect(model.sections[0].footer).toBe('Previewed on your photo. The old wall is archived.');
    expect(buildSprayLookModel(lookInput()).sections[0].footer).toBeUndefined();
  });

  it('leads with a failed save and its way past, greyed while a retry runs', () => {
    const onConfirmWithout = vi.fn();
    const model = buildSprayLookModel(lookInput({ saveError: "Couldn't save the look.", onConfirmWithout }));
    expect(model.sections[0].key).toBe('saveError');
    const rows = model.sections[0].rows;
    expect(rowOf(rows, 'saveError')).toMatchObject({ kind: 'info', body: "Couldn't save the look." });
    const button = rowOf(rows, 'confirmWithout');
    if (button?.kind !== 'button') throw new Error('not a button');
    expect(button).toMatchObject({ label: 'Keep going anyway', emphasis: 'subtle', disabled: false });
    button.onPress();
    expect(onConfirmWithout).toHaveBeenCalledOnce();

    const saving = buildSprayLookModel(lookInput({ saveError: 'x', saving: true })).sections[0].rows;
    expect(rowOf(saving, 'confirmWithout')).toMatchObject({ disabled: true });
  });
});
