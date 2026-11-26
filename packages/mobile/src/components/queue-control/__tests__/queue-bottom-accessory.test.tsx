// @vitest-environment jsdom
import { renderWithQueryClient as render } from './test-query-client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import type { Climb, ClimbQueueItem } from '@boardsesh/queue';
import { onlineManager } from '@tanstack/react-query';
import { ensureMutationQueueTable, runMigrations } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import type { BoardConfig } from '../../../providers/drawer-host-provider';

const cfg = vi.hoisted(() => ({
  placement: 'regular' as 'regular' | 'inline',
  sessionId: null as string | null,
  boardConfig: null as BoardConfig | null,
  quantumFlag: undefined as boolean | undefined,
  database: null as TestSqliteDb | null,
  currentClimbQueueItem: { climb: { uuid: 'c1', name: 'Tea Magic', angle: 40 } } as unknown as ClimbQueueItem | null,
}));

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ boardConfig: cfg.boardConfig }),
}));

vi.mock('../../../providers/feature-flags-provider', () => ({
  useFeatureFlag: (key: string) => (key === 'quantum-board' ? cfg.quantumFlag : undefined),
}));
vi.mock('../../../db/index', () => ({ getDatabaseHandle: () => cfg.database }));

vi.mock('expo-router/native-tabs', () => ({
  NativeTabs: { BottomAccessory: { usePlacement: () => cfg.placement } },
}));

// Only the narrow contexts: the whole-queue `useQueue` would re-render the bar on
// every queue mutation, so it is deliberately absent from this mock.
vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: cfg.sessionId, undoScope: '' }),
  useQueueData: () => ({ currentClimbQueueItem: cfg.currentClimbQueueItem }),
}));
// Stub the row so the test sees exactly what QueueBottomAccessory hands down, and
// so the row stub is the only node under the accessory (no extra wrapper).
vi.mock('../NativeAccessoryClimbRow', () => ({
  NativeAccessoryClimbRow: ({
    climb,
    placement,
    host,
    testID,
    pick,
    queueItemUuid,
  }: {
    climb: Climb;
    placement: 'regular' | 'inline';
    host?: string;
    testID?: string;
    pick?: { item: { uuid: string } } | null;
    queueItemUuid?: string;
  }) =>
    createElement('div', {
      'data-native-row': 'true',
      'data-climb-name': climb.name,
      'data-mirrored': String(climb.mirrored === true),
      'data-placement': placement,
      'data-host': host ?? '',
      'data-testid': testID,
      'data-pick': pick?.item.uuid ?? '',
      'data-queue-item': queueItemUuid ?? '',
    }),
}));
import { QueueBottomAccessory } from '../QueueBottomAccessory';
import { MiniPlayerAccessoryBody } from '../MiniPlayerAccessoryBody';
import { invalidateCredentialSnapshots } from '../../../lib/privacy/privacy-cache';
import { getLastPick, resetLastPickForTests, setLastPick } from '../../../lib/last-pick-store';

