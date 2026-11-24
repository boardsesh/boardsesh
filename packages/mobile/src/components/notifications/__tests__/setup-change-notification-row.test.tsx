// @vitest-environment jsdom
// The creator's "A climber changed the setup of your board" row: Undo while the
// change is live, and what happened once it isn't.
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { DirectoryNotice, GroupedNotification } from '@boardsesh/shared-schema';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('@boardsesh/profile-stats', () => ({ formatTickRelativeTime: () => '2h ago', tickTimeMs: () => 0 }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#666', separator: '#ccc', secondaryBackground: '#f2f2f7', fill: '#eee' },
    brandColors: { primary: '#6D28D9', error: '#f00' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../Text', () => ({
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('span', { 'data-testid': testID }, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Avatar', () => ({ Avatar: () => null }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress }: { children?: ReactNode; onPress: () => void }) =>
    createElement('div', { 'data-testid': 'row', onClick: onPress }, children),
}));
vi.mock('../../Button', () => ({
  Button: ({
    title,
    onPress,
    disabled,
    testID,
  }: {
    title: string;
    onPress: () => void;
    disabled?: boolean;
    testID?: string;
  }) => createElement('button', { type: 'button', onClick: onPress, disabled, 'data-testid': testID }, title),
}));

import { SetupChangeNotificationRow } from '../SetupChangeNotificationRow';

function notice(overrides: Partial<DirectoryNotice> = {}): DirectoryNotice {
  return {
    targetKind: 'board',
    boardUuid: 'board-1',
    boardName: 'Crux Kilter',
    boardType: 'kilter',
    gymUuid: 'gym-1',
    gymName: 'Crux',
    isReminder: false,
    recipientIsCreator: true,
    setupChangeEventId: '42',
    setupBefore: { layoutId: 1, sizeId: 10, setIds: '1,20', angle: null },
    setupAfter: { layoutId: 8, sizeId: 17, setIds: '26,27', angle: null },
    setupChangeState: 'LIVE',
    ...overrides,
  };
}

function row(directoryNotice: DirectoryNotice): GroupedNotification {
  return {
    uuid: 'n1',
    type: 'board_setup_changed_by_climber',
    entityType: 'board',
    entityId: 'board-1',
    actorCount: 0,
    actors: [],
    isRead: false,
    createdAt: '2026-11-24T10:00:00.000Z',
    directoryNotice,
  } as unknown as GroupedNotification;
}

describe('SetupChangeNotificationRow', () => {
  it('says what the board climbs now, offers Undo, and opens the board on a tap', async () => {
    const notification = row(notice());
    const onPress = vi.fn();
    const onUndo = vi.fn().mockResolvedValue('undone');
    const screen = render(<SetupChangeNotificationRow notification={notification} onPress={onPress} onUndo={onUndo} />);
    expect(screen.getByText('items.boardSetupChangedByClimber{"board":"Crux Kilter"}')).toBeTruthy();
    expect(
      screen.getByText('setupChange.now{"setup":"Homewall · 7×10 · Full Ride · Mainline, Auxiliary"}'),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId('row'));
    expect(onPress).toHaveBeenCalledWith(notification);
    await act(async () => {
      fireEvent.click(screen.getByTestId('setup-change-undo'));
    });
    expect(onUndo).toHaveBeenCalledWith(notification);
    expect(screen.queryByTestId('setup-change-status')).toBeNull();
  });

  it('says so when Undo fails, and offers it again', async () => {
    const onUndo = vi.fn().mockRejectedValue(new Error('offline'));
    const screen = render(
      <SetupChangeNotificationRow notification={row(notice())} onPress={vi.fn()} onUndo={onUndo} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('setup-change-undo'));
    });
    expect(screen.getByTestId('setup-change-status').textContent).toBe('setupChange.failed');
    expect((screen.getByTestId('setup-change-undo') as HTMLButtonElement).disabled).toBe(false);
  });

  it('asks once and sends once on a double tap', async () => {
    let finish: (outcome: 'undone') => void = () => undefined;
    const onUndo = vi.fn(
      () =>
        new Promise<'undone'>((resolve) => {
          finish = resolve;
        }),
    );
    const screen = render(
      <SetupChangeNotificationRow notification={row(notice())} onPress={vi.fn()} onUndo={onUndo} />,
    );
    // Both taps land before the first one re-renders the button disabled.
    const button = screen.getByTestId('setup-change-undo');
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(onUndo).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish('undone');
    });
    // Free again once it ended.
    await act(async () => {
      fireEvent.click(screen.getByTestId('setup-change-undo'));
    });
    expect(onUndo).toHaveBeenCalledTimes(2);
  });

  it('says someone else put the old setup back when they undid it first', async () => {
    const onUndo = vi.fn().mockResolvedValue('already_undone');
    const notification = row(notice());
    const screen = render(<SetupChangeNotificationRow notification={notification} onPress={vi.fn()} onUndo={onUndo} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('setup-change-undo'));
    });
    // The inbox cache moves the notice to UNDONE.
    screen.rerender(
      <SetupChangeNotificationRow
        notification={row(notice({ setupChangeState: 'UNDONE' }))}
        onPress={vi.fn()}
        onUndo={onUndo}
      />,
    );
    expect(screen.queryByTestId('setup-change-undo')).toBeNull();
    expect(screen.getByTestId('setup-change-status').textContent).toBe('setupChange.alreadyUndone');
  });

  it('drops Undo and says so once the server no longer lets this viewer undo it', async () => {
    const onUndo = vi.fn().mockResolvedValue('not_allowed');
    const screen = render(
      <SetupChangeNotificationRow notification={row(notice())} onPress={vi.fn()} onUndo={onUndo} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('setup-change-undo'));
    });
    expect(screen.queryByTestId('setup-change-undo')).toBeNull();
    expect(screen.getByTestId('setup-change-status').textContent).toBe('setupChange.notAllowed');
  });

  it("shows another notice's ending on none of its own once the cell is recycled", async () => {
    const onUndo = vi.fn().mockResolvedValue('not_allowed');
    const screen = render(
      <SetupChangeNotificationRow notification={row(notice())} onPress={vi.fn()} onUndo={onUndo} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('setup-change-undo'));
    });
    screen.rerender(
      <SetupChangeNotificationRow
        notification={{ ...row(notice()), uuid: 'n2' } as GroupedNotification}
        onPress={vi.fn()}
        onUndo={onUndo}
      />,
    );
    expect(screen.getByTestId('setup-change-undo')).toBeTruthy();
    expect(screen.queryByTestId('setup-change-status')).toBeNull();
  });

  it('drops Undo and points at the board once the board changed again', () => {
    const screen = render(
      <SetupChangeNotificationRow
        notification={row(notice({ setupChangeState: 'CHANGED_SINCE' }))}
        onPress={vi.fn()}
        onUndo={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('setup-change-undo')).toBeNull();
    expect(screen.getByTestId('setup-change-status').textContent).toBe('setupChange.changedSince');
  });

  it('says the old setup is back once it was undone', () => {
    const screen = render(
      <SetupChangeNotificationRow
        notification={row(notice({ setupChangeState: 'UNDONE' }))}
        onPress={vi.fn()}
        onUndo={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('setup-change-undo')).toBeNull();
    expect(screen.getByTestId('setup-change-status').textContent).toBe('setupChange.undone');
  });
});
