import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ConfirmAddClimbDialog from '../confirm-add-climb-dialog';
import type { BoardConfig } from '@boardsesh/shared-schema';
import type { ConfirmAddChoice } from '../confirm-add-climb-dialog';

function makeConfig(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    boardName: 'tension',
    layoutId: 2,
    sizeId: 20,
    setIds: [1, 2],
    angle: 40,
    ...overrides,
  };
}

describe('ConfirmAddClimbDialog', () => {
  let onChoose: Mock<(choice: ConfirmAddChoice) => void>;

  beforeEach(() => {
    onChoose = vi.fn<(choice: ConfirmAddChoice) => void>();
  });

  it('renders the new_config headline and body when open', () => {
    render(
      <ConfirmAddClimbDialog
        open
        reason="new_config"
        incoming={makeConfig({ boardName: 'tension' })}
        onChoose={onChoose}
      />,
    );
    expect(screen.getByText('This climb is on a different board')).toBeTruthy();
    // Body mentions the board label (title-cased)
    expect(
      screen.getByText(/You're about to add a climb from Tension/i),
    ).toBeTruthy();
  });

  it('renders the larger_size headline and body when open', () => {
    render(
      <ConfirmAddClimbDialog
        open
        reason="larger_size"
        incoming={makeConfig({ boardName: 'kilter' })}
        onChoose={onChoose}
      />,
    );
    expect(screen.getByText('This climb is for a bigger board size')).toBeTruthy();
    expect(
      screen.getByText(/larger Kilter than what you've got queued/i),
    ).toBeTruthy();
  });

  it('calls onChoose("add") when "Add to current queue" is clicked', () => {
    render(
      <ConfirmAddClimbDialog
        open
        reason="new_config"
        incoming={makeConfig()}
        onChoose={onChoose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Add to current queue/i }));
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith('add');
  });

  it('calls onChoose("switch") when "Switch to that board" is clicked', () => {
    render(
      <ConfirmAddClimbDialog
        open
        reason="new_config"
        incoming={makeConfig()}
        onChoose={onChoose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Switch to that board/i }));
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith('switch');
  });

  it('calls onChoose("cancel") when the Cancel button is clicked', () => {
    render(
      <ConfirmAddClimbDialog
        open
        reason="new_config"
        incoming={makeConfig()}
        onChoose={onChoose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith('cancel');
  });

  it('calls onChoose("cancel") when Escape is pressed (onClose path)', () => {
    render(
      <ConfirmAddClimbDialog
        open
        reason="new_config"
        incoming={makeConfig()}
        onChoose={onChoose}
      />,
    );
    // MUI Dialog forwards Escape to onClose, which forwards to onChoose('cancel')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' });
    expect(onChoose).toHaveBeenCalledWith('cancel');
  });

  it('calls onChoose("cancel") when the backdrop is clicked', () => {
    const { baseElement } = render(
      <ConfirmAddClimbDialog
        open
        reason="new_config"
        incoming={makeConfig()}
        onChoose={onChoose}
      />,
    );
    // MUI renders the backdrop with class "MuiBackdrop-root" inside the dialog overlay
    const backdrop = baseElement.querySelector('.MuiBackdrop-root');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(onChoose).toHaveBeenCalledWith('cancel');
  });

  it('renders nothing (no dialog content visible) when open=false', () => {
    render(
      <ConfirmAddClimbDialog
        open={false}
        reason="new_config"
        incoming={makeConfig()}
        onChoose={onChoose}
      />,
    );
    // MUI removes the Dialog from the DOM when open=false (keepMounted defaults to false)
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen.queryByText('This climb is on a different board'),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: /Add to current queue/i })).toBeNull();
  });
});
