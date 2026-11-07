// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import type { Climb, ClimbQueueItem } from '@boardsesh/queue';

const cfg = vi.hoisted(() => ({
  placement: 'regular' as 'regular' | 'inline',
  sessionId: null as string | null,
  currentClimbQueueItem: { climb: { uuid: 'c1', name: 'Tea Magic', angle: 40 } } as unknown as ClimbQueueItem | null,
}));

vi.mock('expo-router/unstable-native-tabs', () => ({
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
import { resetLastPickForTests, setLastPick } from '../../../lib/last-pick-store';

describe('QueueBottomAccessory', () => {
  beforeEach(() => {
    cfg.placement = 'regular';
    cfg.sessionId = null;
    cfg.currentClimbQueueItem = { climb: { uuid: 'c1', name: 'Tea Magic', angle: 40 } } as unknown as ClimbQueueItem;
  });
  afterEach(() => vi.unstubAllEnvs());

  it('binds the CPP marker to the actual solo head and withdraws it from retained/shared content', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_CPP_URL', 'http://localhost/cpp');
    const { container, rerender } = render(<QueueBottomAccessory />);
    expect(container.querySelector('[data-testid="cpp-accessory-climb-c1"]')).not.toBeNull();
    cfg.currentClimbQueueItem = null;
    rerender(<QueueBottomAccessory />);
    expect(container.querySelector('[data-native-row]')).not.toBeNull();
    expect(container.querySelector('[data-testid]')).toBeNull();
    cfg.currentClimbQueueItem = { climb: { uuid: 'primary-2', name: 'Actual primary' } } as unknown as ClimbQueueItem;
    rerender(<QueueBottomAccessory />);
    expect(container.querySelector('[data-testid="cpp-accessory-climb-primary-2"]')).not.toBeNull();
    cfg.sessionId = 'genuine-shared-session';
    rerender(<QueueBottomAccessory />);
    expect(container.querySelector('[data-testid]')).toBeNull();
  });

  it.each([
    ['0', 'http://localhost/cpp'],
    ['1', ''],
  ])('adds no CPP marker outside its capture scope', (mode, url) => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', mode);
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_CPP_URL', url);
    const { container } = render(<QueueBottomAccessory />);
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
