import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSprayEditorStore } from '../spray-editor-store';
import { strokeSessionIsCurrent, type DrawStrokeSession } from '../draw-stroke-session';
const queue = vi.hoisted(() => ({ ui: [] as Array<() => void>, js: [] as Array<() => void> }));
vi.mock('react-native-reanimated', () => ({
  runOnUI:
    <Arguments extends unknown[]>(callback: (...args: Arguments) => void) =>
    (...args: Arguments) => {
      queue.ui.push(() => callback(...args));
    },
  runOnJS:
    <Arguments extends unknown[]>(callback: (...args: Arguments) => void) =>
    (...args: Arguments) => {
      queue.js.push(() => callback(...args));
    },
}));
import { waitForDrawCallbacks } from '../draw-input-admission';
function drain(tasks: Array<() => void>) {
  while (tasks.length > 0) tasks.shift()?.();
}
beforeEach(() => {
  queue.ui = [];
  queue.js = [];
});
it('takes the publication snapshot after pre-press completions, and rejects a later active lift', async () => {
  const store = createSprayEditorStore();
  let epoch = 1;
  const session: DrawStrokeSession = {
    id: 1,
    epoch,
    generation: 0,
    enabled: true,
    tool: 'add',
    targetId: null,
    zoom: 4,
    isStylus: true,
    brushPt: 2,
    brushMode: 'add',
  };
  const complete = () => {
    if (strokeSessionIsCurrent(session, epoch, 'add', store.generation))
      store.dispatch({ type: 'ADD_HOLD', geometry: { cx: 1, cy: 2, r: 3, outline: null } });
  };
  queue.ui.push(() => queue.js.push(complete));
  const barrier = waitForDrawCallbacks();
  let published = false;
  const publication = barrier.then(() => {
    epoch += 1;
    published = true;
    return store.current;
  });
  drain(queue.ui);
  expect(published).toBe(false);
  drain(queue.js);
  const snapshot = await publication;
  expect(Object.keys(snapshot.holds)).toHaveLength(1);
  complete();
  expect(Object.keys(store.current.holds)).toHaveLength(1);
  expect(store.current).toBe(snapshot);
});
describe('repeated admission', () => {
  it('creates an independent barrier after a cancelled or failed publication', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const barrier = waitForDrawCallbacks();
      drain(queue.ui);
      drain(queue.js);
      await expect(barrier).resolves.toBeUndefined();
    }
  });
});
