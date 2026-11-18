import type { LabPreset, ReduceMotionChoice } from './types';

export type SpeedChoice = 1 | 0.5 | 0.25;

export const SPEED_CHOICES: readonly SpeedChoice[] = [1, 0.5, 0.25];

/** The deep link's query string, as expo-router hands it over. */
export type RawLabParams = Record<string, string | string[] | undefined>;

export type LabLinkParams = {
  variant: string | null;
  board: string | null;
  set: string | null;
  speed: SpeedChoice | null;
  /** `'all'`, one variant id, or null for no autoplay. */
  autoplay: string | null;
  reduceMotion: ReduceMotionChoice | null;
  /** `preset=bold` starts every variant that has one on its Bold preset. */
  preset: LabPreset | null;
};

function first(raw: string | string[] | undefined): string | null {
  const text = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}

function parseSpeed(text: string | null): SpeedChoice | null {
  if (text === null) return null;
  const number = Number(text.replace(/[x×]$/i, ''));
  return SPEED_CHOICES.find((choice) => choice === number) ?? null;
}

function parseReduceMotion(text: string | null): ReduceMotionChoice | null {
  switch (text?.toLowerCase()) {
    case 'system':
      return 'system';
    case 'on':
    case 'true':
    case '1':
      return 'on';
    case 'off':
    case 'false':
    case '0':
      return 'off';
    default:
      return null;
  }
}

function parsePreset(text: string | null): LabPreset | null {
  const preset = text?.toLowerCase();
  return preset === 'bold' || preset === 'subtle' ? preset : null;
}

/** Reads the lab's deep-link params. Anything unrecognised becomes null, never an error. */
export function parseLabParams(raw: RawLabParams): LabLinkParams {
  return {
    variant: first(raw.variant),
    board: first(raw.board),
    set: first(raw.set),
    speed: parseSpeed(first(raw.speed)),
    autoplay: first(raw.autoplay),
    reduceMotion: parseReduceMotion(first(raw.reduceMotion)),
    preset: parsePreset(first(raw.preset)),
  };
}

/** Real milliseconds per clock millisecond: 1x -> 1, 0.5x -> 2, 0.25x -> 4. */
export function slowdownForSpeed(speed: SpeedChoice): number {
  return 1 / speed;
}

export function speedLabel(speed: SpeedChoice): string {
  return `${speed}×`;
}
