import { beforeEach, describe, expect, it, vi } from 'vitest';
import { admitBrowserResponse } from '../browser-response-admission.web';

const state = vi.hoisted(() => ({ generation: 0, required: true }));
vi.mock('../auth-store.web', () => ({
  captureAuthCredentialGeneration: () => state.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === state.generation,
  isRequiredBrowserDispatch: () => state.required,
}));
import { captureAuthenticatedResponse } from '../authenticated-response-scope.web';

beforeEach(() => {
  state.generation = 0;
  state.required = true;
});

describe('original authenticated response receipt capture', () => {
  it('returns only the exact actual admitted response guard', async () => {
    let live = true;
    const original = () => {
      if (!live) throw new Error('Owned original lease expired');
    };
    const response = admitBrowserResponse(Response.json({ avatarUrl: '/static/avatars/A.jpg' }), original);
    const receipt = captureAuthenticatedResponse(response);
    expect(receipt).toBe(original);
    expect(await response.json()).toEqual({ avatarUrl: '/static/avatars/A.jpg' });
    live = false;
    expect(() => receipt()).toThrow('Owned original lease expired');
  });

  it('cannot extend an earlier decoded response through a later same-owner response', async () => {
    let firstLive = true;
    const first = admitBrowserResponse(Response.json({ avatarUrl: 'A-old' }), () => {
      if (!firstLive) throw new Error('First owned lease expired');
    });
    const original = captureAuthenticatedResponse(first);
    await first.json();
    const second = admitBrowserResponse(Response.json({ avatarUrl: 'A-new' }), () => {});
    const current = captureAuthenticatedResponse(second);
    firstLive = false;
    current();
    expect(() => original()).toThrow('First owned lease expired');
  });

  it('rejects an unregistered response even when it has copied successful metadata', () => {
    const response = Object.assign(Response.json({ avatarUrl: '/static/avatars/A.jpg' }), {
      browserSelection: { userId: 'claimed-A', cursor: { version: 1 } },
    });
    expect(() => captureAuthenticatedResponse(response)).toThrow();
  });

  it('keeps admitted clones bound to the original guard and refuses reconstructed responses', async () => {
    let live = true;
    const response = admitBrowserResponse(Response.json({ avatarUrl: 'A' }), () => {
      if (!live) throw new Error('Original owned response retired');
    });
    const clone = response.clone();
    const receipt = captureAuthenticatedResponse(clone);
    const copy = Response.json(await clone.json());
    expect(() => captureAuthenticatedResponse(copy)).toThrow();
    live = false;
    expect(() => receipt()).toThrow('Original owned response retired');
  });

  it('retains legacy compatibility without surviving generation or required-mode changes', () => {
    state.required = false;
    const first = captureAuthenticatedResponse(Response.json({ legacy: true }));
    first();
    state.generation += 1;
    expect(() => first()).toThrow();
    const current = captureAuthenticatedResponse(Response.json({ legacy: true }));
    current();
    state.required = true;
    expect(() => current()).toThrow();
    expect(() => captureAuthenticatedResponse(Response.json({ legacy: true }))).toThrow();
  });
});
