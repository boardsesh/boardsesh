import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import type { ClimbActionsTarget } from '../../../providers/drawer-host-provider';
vi.mock('../../../lib/privacy/privacy-cache', () => ({ getCredentialGeneration: () => 0 }));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
import {
  getClimbActionPresenters,
  openPresentedClimbAction,
  registerClimbActionPresenters,
} from '../climb-action-presenters';

const target: ClimbActionsTarget = {
  climb: { uuid: 'shown', name: 'Shown climb' } as Climb,
  boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 },
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});
function presenters() {
  const hosts = { tick: vi.fn(), beta: vi.fn(), report: vi.fn(), playlist: vi.fn() };
  cleanups.push(registerClimbActionPresenters(hosts));
  return hosts;
}

describe('player-owned climb action sheets', () => {
  it.each(['tick', 'beta', 'report', 'playlist'] as const)(
    'opens %s on the player presenter with the pinned board',
    async (action) => {
      const hosts = presenters();
      const dismissSourceSheet = vi.fn(async () => ({ status: 'dismissed' as const }));
      openPresentedClimbAction(hosts, action, { ...target, dismissSourceSheet });
      expect(hosts[action]).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(dismissSourceSheet).toHaveBeenCalledOnce();
      expect(hosts[action]).toHaveBeenCalledExactlyOnceWith(
        target.climb,
        target.boardConfig,
        ...(action === 'tick' ? [{ queueItemUuid: undefined }] : []),
      );
    },
  );

  it('does not present after an aborted source-sheet dismissal', async () => {
    const hosts = presenters();
    openPresentedClimbAction(hosts, 'tick', { ...target, dismissSourceSheet: async () => ({ status: 'aborted' }) });
    await Promise.resolve();
    expect(hosts.tick).not.toHaveBeenCalled();
  });

  it('ignores a stale player after source dismissal', async () => {
    const hosts = presenters();
    let finish!: (result: { status: 'dismissed' }) => void;
    const dismissed = new Promise<{ status: 'dismissed' }>((resolve) => {
      finish = resolve;
    });
    openPresentedClimbAction(hosts, 'playlist', { ...target, dismissSourceSheet: () => dismissed });
    cleanups[0]();
    finish({ status: 'dismissed' });
    await Promise.resolve();
    expect(hosts.playlist).not.toHaveBeenCalled();
    expect(getClimbActionPresenters()).toBeNull();
  });
});
