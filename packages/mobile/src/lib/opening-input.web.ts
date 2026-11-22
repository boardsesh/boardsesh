import { getBrowserMouseAvailable } from './browser-input-capabilities';
import type { OpeningInput } from './sheet-presentation-policy';

let lastOpeningInput: OpeningInput = 'unknown';
let trackerCount = 0;

function recordPointer(event: PointerEvent): void {
  if (event.pointerType === 'mouse' || event.pointerType === 'touch' || event.pointerType === 'pen') {
    lastOpeningInput = event.pointerType;
  }
}
function recordKeyboard(event: KeyboardEvent): void {
  if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) lastOpeningInput = 'keyboard';
}

/** Snapshot this at the opening request, before a coordinated handoff waits. */
export function getOpeningInput(): OpeningInput {
  if (lastOpeningInput !== 'unknown') return lastOpeningInput;
  return getBrowserMouseAvailable() ? 'mouse' : 'touch';
}

/** One capture listener pair, shared by the app and story providers. */
export function startOpeningInputTracking(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (trackerCount++ === 0) {
    window.addEventListener('pointerdown', recordPointer, true);
    window.addEventListener('keydown', recordKeyboard, true);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--trackerCount === 0) {
      window.removeEventListener('pointerdown', recordPointer, true);
      window.removeEventListener('keydown', recordKeyboard, true);
      lastOpeningInput = 'unknown';
    }
  };
}
