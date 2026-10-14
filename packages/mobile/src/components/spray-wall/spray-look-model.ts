import type { ReactNode } from 'react';
import type { MoreFormModel, MoreOption, MoreSection } from '../MoreForm.types';
import type { SprayWallBackground } from '../../lib/spray/spray-wall-background';
import { backgroundPickerNote, canPickBackground, type SprayBackgroundGate } from './spray-background-gate';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const BACKGROUNDS: readonly SprayWallBackground[] = ['photo', 'wall-crop', 'hold-cutouts'];

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
  onChange: (background: SprayWallBackground) => void;
  /** The look save is in flight: nothing may move under it. */
  saving: boolean;
  /** The draft's photo cannot be drawn here. */
  unavailable: boolean;
};

/**
 * The background phase of the look step: the draft drawn on one background,
 * and a three-way control under it (Photo, Wall only, Holds only), with the
 * gate's sentence in the footer.
 *
 * The control only appears where a backend can store the choice: while the
 * answer is out it is greyed, and for a photo the gate refuses, or a backend
 * that predates generated looks, only the photo is offered, so there is no
 * control at all and the footer says why. A refused key is dropped on select as
 * well, because a SwiftUI segmented control cannot grey one segment out.
 */
export function buildSprayBackgroundModel(input: SprayBackgroundModelInput): MoreFormModel {
  const { t, gate } = input;
  const selected = canPickBackground(gate, input.value) ? input.value : 'photo';
  const sections: MoreSection[] = [];

  sections.push({
    key: 'preview',
    footer: input.unavailable ? t('sprayWizard.look.unavailable') : undefined,
    rows: [
      {
        kind: 'custom',
        key: 'backgroundPreview',
        content: input.preview,
        height: input.previewHeight,
        fullBleed: true,
      },
    ],
  });

  if (gate.kind === 'loading' || gate.kind === 'open') {
    const notes: string[] = [];
    if (gate.kind === 'loading') {
      notes.push(t('sprayWizard.look.loading'));
    } else {
      const note = backgroundPickerNote(gate, selected, true);
      if (note) notes.push(t(`sprayBackground.note.${note}`));
      // Volumes are not detected, so Holds only can drop them.
      if (selected === 'hold-cutouts') notes.push(t('sprayBackground.note.volumes'));
    }
    sections.push({
      key: 'background',
      footer: notes.join(' '),
      rows: [
        {
          kind: 'segmented',
          key: 'background',
          label: t('sprayBackground.label'),
          options: sprayBackgroundOptions(t),
          selectedKey: selected,
          disabled: gate.kind === 'loading' || input.saving,
          onSelect: (key) => {
            if (input.saving) return;
            const next = BACKGROUNDS.find((candidate) => candidate === key);
            if (next && next !== selected && canPickBackground(gate, next)) input.onChange(next);
          },
        },
      ],
    });
    return { sections };
  }

  // Photo only. Say why under the preview rather than offering one segment.
  const why =
    gate.kind === 'unsupported'
      ? t('sprayWizard.background.unsupported')
      : gate.reason === 'no-pins'
        ? t('sprayBackground.note.lockedNoPins')
        : t('sprayBackground.note.lockedRetake');
  sections[0] = { ...sections[0], footer: [sections[0].footer, why].filter(Boolean).join(' ') };
  return { sections };
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
