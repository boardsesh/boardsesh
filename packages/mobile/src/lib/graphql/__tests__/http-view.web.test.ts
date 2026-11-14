import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import type { BrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';
import type { WebAuthIdentity } from '../../auth-store.web';
import { captureBrowserHttpView } from '../http-view.web';

const closeClients: (() => void)[] = [];
afterEach(() => closeClients.splice(0).forEach((close) => close()));
function fixture(selected = true) {
  let generation = 0;
  let anonymous = false;
  let owner: BrowserBackendLeaseOwner = {
    userId: 'owned-A',
    authSessionId: 'owned-login-A',
    generation: 1,
    cursor: { bindingId: 'a'.repeat(64), version: 2 },
  };
  const initialOwner = owner;
  let identity: WebAuthIdentity | null = {
    userId: owner.userId,
    authSessionId: owner.authSessionId,
    ...(selected ? { browserSelection: owner } : {}),
  };
  const fetch = vi.fn<(...parameters: unknown[]) => Promise<Response>>();
  const backendClient = createBrowserBackendClient({
    ready: () => true,
    endpoint: '/owned-central-lease',
    fetch,
    now: () => 0,
    schedule: () => () => {},
  });
  const accept = () =>
    backendClient.acceptSession({
      user: { id: owner.userId },
      authSessionId: owner.authSessionId,
      authGeneration: owner.generation,
      expires: '2099-01-01T00:00:00.000Z',
      browserSelection: owner,
    });
  if (selected) accept();
  closeClients.push(() => backendClient.dispose());
  const options = {
    backendClient,
    captureGeneration: () => generation,
    isGenerationCurrent: (expected: number) => expected === generation,
    captureIdentity: () => identity,
    confirmedAnonymous: () => anonymous,
  };
  return {
    backendClient,
    fetch,
    capture: () => captureBrowserHttpView(options),
    nextGeneration: () => generation++,
    setIdentity: (next: WebAuthIdentity | null) => (identity = next),
    setAnonymous: (next: boolean) => (anonymous = next),
    syncIdentity: () =>
      (identity = { userId: owner.userId, authSessionId: owner.authSessionId, browserSelection: owner }),
    accept,
    restoreOriginalOwner() {
      owner = initialOwner;
      accept();
    },
    change(part: 'UID' | 'SID' | 'generation' | 'binding' | 'version') {
      owner = {
        ...owner,
        ...(part === 'UID' ? { userId: 'owned-B' } : {}),
        ...(part === 'SID' ? { authSessionId: 'owned-login-B' } : {}),
        ...(part === 'generation' ? { generation: owner.generation + 1 } : {}),
        cursor: {
          ...owner.cursor,
          ...(part === 'binding' ? { bindingId: 'b'.repeat(64) } : {}),
          ...(part === 'version' ? { version: owner.cursor.version + 1 } : {}),
        },
      };
      accept();
    },
  };
}
describe('actual central manager and Expo host identity HTTP view', () => {
  it('captures a selected view without issuing or exposing a backend token', () => {
    const current = fixture();
    const view = current.capture();
    expect(view.kind).toBe('selected');
    expect(view.isCurrent()).toBe(true);
    expect(current.fetch).not.toHaveBeenCalled();
    expect(view.key).not.toContain('bsbd1_');
  });
  it.each(['UID', 'SID', 'generation', 'binding', 'version'] as const)(
    'a changed actual %s refuses the old view before issuing a credential',
    (part) => {
      const current = fixture();
      const original = current.capture();
      current.change(part);
      expect(original.isCurrent()).toBe(false);
      expect(() => current.capture()).toThrow();
      current.syncIdentity();
      expect(current.capture().isCurrent()).toBe(true);
      expect(current.fetch).not.toHaveBeenCalled();
    },
  );
  it('the manager cannot adopt B before the actual host identity changes to B', () => {
    const current = fixture();
    current.change('UID');
    expect(() => current.capture()).toThrow();
    current.syncIdentity();
    expect(current.capture().kind).toBe('selected');
  });
  it('local generation drift retires the view even while the central tuple stays identical', () => {
    const current = fixture();
    const original = current.capture();
    current.nextGeneration();
    expect(original.isCurrent()).toBe(false);
    expect(current.capture().key).not.toBe(original.key);
  });
  it('the same original tuple after A-to-B-to-A cannot restore the original manager revision', () => {
    const current = fixture();
    const original = current.capture();
    current.change('UID');
    current.syncIdentity();
    current.restoreOriginalOwner();
    current.syncIdentity();
    expect(original.isCurrent()).toBe(false);
    expect(current.capture().key).not.toBe(original.key);
  });
  it('selected uncertainty cannot become a legacy or anonymous view from an offline identity', () => {
    const current = fixture();
    current.backendClient.retire();
    expect(() => current.capture()).toThrow();
    current.setIdentity(null);
    expect(() => current.capture()).toThrow();
  });
  it('only actual anonymous admission plus the host confirmation allows a selected public view', () => {
    const current = fixture();
    current.backendClient.acceptSession({});
    expect(() => current.capture()).toThrow();
    current.setAnonymous(true);
    expect(() => current.capture()).toThrow();
    current.setIdentity(null);
    const anonymous = current.capture();
    expect(anonymous.kind).toBe('anonymous');
    current.backendClient.retire();
    expect(anonymous.isCurrent()).toBe(false);
  });
  it('the original legacy view refuses its first selected transition without changing native behavior', () => {
    const current = fixture(false);
    const original = current.capture();
    expect(original.kind).toBe('legacy');
    current.accept();
    expect(original.isCurrent()).toBe(false);
    expect(() => current.capture()).toThrow();
  });
  it('unknown startup and confirmed anonymity stay separate in the legacy branch', () => {
    const current = fixture(false);
    current.setIdentity(null);
    expect(() => current.capture()).toThrow();
    current.setAnonymous(true);
    expect(current.capture().kind).toBe('anonymous');
  });
});
