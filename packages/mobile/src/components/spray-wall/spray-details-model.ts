import type { MoreFormModel, MoreOption, MoreSection } from '../MoreForm.types';
import type { SprayWallVisibility } from '../../lib/spray/spray-share';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type SprayDetailsModelInput = {
  t: Translate;
  /** The name as the builder holds it; may be blank while untouched. */
  name: string;
  /** What the wall is called when the name is blank: the name it was created with. */
  defaultName: string;
  onRename: () => void;
  visibility: SprayWallVisibility;
  /**
   * A segment was picked, by key. Handed straight to the control, so it must be
   * stable; `parseSprayVisibility` turns the key back into a visibility.
   */
  onVisibilitySelect: (key: string) => void;
  /** The angle the slider shows: the drag in progress, else the builder's. */
  angle: number;
  /** The offered angles, ascending and evenly spaced (`SPRAY_ANGLE_OPTIONS`). */
  angles: readonly number[];
  /**
   * Per drag frame. Local draft only. Handed straight to the slider, so it must
   * be stable, and it snaps (`snapSprayAngle`) itself.
   */
  onAngleChange: (angle: number) => void;
  /** On release: the one builder write. Stable, and snaps itself, as above. */
  onAngleCommit: (angle: number) => void;
  /** "40°". Referentially stable: the slider labels its value and both ends with it. */
  formatAngle: (angle: number) => string;
  /** The linked gym's name, or null when the wall is not at one. */
  gymName: string | null;
  onOpenGym: () => void;
  /** The last Save's failure, said at the top of the form, or null. */
  saveError: string | null;
  /** `SPRAY_CAP_VALUES.walls`, for the cap hint under the form. */
  wallCap: number;
};

/** The offered angle nearest `value`, so a slider landing between two stops reads as one. */
export function snapSprayAngle(value: number, angles: readonly number[]): number {
  let best = angles[0] ?? value;
  for (const angle of angles) {
    if (Math.abs(angle - value) < Math.abs(best - value)) best = angle;
  }
  return best;
}

/** The slider's increment: the spacing between offered angles (5° today). */
export function sprayAngleStep(angles: readonly number[]): number {
  if (angles.length < 2) return 1;
  return angles[1] - angles[0];
}

const VISIBILITY_KEYS: readonly SprayWallVisibility[] = ['private', 'unlisted', 'public'];

/** A segment key back as a visibility, or null for a key that is not one. */
export function parseSprayVisibility(key: string): SprayWallVisibility | null {
  return VISIBILITY_KEYS.find((candidate) => candidate === key) ?? null;
}

function visibilityOptions(t: Translate): (MoreOption & { key: SprayWallVisibility })[] {
  return [
    { key: 'private', label: t('mobile.sprayVisibility.private') },
    { key: 'unlisted', label: t('mobile.sprayVisibility.unlisted') },
    { key: 'public', label: t('mobile.sprayVisibility.public') },
  ];
}

/** What choosing this visibility means, said under the control (the same hints as Edit board). */
function visibilityHint(visibility: SprayWallVisibility, t: Translate): string {
  if (visibility === 'public') return t('mobile.sprayVisibility.publicHint');
  if (visibility === 'unlisted') return t('mobile.sprayVisibility.unlistedHint');
  return t('mobile.sprayVisibility.privateHint');
}

/**
 * The add-a-wall details step ("Name your wall") as plain data, in the shape of
 * the Settings pages (#6477): the name, who can see it, the angle and the gym,
 * each in its own group, with what each choice means in the group's footer.
 *
 * Everything arrives prefilled, so the common case is one tap on Save. The
 * angle is the one answer that cannot change later, and its footer says so.
 */
export function buildSprayDetailsModel(input: SprayDetailsModelInput): MoreFormModel {
  const { t } = input;
  const sections: MoreSection[] = [];

  // First, so it is the thing the climber reads when Save comes back refused.
  if (input.saveError) {
    sections.push({
      key: 'saveError',
      rows: [{ kind: 'info', key: 'saveError', label: t('sprayWizard.notSaved'), body: input.saveError }],
    });
  }

  const shownName = input.name.trim() || input.defaultName;
  sections.push({
    key: 'name',
    rows: [
      {
        kind: 'value',
        key: 'name',
        label: t('sprayWizard.details.name'),
        value: shownName,
        accessibilityHint: t('sprayWizard.details.renameHint'),
        onPress: input.onRename,
      },
    ],
  });

  const options = visibilityOptions(t);
  sections.push({
    key: 'visibility',
    title: t('mobile.sprayVisibility.label'),
    footer: visibilityHint(input.visibility, t),
    rows: [
      {
        // Three states in one control: two switches made "Public and Link only"
        // reachable, a state nobody means (#5960).
        kind: 'segmented',
        key: 'visibility',
        label: t('mobile.sprayVisibility.label'),
        options,
        selectedKey: input.visibility,
        onSelect: input.onVisibilitySelect,
      },
    ],
  });

  const { angles } = input;
  sections.push({
    key: 'angle',
    footer: t('sprayWizard.details.angleHint'),
    rows: [
      {
        kind: 'slider',
        key: 'angle',
        label: t('sprayWizard.details.angle'),
        format: input.formatAngle,
        value: input.angle,
        min: angles[0] ?? 0,
        max: angles[angles.length - 1] ?? 0,
        step: sprayAngleStep(angles),
        onValueChange: input.onAngleChange,
        onCommit: input.onAngleCommit,
      },
    ],
  });

  sections.push({
    key: 'gym',
    // Said here rather than after it bites: ten is a number a gym with a lot
    // of bays can reach.
    footer: t('sprayCaps.wallsHint', { max: input.wallCap }),
    rows: [
      {
        kind: 'nav',
        key: 'gym',
        label: t('mobile.create.gym'),
        value: input.gymName ?? t('mobile.create.gymNone'),
        onPress: input.onOpenGym,
      },
    ],
  });

  return { sections };
}
