import { beforeEach, describe, expect, it, vi } from 'vitest';
import { transitionWorkOffline, type WorkOfflineTransitionDeps } from '../work-offline-transition';

const fixtures = {
  readOutboxSummary: vi.fn(),
  confirmGoingOnline: vi.fn(),
  persist: vi.fn(),
  applyNetworkPolicy: vi.fn(),
  syncNow: vi.fn(),
  onSummaryError: vi.fn(),
};

function dependencies(): WorkOfflineTransitionDeps {
  return fixtures;
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.readOutboxSummary.mockResolvedValue({ pendingCount: 3, deadLetterCount: 1 });
  fixtures.confirmGoingOnline.mockResolvedValue(true);
});

describe('transitionWorkOffline', () => {
  it('blocks networking immediately when offline mode is enabled', async () => {
    await expect(transitionWorkOffline(true, dependencies())).resolves.toBe(true);

    expect(fixtures.persist).toHaveBeenCalledWith(true);
    expect(fixtures.applyNetworkPolicy).toHaveBeenCalledWith(true);
    expect(fixtures.readOutboxSummary).not.toHaveBeenCalled();
    expect(fixtures.syncNow).not.toHaveBeenCalled();
    expect(fixtures.applyNetworkPolicy.mock.invocationCallOrder[0]).toBeLessThan(
      fixtures.persist.mock.invocationCallOrder[0],
    );
  });

  it('keeps offline mode unchanged when going online is cancelled', async () => {
    fixtures.confirmGoingOnline.mockResolvedValue(false);

    await expect(transitionWorkOffline(false, dependencies())).resolves.toBe(false);

    expect(fixtures.confirmGoingOnline).toHaveBeenCalledWith({ pendingCount: 3, deadLetterCount: 1 });
    expect(fixtures.persist).not.toHaveBeenCalled();
    expect(fixtures.applyNetworkPolicy).not.toHaveBeenCalled();
    expect(fixtures.syncNow).not.toHaveBeenCalled();
  });

  it('goes online and starts sync after confirming pending counts', async () => {
    await expect(transitionWorkOffline(false, dependencies())).resolves.toBe(true);

    expect(fixtures.persist).toHaveBeenCalledWith(false);
    expect(fixtures.applyNetworkPolicy).toHaveBeenCalledWith(false);
    expect(fixtures.syncNow).toHaveBeenCalledOnce();
  });

  it('still asks for confirmation if the outbox summary cannot be read', async () => {
    const failure = new Error('database unavailable');
    fixtures.readOutboxSummary.mockRejectedValue(failure);

    await expect(transitionWorkOffline(false, dependencies())).resolves.toBe(true);

    expect(fixtures.onSummaryError).toHaveBeenCalledWith(failure);
    expect(fixtures.confirmGoingOnline).toHaveBeenCalledWith({ pendingCount: 0, deadLetterCount: 0 });
  });
});
