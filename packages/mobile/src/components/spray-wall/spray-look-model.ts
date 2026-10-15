import type { ReactNode } from 'react';
import type { MoreFormModel, MoreOption, MoreSection } from '../MoreForm.types';
import type { SprayWallBackground } from '../../lib/spray/spray-wall-background';
import { backgroundPickerNote, canPickBackground, type SprayBackgroundGate } from './spray-background-gate';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The three backgrounds, labelled, in the order the control shows them. */
export function sprayBackgroundOptions(t: Translate): (MoreOption & { key: SprayWallBackground })[] {
  return [
    { key: 'photo', label: t('sprayBackground.photo') },
    { key: 'wall-crop', label: t('sprayBackground.wallCrop') },
    { key: 'hold-cutouts', label: t('sprayBackground.holdCutouts') },
  ];
}

export type SprayBackgroundModelInput = {
  t: Translate;
  /** The fitted draft preview, hosted as a fixed-height row. */
  preview: ReactNode;
  previewHeight: number;
  gate: SprayBackgroundGate;
  /** The creator's pick; shown as the photo while the gate refuses it. */
  value: SprayWallBackground;
  /** The draft's photo cannot be drawn here. */
  unavailable: boolean;
};

/** The swipeable background previews and the selected option's footer. */
export function buildSprayBackgroundModel(input: SprayBackgroundModelInput): MoreFormModel {
  const { t, gate } = input;
  const selected = canPickBackground(gate, input.value) ? input.value : 'photo';
  const notes: string[] = [];
  if (input.unavailable) notes.push(t('sprayWizard.look.unavailable'));
  if (gate.kind === 'loading') {
    notes.push(t('sprayWizard.look.loading'));
  } else if (gate.kind === 'open') {
    const note = backgroundPickerNote(gate, selected, true);
    if (note) notes.push(t(`sprayBackground.note.${note}`));
    if (selected === 'hold-cutouts') notes.push(t('sprayBackground.note.volumes'));
  } else if (gate.kind === 'unsupported') {
    notes.push(t('sprayWizard.background.unsupported'));
  } else {
    notes.push(
      t(gate.reason === 'no-pins' ? 'sprayBackground.note.lockedNoPins' : 'sprayBackground.note.lockedRetake'),
    );
  }
  return {
    sections: [
      {
        key: 'preview',
        footer: notes.length > 0 ? notes.join(' ') : undefined,
        rows: [
          {
            kind: 'custom',
            key: 'backgroundPreview',
            content: input.preview,
            height: input.previewHeight,
            fullBleed: true,
          },
        ],
      },
    ],
  };
}

export type SprayLookModelInput = {
  t: Translate;
  /** The carousel of full wall previews, with its dots, hosted as one fixed-height row. */
  carousel: ReactNode;
  carouselHeight: number;
  /** Lines said under the carousel (the preview-photo note, a reset's archive notice). */
  notes: readonly string[];
  /** The last save's failure, or null. */
  saveError: string | null;
  /** "Keep going anyway" ("Publish anyway" on a reset). */
  confirmWithoutLabel: string;
  onConfirmWithout: () => void;
  saving: boolean;
  /**
   * The dim slider, or null for a look with nothing to dim (Classic). `value`
   * is the drag in progress, else the selected look's own.
   */
  dim: {
    value: number;
    min: number;
    max: number;
    step: number;
    format: (value: number) => string;
    onValueChange: (value: number) => void;
    onCommit: (value: number) => void;
  } | null;
};

/**
 * The hold-look phase of the look step, in the shape of Settings → Board
 * (`board-look-model.ts`): the swipeable rail of real previews as one
 * full-bleed row, then "Dim the rest of the wall" as a slider row.
 *
 * A failed save is said first, with the way past it, so it is what the
 * climber reads; the look itself is still theirs to change and save again.
 */
export function buildSprayLookModel(input: SprayLookModelInput): MoreFormModel {
  const { t } = input;
  const sections: MoreSection[] = [];

  if (input.saveError) {
    sections.push({
      key: 'saveError',
      rows: [
        { kind: 'info', key: 'saveError', label: t('sprayWizard.notSaved'), body: input.saveError },
        {
          kind: 'button',
          key: 'confirmWithout',
          label: input.confirmWithoutLabel,
          emphasis: 'subtle',
          disabled: input.saving,
          onPress: input.onConfirmWithout,
        },
      ],
    });
  }

  sections.push({
    key: 'looks',
    footer: input.notes.length > 0 ? input.notes.join(' ') : undefined,
    rows: [
      { kind: 'custom', key: 'lookCarousel', content: input.carousel, height: input.carouselHeight, fullBleed: true },
    ],
  });

  if (input.dim) {
    const { dim } = input;
    sections.push({
      key: 'dim',
      rows: [
        {
          kind: 'slider',
          key: 'dim',
          label: t('sprayWizard.look.dimTitle'),
          format: dim.format,
          value: dim.value,
          min: dim.min,
          max: dim.max,
          step: dim.step,
          onValueChange: dim.onValueChange,
          onCommit: dim.onCommit,
        },
      ],
    });
  }

  return { sections };
}