describe('QueueBottomAccessory', () => {
  beforeEach(() => {
    cfg.placement = 'regular';
    cfg.sessionId = null;
    cfg.currentClimbQueueItem = { climb: { uuid: 'c1', name: 'Tea Magic', angle: 40 } } as unknown as ClimbQueueItem;
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['0', '1'])('keeps native accessory content independent of retired capture mode %s', (mode) => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', mode);
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_CPP_URL', 'http://localhost/cpp');
    const { container, rerender } = render(<QueueBottomAccessory />);
    expect(container.querySelector('[data-native-row]')?.getAttribute('data-climb-name')).toBe('Tea Magic');
    expect(container.querySelector('[data-testid]')).toBeNull();
    cfg.currentClimbQueueItem = null;
    rerender(<QueueBottomAccessory />);
    expect(container.querySelector('[data-native-row]')).not.toBeNull();
    expect(container.querySelector('[data-testid]')).toBeNull();
  });

  it('renders the native accessory row with the resolved climb in regular placement', () => {
    const { container } = render(<QueueBottomAccessory />);
    const row = container.querySelector('[data-native-row="true"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('data-climb-name')).toBe('Tea Magic');
    expect(row?.getAttribute('data-placement')).toBe('regular');
  });

  it('hands the row straight to the platter with no extra wrapper node', () => {
    // A single top-level node keeps UIKit from relayouting a redundant nested box —
    // the doubled-text snapshot fed on the old double placement-height wrapper.
    const { container } = render(<QueueBottomAccessory />);
    expect(container.childNodes).toHaveLength(1);
    expect((container.firstChild as HTMLElement).getAttribute('data-native-row')).toBe('true');
  });

  // The row fills the frame UIKit gives each placement; nothing here sizes it.
  it('passes the inline placement through', () => {
    cfg.placement = 'inline';
    const { container } = render(<QueueBottomAccessory />);

    expect(container.querySelector('[data-native-row]')?.getAttribute('data-placement')).toBe('inline');
  });

  it('marks the row as the native accessory host', () => {
    const { container } = render(<QueueBottomAccessory />);
    expect(container.querySelector('[data-native-row]')?.getAttribute('data-host')).toBe('nativeAccessory');
  });

  // The Material card injects its placement instead of asking UIKit, so it never
  // reads NativeTabs and stays regular whatever the native hook would say.
  it('takes an injected placement and host for the Material card', () => {
    cfg.placement = 'inline';
    const { container } = render(<MiniPlayerAccessoryBody placement="regular" host="materialCard" />);
    const row = container.querySelector('[data-native-row]');
    expect(row?.getAttribute('data-placement')).toBe('regular');
    expect(row?.getAttribute('data-host')).toBe('materialCard');
    expect(row?.getAttribute('data-climb-name')).toBe('Tea Magic');
    expect(container.childNodes).toHaveLength(1);
  });

  it('retains the climb on the Material card across a rehydrate blip', () => {
    const { container, rerender } = render(<MiniPlayerAccessoryBody placement="regular" host="materialCard" />);
    cfg.currentClimbQueueItem = null;
    rerender(<MiniPlayerAccessoryBody placement="regular" host="materialCard" />);
    expect(container.querySelector('[data-native-row]')?.getAttribute('data-climb-name')).toBe('Tea Magic');
  });

  it('renders nothing without a current climb', () => {
    cfg.currentClimbQueueItem = null;
    const { container } = render(<QueueBottomAccessory />);
    expect(container.querySelector('[data-native-row]')).toBeNull();
    expect(container.childNodes).toHaveLength(0);
  });

  it('retains the displayed climb across a presence blip while mounted', () => {
    // While the host stays mounted (sticky presence boolean), a blip resolves the
    // raw selector to null for a frame — board reconnect / queue rehydrate. The row
    // must keep showing the last climb, not blank: an empty→content flip inside the
    // live platter is exactly what UIKit snapshots as doubled text.
    const { container, rerender } = render(<QueueBottomAccessory />);
    expect(container.querySelector('[data-native-row]')?.getAttribute('data-climb-name')).toBe('Tea Magic');

    cfg.currentClimbQueueItem = null;
    rerender(<QueueBottomAccessory />);

    const row = container.querySelector('[data-native-row]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('data-climb-name')).toBe('Tea Magic');
  });

  it('withdraws its retained copy even before the provider clears the old current climb', () => {
    const { container, rerender } = render(<QueueBottomAccessory />);
    act(() => invalidateCredentialSnapshots());
    expect(container.querySelector('[data-native-row]')).toBeNull();
    cfg.currentClimbQueueItem = null;
    rerender(<QueueBottomAccessory />);
    expect(container.querySelector('[data-native-row]')).toBeNull();
    cfg.currentClimbQueueItem = {
      climb: { uuid: 'fresh', name: 'Fresh climb', angle: 40 },
    } as unknown as ClimbQueueItem;
    rerender(<QueueBottomAccessory />);
    expect(container.querySelector('[data-native-row]')?.getAttribute('data-climb-name')).toBe('Fresh climb');
  });
});

// Owner decision A: the platter shows the climber's last pick, or the queue's
// current when THAT changed after it, whichever happened last.
describe('QueueBottomAccessory with a last pick', () => {
  const head = { uuid: 'queue-head', climb: { uuid: 'c1', name: 'Tea Magic', angle: 40 } } as unknown as ClimbQueueItem;
  const pickItem = {
    uuid: 'queue-pick',
    climb: { uuid: 'p1', name: 'The Eyes', angle: 40, mirrored: false },
  } as unknown as ClimbQueueItem;

  beforeEach(() => {
    cfg.placement = 'regular';
    cfg.sessionId = null;
    cfg.currentClimbQueueItem = head;
    resetLastPickForTests();
    setLastPick({
      item: pickItem,
      suggestionSource: null,
      commitOptions: undefined,
      mirrored: true,
      currentAtPick: 'queue-head',
      wallAtPick: null,
      pickedAt: 0,
    });
  });
  afterEach(() => resetLastPickForTests());

  it('shows the pick, drawn with the player’s mirror flip, and hands the row the pick', () => {
    const { container } = render(<QueueBottomAccessory />);
    const row = container.querySelector('[data-native-row]');
    expect(row?.getAttribute('data-climb-name')).toBe('The Eyes');
    expect(row?.getAttribute('data-mirrored')).toBe('true');
    expect(row?.getAttribute('data-pick')).toBe('queue-pick');
    // ✓ and ⋯ act on the climb shown.
    expect(row?.getAttribute('data-queue-item')).toBe('queue-pick');
  });

  it('shows the queue’s current once it changed after the pick, with no pick on the row', () => {
    const { container, rerender } = render(<QueueBottomAccessory />);
    cfg.currentClimbQueueItem = {
      uuid: 'queue-crewmate',
      climb: { uuid: 'c2', name: 'Crewmate pick', angle: 40 },
    } as unknown as ClimbQueueItem;
    rerender(<QueueBottomAccessory />);
    const row = container.querySelector('[data-native-row]');
    expect(row?.getAttribute('data-climb-name')).toBe('Crewmate pick');
    expect(row?.getAttribute('data-pick')).toBe('');
  });

  it('shows the pick on an empty queue', () => {
    cfg.currentClimbQueueItem = null;
    resetLastPickForTests();
    setLastPick({
      item: pickItem,
      suggestionSource: null,
      commitOptions: undefined,
      mirrored: false,
      currentAtPick: null,
      wallAtPick: null,
      pickedAt: 0,
    });
    const { container } = render(<QueueBottomAccessory />);
    expect(container.querySelector('[data-native-row]')?.getAttribute('data-climb-name')).toBe('The Eyes');
  });
});

describe('Quantum route visibility in the accessory', () => {
  const released: BoardConfig = { boardName: 'quantum', layoutId: 9104, sizeId: 9204, setIds: '1', angle: 40 };
  const belay: BoardConfig = { ...released, layoutId: 9105, sizeId: 9205 };
  const kilter: BoardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', angle: 40 };
  const quantumItem = (board = released, climbUuid = 'quantum-climb'): ClimbQueueItem => ({
    uuid: 'queue-quantum',
    climb: {
      uuid: climbUuid,
      name: 'Quantum climb',
      angle: 40,
      boardType: 'quantum',
      layoutId: board.layoutId,
      compatibleSizeIds: [board.sizeId],
      frames: '',
    } as Climb,
  });

  beforeEach(async () => {
    cfg.boardConfig = kilter;
    cfg.quantumFlag = true;
    cfg.currentClimbQueueItem = quantumItem();
    cfg.database = createTestDatabase();
    await ensureMutationQueueTable(cfg.database);
    await runMigrations(cfg.database);
  });

  afterEach(() => {
    cfg.database?.close();
    cfg.database = null;
    cfg.quantumFlag = undefined;
    cfg.boardConfig = null;
    resetLastPickForTests();
    onlineManager.setOnline(true);
  });

  it.each([false, undefined])('hides the cached Quantum climb when the flag is %s', (flag) => {
    cfg.quantumFlag = flag;
    const queued = cfg.currentClimbQueueItem;
    const { container } = render(<QueueBottomAccessory />);
    expect(container.querySelector('[data-native-row]')).toBeNull();
    expect(cfg.currentClimbQueueItem).toBe(queued);
  });

  it('hides a Belay preview and keeps the last pick', () => {
    const item = quantumItem(belay);
    setLastPick({
      item,
      boardConfig: belay,
      suggestionSource: null,
      commitOptions: undefined,
      currentAtPick: 'queue-quantum',
      mirrored: false,
      wallAtPick: null,
      pickedAt: 0,
    });
    const { container } = render(<QueueBottomAccessory />);
    expect(container.querySelector('[data-native-row]')).toBeNull();
    expect(getLastPick()?.item).toBe(item);
  });

  it.each(['public', 'draft', 'unknown'])('shows an available %s route while offline', async (kind) => {
    const uuid = 'quantum-climb';
    if (kind !== 'unknown') {
      const draft = kind === 'draft';
      await cfg.database?.runAsync(
        `INSERT INTO board_climbs
         (uuid, board_type, layout_id, name, is_listed, is_draft, is_hidden, is_boardsesh_authored, user_id, frames_count, frames)
         VALUES (?, 'quantum', 9104, 'Quantum climb', ?, ?, ?, ?, ?, 0, '')`,
        [uuid, draft ? 0 : 1, draft ? 1 : 0, draft ? 1 : 0, draft ? 1 : 0, draft ? 'setter' : null],
      );
    }
    cfg.boardConfig = null;
    onlineManager.setOnline(false);
    const { container } = render(<MiniPlayerAccessoryBody placement="regular" host="materialCard" />);
    await waitFor(() =>
      expect(container.querySelector('[data-native-row]')?.getAttribute('data-climb-name')).toBe('Quantum climb'),
    );
  });

  it('withdraws a retained row when the catalogue sync retires its route', async () => {
    cfg.boardConfig = released;
    const { container, queryClient, rerender } = render(<QueueBottomAccessory />);
    await waitFor(() => expect(container.querySelector('[data-native-row]')).not.toBeNull());
    cfg.currentClimbQueueItem = null;
    cfg.boardConfig = null;
    rerender(<QueueBottomAccessory />);
    expect(container.querySelector('[data-native-row]')).not.toBeNull();

    await cfg.database?.runAsync(
      `INSERT INTO board_climbs
       (uuid, board_type, layout_id, name, is_listed, is_draft, is_hidden, is_boardsesh_authored, frames_count)
       VALUES ('quantum-climb', 'quantum', 9104, 'Withdrawn', 0, 0, 1, 0, 0)`,
    );
    await act(() => queryClient.invalidateQueries({ queryKey: ['climb'] }));
    await waitFor(() => expect(container.querySelector('[data-native-row]')).toBeNull());
    expect(await cfg.database?.getFirstAsync("SELECT uuid FROM board_climbs WHERE uuid = 'quantum-climb'")).toEqual({
      uuid: 'quantum-climb',
    });
  });

  it('withdraws the retained row when the flag turns off during a board rehydrate', async () => {
    cfg.boardConfig = released;
    const { container, rerender } = render(<QueueBottomAccessory />);
    await waitFor(() => expect(container.querySelector('[data-native-row]')).not.toBeNull());
    cfg.currentClimbQueueItem = null;
    cfg.boardConfig = null;
    rerender(<QueueBottomAccessory />);
    expect(container.querySelector('[data-native-row]')).not.toBeNull();
    cfg.quantumFlag = false;
    rerender(<QueueBottomAccessory />);
    expect(container.querySelector('[data-native-row]')).toBeNull();
  });
});
