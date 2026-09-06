import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED_EVENTS } from '@boardsesh/analytics';

const analyticsMocks = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock('../../lib/analytics', () => ({ track: analyticsMocks.track }));

import { recordOfflineRead, recordOfflineReadUnavailable, resetOfflineUsageSignal } from '../offline-usage-signal';

// The binding between the shared rollup gate and PostHog (#4317). The gate is
// tested in @boardsesh/offline-sync; what matters here is that an emission maps
// to the right SHARED_EVENTS name with the right props, since a renamed prop
// silently breaks the north-star insight rather than failing anything.
describe('mobile offline-usage signal binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOfflineUsageSignal();
  });

  it('maps a served read to Offline Read Served with its lane, surface, board and rung', () => {
    recordOfflineRead({ lane: 'offline_local', surface: 'search', boardName: 'kilter' });

    expect(analyticsMocks.track).toHaveBeenCalledExactlyOnceWith(SHARED_EVENTS.OfflineReadServed, {
      lane: 'offline_local',
      surface: 'search',
      boardName: 'kilter',
      readCount: 1,
    });
  });

  it('maps an unavailable read to Offline Read Unavailable with its reason', () => {
    recordOfflineReadUnavailable({ reason: 'filter_unsupported', surface: 'search', boardName: 'tension' });

    expect(analyticsMocks.track).toHaveBeenCalledExactlyOnceWith(SHARED_EVENTS.OfflineReadUnavailable, {
      reason: 'filter_unsupported',
      surface: 'search',
      boardName: 'tension',
      readCount: 1,
      // Not passed by this caller → null, so the property is always present and
      // a PostHog breakdown never has to treat "missing" as a fourth value.
      connectivityReason: null,
    });
  });

  it('rolls up repeat reads rather than tracking one event per read', () => {
    for (let read = 0; read < 9; read += 1) {
      recordOfflineRead({ lane: 'offline_local', surface: 'search', boardName: 'kilter' });
    }

    expect(analyticsMocks.track).toHaveBeenCalledOnce();
  });

  it('re-arms the rollup after a sign-out reset', () => {
    recordOfflineRead({ lane: 'offline_local', surface: 'search', boardName: 'kilter' });
    recordOfflineRead({ lane: 'offline_local', surface: 'search', boardName: 'kilter' });
    resetOfflineUsageSignal();
    recordOfflineRead({ lane: 'offline_local', surface: 'search', boardName: 'kilter' });

    expect(analyticsMocks.track).toHaveBeenCalledTimes(2);
  });
});
