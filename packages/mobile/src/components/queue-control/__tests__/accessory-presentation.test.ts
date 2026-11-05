import { describe, expect, it, vi } from 'vitest';
import {
  createAccessoryPresentationStore,
  resolveAccessoryMenuAnchor,
  type AccessoryPresentationEvent,
} from '../accessory-presentation';

const regular: AccessoryPresentationEvent = {
  phase: 'settled',
  environment: 'regular',
  sourceId: 1,
  revision: 1,
  windowX: 73,
  windowY: 1126,
  width: 689,
  height: 64,
};

describe('native accessory presentation ownership', () => {
  it('starts hidden and shows only a settled regular native presentation', () => {
    const store = createAccessoryPresentationStore();
    expect(store.getSnapshot()).toBeNull();
    for (const [index, [phase, environment]] of [
      ['moving', 'regular'],
      ['settled', 'inline'],
      ['detached', 'regular'],
      ['future-phase', 'regular'],
      ['settled', 'unknown'],
    ].entries()) {
      store.publish({ ...regular, phase, environment, revision: index + 1 });
      expect(store.getSnapshot()).toBeNull();
    }
    store.publish({ ...regular, revision: 6 });
    expect(store.getSnapshot()?.frame).toEqual({ x: 73, y: 1126, width: 689, height: 64 });
  });

  it('withdraws immediately when moving, inline, or detached', () => {
    for (const override of [{ phase: 'moving' }, { environment: 'inline' }, { phase: 'detached' }]) {
      const store = createAccessoryPresentationStore();
      store.publish(regular);
      expect(store.getSnapshot()).not.toBeNull();
      store.publish({ ...regular, ...override, revision: regular.revision + 1 });
      expect(store.getSnapshot()).toBeNull();
    }
  });

  it('ignores reordered native events and previous native instances', () => {
    const store = createAccessoryPresentationStore();
    store.publish({ ...regular, sourceId: 4, revision: 5 });
    store.publish({ ...regular, sourceId: 4, revision: 6, phase: 'moving' });
    store.publish({ ...regular, sourceId: 4, revision: 5 });
    expect(store.getSnapshot()).toBeNull();
    store.publish({ ...regular, sourceId: 5, revision: 1 });
    const current = store.getSnapshot();
    store.publish({ ...regular, sourceId: 4, revision: 100 });
    expect(store.getSnapshot()).toBe(current);
  });

  it('keeps a replaced host independent from late callbacks to its old store', () => {
    const oldHost = createAccessoryPresentationStore();
    const nextHost = createAccessoryPresentationStore();
    nextHost.publish({ ...regular, sourceId: 2 });
    const current = nextHost.getSnapshot();
    oldHost.publish(regular);
    expect(nextHost.getSnapshot()).toBe(current);
  });

  it('rejects invalid native geometry and avoids notifying already-hidden consumers', () => {
    const store = createAccessoryPresentationStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.publish({ ...regular, phase: 'moving' });
    store.publish({ ...regular, revision: regular.revision + 1, width: 0 });
    store.publish({ ...regular, revision: regular.revision + 2, windowX: Number.NaN });
    expect(store.getSnapshot()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    store.publish({ ...regular, revision: regular.revision + 3 });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    store.publish({ ...regular, revision: regular.revision + 4, phase: 'detached' });
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('root-hosted menu geometry', () => {
  const source = { x: 576, y: 1136, width: 44, height: 44 };
  const accessory = { x: 73, y: 1126, width: 689, height: 64 };

  it('subtracts the measured Paper host origin', () => {
    expect(resolveAccessoryMenuAnchor(source, { x: 20, y: 64, width: 814, height: 1146 }, accessory)).toEqual({
      x: 556,
      y: 1072,
      width: 44,
      height: 44,
    });
  });

  it('refuses a stale slot outside the current native platter or portal root', () => {
    expect(
      resolveAccessoryMenuAnchor(source, { x: 0, y: 0, width: 834, height: 1210 }, { ...accessory, y: 800 }),
    ).toBeNull();
    expect(resolveAccessoryMenuAnchor(source, { x: 0, y: 0, width: 500, height: 1210 }, accessory)).toBeNull();
  });
});
