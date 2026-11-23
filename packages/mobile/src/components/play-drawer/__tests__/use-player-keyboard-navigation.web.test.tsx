// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { usePlayerKeyboardNavigation } from '../use-player-keyboard-navigation.web';
import type { PlayerKeyboardNavigationOptions } from '../use-player-keyboard-navigation.types';

function Player({ children, ...options }: PlayerKeyboardNavigationOptions & { children?: ReactNode }) {
  const keyboardProps = usePlayerKeyboardNavigation(options);
  return (
    <div data-testid="player" {...keyboardProps}>
      {children}
    </div>
  );
}

function setup(overrides: Partial<PlayerKeyboardNavigationOptions> = {}, children?: ReactNode) {
  const options = {
    enabled: true,
    label: 'Boots and Cats',
    canPrevious: true,
    canNext: true,
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    onEscape: vi.fn(),
    ...overrides,
  };
  return { ...render(<Player {...options}>{children}</Player>), ...options };
}

afterEach(cleanup);

describe('player browser keyboard navigation', () => {
  it('uses existing previous, next and close actions from the focused player region', () => {
    const { getByTestId, onPrevious, onNext, onEscape } = setup();
    const player = getByTestId('player');
    player.focus();
    expect(player).toBe(document.activeElement);
    expect(fireEvent.keyDown(player, { key: 'ArrowLeft' })).toBe(false);
    expect(fireEvent.keyDown(player, { key: 'ArrowRight' })).toBe(false);
    expect(fireEvent.keyDown(player, { key: 'Escape' })).toBe(false);
    expect(onPrevious).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it('does not receive shortcuts from outside the player', () => {
    const { onNext } = setup();
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(onNext).not.toHaveBeenCalled();
  });

  it.each([
    <input key="text" />,
    <input key="range" type="range" />,
    <textarea key="textarea" />,
    <select key="select">
      <option>Angle</option>
    </select>,
    <div key="editable" contentEditable suppressContentEditableWarning>
      Note
    </div>,
    <div key="slider" role="slider">
      <span>Angle</span>
    </div>,
    <div key="tab" role="tab">
      Beta
    </div>,
  ])('leaves arrow controls and editable content alone (%s)', (control) => {
    const { getByTestId, onNext, onEscape } = setup({}, control);
    const target = getByTestId('player').querySelector('span') ?? getByTestId('player').firstElementChild;
    if (!target) throw new Error('Missing test control');
    fireEvent.keyDown(target, { key: 'ArrowRight' });
    fireEvent.keyDown(target, { key: 'Escape' });
    expect(onNext).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();
  });

  it.each(['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'repeat', 'isComposing'])('ignores %s key events', (flag) => {
    const { getByTestId, onNext } = setup();
    fireEvent.keyDown(getByTestId('player'), { key: 'ArrowRight', [flag]: true });
    expect(onNext).not.toHaveBeenCalled();
  });

  it('leaves unavailable directions and persistent-pane Escape unhandled', () => {
    const { getByTestId, onNext, onPrevious } = setup({ canPrevious: false, canNext: false, onEscape: undefined });
    const player = getByTestId('player');
    expect(fireEvent.keyDown(player, { key: 'ArrowRight' })).toBe(true);
    expect(fireEvent.keyDown(player, { key: 'ArrowLeft' })).toBe(true);
    expect(fireEvent.keyDown(player, { key: 'Escape' })).toBe(true);
    expect(onNext).not.toHaveBeenCalled();
    expect(onPrevious).not.toHaveBeenCalled();
  });

  it('blocks the player while its sheet or pending work is open', () => {
    const { getByTestId, onNext } = setup({ enabled: false });
    const player = getByTestId('player');
    expect(player.hasAttribute('tabindex')).toBe(false);
    fireEvent.keyDown(player, { key: 'ArrowRight' });
    expect(onNext).not.toHaveBeenCalled();
  });

  it.each(['dialog', 'menu', 'marker'])('blocks shortcuts behind an open %s', (kind) => {
    const { getByTestId, onNext, onEscape } = setup();
    const overlay = document.createElement('div');
    if (kind === 'marker') overlay.dataset.boardseshPlayerShortcutBlock = 'true';
    else overlay.setAttribute('role', kind);
    document.body.append(overlay);
    fireEvent.keyDown(getByTestId('player'), { key: 'ArrowRight' });
    fireEvent.keyDown(getByTestId('player'), { key: 'Escape' });
    expect(onNext).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();
    overlay.remove();
  });

  it('allows the player inside its own modal and ignores hidden menus', () => {
    const options = { enabled: true, canPrevious: true, canNext: true, onPrevious: vi.fn(), onNext: vi.fn() };
    const { getByTestId } = render(
      <div role="dialog" aria-modal="true">
        <Player {...options}>
          <button>Next</button>
        </Player>
        <div hidden>
          <div role="menu" />
        </div>
      </div>,
    );
    fireEvent.keyDown(getByTestId('player'), { key: 'ArrowRight' });
    expect(options.onNext).toHaveBeenCalledOnce();
  });

  it('respects events already handled by a child', () => {
    const { getByText, onNext } = setup({}, <button onKeyDown={(event) => event.preventDefault()}>Action</button>);
    fireEvent.keyDown(getByText('Action'), { key: 'ArrowRight' });
    expect(onNext).not.toHaveBeenCalled();
  });
});
