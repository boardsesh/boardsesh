// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useBoardPresenceClient, useBoardPresenceCurrent, useBoardPresenceFeed } from '@boardsesh/board-presence-react';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';

vi.hoisted(() => {
  vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
});
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock('../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => 0,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === 0,
  subscribeAuthCredentialGenerationChanges: () => () => {},
}));
vi.mock('../../lib/analytics', () => ({ track: () => {} }));
vi.mock('../../lib/graphql/ws-client', () => ({ getWsClient: () => null }));
vi.mock('../../lib/graphql/hooks/fetch-board-by-uuid', () => ({ fetchBoardByUuid: async () => null }));
vi.mock('../../lib/board-presence/board-presence-client', () => ({
  createMobileBoardPresenceClient: () => {
    throw new Error('Screenshot feed must not open a live board transport');
  },
}));
vi.mock('../../lib/connectivity/use-connectivity', () => ({
  selectOfflineMode: (snapshot: { offlineMode: boolean }) => snapshot.offlineMode,
  useConnectivityField: (select: (snapshot: { offlineMode: boolean }) => boolean) => select({ offlineMode: false }),
}));
vi.mock('../../components/board-discovery/BoardDisambiguationSheet', () => ({
  BoardDisambiguationSheet: () => null,
}));

import { MobileBoardPresenceProvider } from '../board-presence-provider';
import {
  _resetScreenshotWallSeedForTests,
  publishScreenshotWallClimbs,
} from '../../lib/board-presence/screenshot-wall-seed';

function makeWallClimb(climbUuid: string, seq: number): BoardPresenceClimb {
  return {
    climbUuid,
    name: climbUuid,
    grade: 'V4',
    angle: 40,
    frames: 'p1080r15',
    seq,
    sentAt: '2026-10-12T00:00:00.000Z',
  };
}

function WallFeedProbe() {
  const { boardUuid } = useBoardPresenceClient();
  const { currentClimb } = useBoardPresenceCurrent();
  const { history } = useBoardPresenceFeed();
  return (
    <output data-board-uuid={boardUuid ?? ''} data-current-climb={currentClimb?.climbUuid ?? ''}>
      {history.map((climb) => climb.climbUuid).join(',')}
    </output>
  );
}

describe('screenshot wall reader scope', () => {
  beforeEach(() => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    _resetScreenshotWallSeedForTests();
  });
  afterEach(() => {
    cleanup();
    _resetScreenshotWallSeedForTests();
    vi.unstubAllEnvs();
  });

  it('replaces prior-wall history when the actual published board UUID changes', async () => {
    const { container } = render(
      <MobileBoardPresenceProvider>
        <WallFeedProbe />
      </MobileBoardPresenceProvider>,
    );
    act(() => {
      publishScreenshotWallClimbs(
        [makeWallClimb('woods-head', 100), makeWallClimb('woods-history', 99)],
        null,
        'actual-owned-woods-uuid',
      );
    });
    await waitFor(() => expect(container.textContent).toBe('woods-head,woods-history'));
    act(() => {
      publishScreenshotWallClimbs(
        [makeWallClimb('kilter-head', 100), makeWallClimb('kilter-history', 99)],
        null,
        'actual-owned-kilter-uuid',
      );
    });
    await waitFor(() => expect(container.textContent).toBe('kilter-head,kilter-history'));
    expect(container.querySelector('output')?.getAttribute('data-board-uuid')).toBe('actual-owned-kilter-uuid');
    expect(container.querySelector('output')?.getAttribute('data-current-climb')).toBe('kilter-head');
    expect(container.textContent).not.toContain('woods');
  });

  it('keeps the current wall history when its publisher mounts again', async () => {
    const climbs = [makeWallClimb('kilter-head', 100), makeWallClimb('kilter-history', 99)];
    publishScreenshotWallClimbs(climbs, null, 'actual-owned-kilter-uuid');
    const { container } = render(
      <MobileBoardPresenceProvider>
        <WallFeedProbe />
      </MobileBoardPresenceProvider>,
    );
    await waitFor(() => expect(container.textContent).toBe('kilter-head,kilter-history'));
    act(() => {
      publishScreenshotWallClimbs(climbs, null, 'actual-owned-kilter-uuid');
    });
    expect(container.textContent).toBe('kilter-head,kilter-history');
    expect(container.querySelector('output')?.getAttribute('data-board-uuid')).toBe('actual-owned-kilter-uuid');
  });
});
