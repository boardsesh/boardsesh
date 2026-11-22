// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => ({ mouseAvailable: false }));
vi.mock('../browser-input-capabilities', () => ({ getBrowserMouseAvailable: () => capabilities.mouseAvailable }));
let cleanup: (() => void)[] = [];

beforeEach(() => {
  vi.resetModules();
  capabilities.mouseAvailable = false;
});
afterEach(() => {
  cleanup.forEach((release) => release());
  cleanup = [];
});
function pointer(pointerType: string) {
  const event = new Event('pointerdown', { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  window.dispatchEvent(event);
}

describe('opening input', () => {
  it('uses available input only until an intentional action supplies an opening source', async () => {
    const tracker = await import('../opening-input.web');
    cleanup.push(tracker.startOpeningInputTracking());
    capabilities.mouseAvailable = true;
    expect(tracker.getOpeningInput()).toBe('mouse');
    pointer('touch');
    expect(tracker.getOpeningInput()).toBe('touch');
    pointer('pen');
    expect(tracker.getOpeningInput()).toBe('pen');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(tracker.getOpeningInput()).toBe('keyboard');
    pointer('mouse');
    expect(tracker.getOpeningInput()).toBe('mouse');
  });
  it('shares listeners between providers and releases them after the last provider', async () => {
    const tracker = await import('../opening-input.web');
    const first = tracker.startOpeningInputTracking();
    const second = tracker.startOpeningInputTracking();
    cleanup.push(second);
    first();
    first();
    pointer('pen');
    expect(tracker.getOpeningInput()).toBe('pen');
    second();
    pointer('mouse');
    expect(tracker.getOpeningInput()).toBe('touch');
  });
  it('ignores modifier-only keyboard presses and unclassified pointers', async () => {
    const tracker = await import('../opening-input.web');
    cleanup.push(tracker.startOpeningInputTracking());
    pointer('touch');
    pointer('');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    expect(tracker.getOpeningInput()).toBe('touch');
  });
});
