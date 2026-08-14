// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { GroupedNotification } from '@boardsesh/shared-schema';

// How many times NotificationRow's body actually runs. The body renders exactly
// one PressableSurface, so a counter in that mock is a faithful proxy: if
// React.memo bails an identical-props re-render, this must NOT bump.
const renderCounter = vi.hoisted(() => ({ count: 0 }));

vi.mock('react-native', () => {
  const passthrough =
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children);
  return {
    Platform: { OS: 'ios' },
    PlatformColor: (name: string) => name,
    View: passthrough('div'),
    StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@boardsesh/profile-stats', () => ({
  formatTickRelativeTime: () => '2h ago',
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#666', separator: '#ccc', secondaryBackground: '#f2f2f7', fill: '#eee' },
    brandColors: { primary: '#6D28D9' },
  }),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 3: 12, 4: 16 },
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span', { 'data-icon': 'true' }) }));
vi.mock('../../Badge', () => ({ Badge: () => createElement('span', { 'data-badge': 'true' }) }));
vi.mock('../../Avatar', () => ({ Avatar: () => createElement('div', { 'data-avatar': 'true' }) }));
vi.mock('../../you/AvatarGroup', () => ({
  AvatarGroup: () => createElement('div', { 'data-avatar-group': 'true' }),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) => {
    renderCounter.count += 1;
    return createElement('div', { 'data-row': 'true' }, children);
  },
}));

import { NotificationRow } from '../NotificationRow';

function makeNotification(overrides: Partial<GroupedNotification> = {}): GroupedNotification {
  return {
    uuid: 'n1',
    type: 'new_follower',
    entityType: null,
    entityId: null,
    actorCount: 1,
    actors: [{ id: 'u1', displayName: 'Alex', avatarUrl: null }],
    commentBody: null,
    climbName: null,
    climbUuid: null,
    boardType: null,
    proposalUuid: null,
    setterUsername: null,
    gymName: null,
    isRead: false,
    createdAt: '2026-08-14T10:00:00.000Z',
    ...overrides,
  } as GroupedNotification;
}

// The screen passes one useCallback-stable handler and nothing else.
const onPress = vi.fn();

describe('NotificationRow React.memo', () => {
  beforeEach(() => {
    renderCounter.count = 0;
    vi.clearAllMocks();
  });

  it('skips re-render when the same element is re-rendered', () => {
    const element = <NotificationRow notification={makeNotification()} onPress={onPress} />;

    const { rerender } = render(element);
    expect(renderCounter.count).toBe(1);

    rerender(element);
    expect(renderCounter.count).toBe(1);
  });

  it('bails on a fresh element carrying the same notification and handler', () => {
    // This is what a page append looks like from a row's point of view: a brand
    // new element, but React Query preserved the group object and the screen's
    // renderItem dep list did not change, so onPress is the same reference.
    const notification = makeNotification();

    const { rerender } = render(<NotificationRow notification={notification} onPress={onPress} />);
    expect(renderCounter.count).toBe(1);

    rerender(<NotificationRow notification={notification} onPress={onPress} />);
    expect(renderCounter.count).toBe(1);
  });

  it('re-renders when the group flips to read', () => {
    const notification = makeNotification();

    const { rerender } = render(<NotificationRow notification={notification} onPress={onPress} />);
    expect(renderCounter.count).toBe(1);

    // The mark-read cache write mints a new object for the touched group only.
    rerender(<NotificationRow notification={{ ...notification, isRead: true }} onPress={onPress} />);
    expect(renderCounter.count).toBe(2);
  });

  it('re-renders when the handler identity churns', () => {
    // Guards the regression this suite exists for: an inline `onPress={() => …}`
    // in the screen's renderItem, or any unstable dep in its useCallback, makes
    // every row re-render on every list render.
    const notification = makeNotification();

    const { rerender } = render(<NotificationRow notification={notification} onPress={onPress} />);
    expect(renderCounter.count).toBe(1);

    rerender(<NotificationRow notification={notification} onPress={vi.fn()} />);
    expect(renderCounter.count).toBe(2);
  });
});
