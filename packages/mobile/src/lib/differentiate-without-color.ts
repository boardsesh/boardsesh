import { AppState } from 'react-native';
import { accessibilityUINative } from '../../modules/accessibility-ui/src/index';

/**
 * iOS "Differentiate Without Color", as one app-wide value.
 *
 * HIG (Color): never rely on colour alone, and when this setting is on, add a
 * second cue. WCAG 1.4.1 says the same. Hold roles are told apart by colour
 * alone in the default look, so two places read this: the hold-marker shape
 * default (`hold-color-overrides.ts`) and the board-look suggestion banner.
 *
 * `'unknown'` until the first read settles, and for good when there is nothing
 * to read: Android has no such setting (the closest, colour correction, is a
 * display filter apps cannot query), and a binary built before
 * `modules/accessibility-ui` existed has no module.
 *
 * The change event covers a flip made while the app is open. Leaving for
 * Settings and coming back also re-reads, because a notification posted while
 * the app was suspended is not promised to arrive.
 */
export type DifferentiateWithoutColorState = 'on' | 'off' | 'unknown';

type Listener = (state: DifferentiateWithoutColorState) => void;

let currentState: DifferentiateWithoutColorState = 'unknown';
let started = false;
// A notification or a newer foreground query supersedes any read in flight.
let signalRevision = 0;
const listeners = new Set<Listener>();

function publish(nextState: DifferentiateWithoutColorState): void {
  if (nextState === currentState) return;
  currentState = nextState;
  for (const listener of listeners) listener(nextState);
}

function read(): void {
  const native = accessibilityUINative;
  if (!native) return;
  const readRevision = ++signalRevision;
  native
    .isDifferentiateWithoutColorEnabled()
    .then((enabled) => {
      if (readRevision === signalRevision) publish(enabled ? 'on' : 'off');
    })
    // A rejected read keeps whatever was known. It never turns into 'off'.
    .catch(() => {});
}

/** Idempotent. Reads once and keeps listening for the life of the JS context. */
export function startDifferentiateWithoutColorSignal(): void {
  if (started) return;
  started = true;
  const native = accessibilityUINative;
  if (!native) return;
  native.addListener('onDifferentiateWithoutColorChange', ({ enabled }) => {
    signalRevision++;
    publish(enabled ? 'on' : 'off');
  });
  AppState.addEventListener('change', (appState) => {
    if (appState === 'active') read();
  });
  read();
}

export function getDifferentiateWithoutColor(): DifferentiateWithoutColorState {
  return currentState;
}

export function subscribeDifferentiateWithoutColor(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
