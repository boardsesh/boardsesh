// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { GroupedNotification } from '@boardsesh/shared-schema';

// How many times NotificationRow's body actually runs. The body renders exactly
// one PressableSurface, so a counter in that mock is a faithful proxy: if
// React.memo bails an identical-props re-render, this must NOT bump.
const renderCounter = vi.hoisted(() => ({ count: 0 }));

/** The last props the board thumbnail was handed, or null if it never rendered. */
const thumbnail = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

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
  borderRadius: { md: 8 },
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
// The real thumbnail reaches the native board renderer. The row only decides
// WHETHER to draw one, so record the props and assert on those.
vi.mock('../../ClimbListThumbnail', () => ({
  ClimbListThumbnail: (props: { frames: string; boardName: string; sizeId: number; setIds: string }) => {
    thumbnail.props = props;
    return createElement('div', { 'data-thumbnail': props.frames });
  },
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
    thumbnail.props = null;
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

describe('NotificationRow leading slot', () => {
  beforeEach(() => {
    renderCounter.count = 0;
    thumbnail.props = null;
    vi.clearAllMocks();
  });

  /** A kilter climb on layout 8 — the shape the resolver fills for climb-bearing rows. */
  function makeClimbNotification(overrides: Partial<GroupedNotification> = {}): GroupedNotification {
    return makeNotification({
      type: 'new_climb',
      entityType: 'climb',
      entityId: 'C-1',
      climbUuid: 'C-1',
      climbName: 'Blue Ridge',
      boardType: 'kilter',
      climbLayoutId: 8,
      climbFrames: 'p1080r12p1122r13',
      ...overrides,
    });
  }

  it('draws board art with the actor over it for a climb row', () => {
    const { container } = render(<NotificationRow notification={makeClimbNotification()} onPress={onPress} />);

    expect(container.querySelector('[data-thumbnail="p1080r12p1122r13"]')).not.toBeNull();
    expect(thumbnail.props).toMatchObject({ boardName: 'kilter', layoutId: 8 });
    // The size is comma-joined for the renderer, and the cell stays at 44 wide so
    // the render cache key resolves to the same `_w400_` PNG the climbs list wrote.
    expect(thumbnail.props?.setIds).toBeTypeOf('string');
    expect(thumbnail.props?.size).toEqual({ width: 44, height: 56 });
    // The actor rides the art's corner instead of owning the whole slot.
    expect(container.querySelector('[data-avatar="true"]')).not.toBeNull();
    // The board art is the type cue, so the glyph goes.
    expect(container.querySelector('[data-icon="true"]')).toBeNull();
  });

  it('draws board art for a like on your ascent', () => {
    // The resolver walks the tick to its climb, so an ascent row is a climb row
    // as far as the leading slot is concerned.
    const { container } = render(
      <NotificationRow
        notification={makeClimbNotification({
          type: 'vote_on_tick',
          entityType: 'tick',
          entityId: 'tick-9',
          threadEntityType: 'tick',
          threadEntityId: 'tick-9',
        })}
        onPress={onPress}
      />,
    );

    expect(container.querySelector('[data-thumbnail="p1080r12p1122r13"]')).not.toBeNull();
  });

  it('falls back to the avatar and glyph when the row is not about a climb', () => {
    const { container } = render(<NotificationRow notification={makeNotification()} onPress={onPress} />);

    expect(thumbnail.props).toBeNull();
    expect(container.querySelector('[data-avatar="true"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="true"]')).not.toBeNull();
  });

  it('falls back to the avatar when the backend has not sent frames yet', () => {
    // An OTA'd client briefly ahead of the backend deploy. A blank tile in a
    // list reads as broken; a missing one reads as "not a climb row".
    const { container } = render(
      <NotificationRow notification={makeClimbNotification({ climbFrames: null })} onPress={onPress} />,
    );

    expect(thumbnail.props).toBeNull();
    expect(container.querySelector('[data-avatar="true"]')).not.toBeNull();
  });

  it('falls back to the avatar when the board name does not resolve', () => {
    const { container } = render(
      <NotificationRow notification={makeClimbNotification({ boardType: 'not-a-board' })} onPress={onPress} />,
    );

    expect(thumbnail.props).toBeNull();
    expect(container.querySelector('[data-avatar="true"]')).not.toBeNull();
  });

  it('still bails the memo for a climb row', () => {
    const notification = makeClimbNotification();

    const { rerender } = render(<NotificationRow notification={notification} onPress={onPress} />);
    expect(renderCounter.count).toBe(1);

    rerender(<NotificationRow notification={notification} onPress={onPress} />);
    expect(renderCounter.count).toBe(1);
  });
});
