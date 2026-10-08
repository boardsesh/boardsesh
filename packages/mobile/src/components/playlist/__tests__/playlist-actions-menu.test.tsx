// @vitest-environment jsdom
//
// HIG Pull-down buttons: the owner's five playlist actions are a menu off the ⋯
// button, not a sheet. AppMenu is the native UIMenu / Android dropdown, so here
// it is captured: what the menu is asked to show, and what each row runs.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import type { AppMenuAction } from '../../AppMenu';

const menu = vi.hoisted(() => ({
  actions: [] as AppMenuAction[],
  onSelectIndex: (_index: number): unknown => undefined,
  iconName: undefined as string | undefined,
  accessibilityLabel: undefined as string | undefined,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../AppMenu', () => ({
  AppMenu: (props: {
    actions: AppMenuAction[];
    onSelectIndex: (index: number) => void;
    iconName?: string;
    accessibilityLabel?: string;
  }) => {
    menu.actions = props.actions;
    menu.onSelectIndex = props.onSelectIndex;
    menu.iconName = props.iconName;
    menu.accessibilityLabel = props.accessibilityLabel;
    return createElement('div', { 'data-app-menu': 'true' });
  },
}));

import { PlaylistActionsMenu } from '../PlaylistActionsMenu';

function handlers() {
  return {
    onTogglePin: vi.fn(),
    onAddClimbs: vi.fn(),
    onEditDetails: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
  };
}

beforeEach(() => {
  menu.actions = [];
});

describe('PlaylistActionsMenu', () => {
  it('is a ⋯ menu, not a sheet', () => {
    const { container } = render(<PlaylistActionsMenu isPinned={false} {...handlers()} />);

    expect(container.querySelector('[data-app-menu]')).not.toBeNull();
    expect(menu.iconName).toBe('more');
    expect(menu.accessibilityLabel).toBe('detail.actions');
  });

  it('lays the owner rows out pin / add / details / climbs / delete, with delete destructive', () => {
    render(<PlaylistActionsMenu isPinned={false} {...handlers()} />);

    expect(menu.actions.map((action) => action.label)).toEqual([
      'library.pin.pin',
      'detail.menu.addClimbs',
      'detail.menu.editDetails',
      'detail.menu.editClimbs',
      'detail.menu.delete',
    ]);
    expect(menu.actions.map((action) => action.destructive === true)).toEqual([false, false, false, false, true]);
  });

  it('offers unpin with its own symbol on a pinned playlist', () => {
    render(<PlaylistActionsMenu isPinned {...handlers()} />);

    expect(menu.actions[0]).toMatchObject({ label: 'library.pin.unpin', systemIcon: 'pin.slash' });
  });

  it('drops the add-climbs row when the caller omits the handler', () => {
    const { onAddClimbs: _omitted, ...rest } = handlers();
    render(<PlaylistActionsMenu isPinned={false} {...rest} />);

    expect(menu.actions.map((action) => action.label)).not.toContain('detail.menu.addClimbs');
    expect(menu.actions).toHaveLength(4);
  });

  it('runs exactly the tapped row, by position, with and without the add row', () => {
    const withAdd = handlers();
    render(<PlaylistActionsMenu isPinned={false} {...withAdd} />);
    menu.onSelectIndex(2);
    expect(withAdd.onEditDetails).toHaveBeenCalledTimes(1);
    menu.onSelectIndex(4);
    expect(withAdd.onDelete).toHaveBeenCalledTimes(1);
    expect(withAdd.onTogglePin).not.toHaveBeenCalled();
    expect(withAdd.onEdit).not.toHaveBeenCalled();

    const { onAddClimbs: _omitted, ...withoutAdd } = handlers();
    render(<PlaylistActionsMenu isPinned={false} {...withoutAdd} />);
    menu.onSelectIndex(1);
    expect(withoutAdd.onEditDetails).toHaveBeenCalledTimes(1);
    menu.onSelectIndex(2);
    expect(withoutAdd.onEdit).toHaveBeenCalledTimes(1);
    menu.onSelectIndex(0);
    expect(withoutAdd.onTogglePin).toHaveBeenCalledTimes(1);
  });
});
