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

vi.mock('../../../providers/queue-provider', () => ({
  useQueue: () => ({ state: { currentClimbQueueItem: cfg.currentClimbQueueItem }, sessionId: cfg.sessionId }),
}));
// Stub the row so the test sees exactly what QueueBottomAccessory hands down, and
// so the row stub is the only node under the accessory (no extra wrapper).
vi.mock('../NativeAccessoryClimbRow', () => ({
  NativeAccessoryClimbRow: ({
    climb,
    placement,
    testID,
  }: {
    climb: Climb;
    placement: 'regular' | 'inline';
    testID?: string;
  }) =>
    createElement('div', {
      'data-native-row': 'true',
      'data-climb-name': climb.name,
      'data-placement': placement,
      'data-testid': testID,
    }),
}));
import { QueueBottomAccessory } from '../QueueBottomAccessory';
import { invalidateCredentialSnapshots } from '../../../lib/privacy/privacy-cache';

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
