import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import AscentActionsMenu, { type AscentData } from '../ascent-actions-menu';
import type { EditAscentValues } from '../edit-ascent-dialog';

// --- Mocks ---

vi.mock('../edit-ascent-dialog', () => ({
  default: ({
    open,
    onClose,
    onSave,
    initialValues,
  }: {
    open: boolean;
    onClose: () => void;
    onSave: (values: EditAscentValues) => void;
    saving?: boolean;
    initialValues: EditAscentValues;
  }) =>
    open ? (
      <div data-testid="edit-ascent-dialog">
        <button onClick={onClose}>Cancel</button>
        <button onClick={() => onSave(initialValues)}>Save</button>
      </div>
    ) : null,
}));

// --- Test data ---

const defaultAscent: AscentData = {
  uuid: 'ascent-uuid-1',
  status: 'send',
  attemptCount: 3,
  quality: 4,
  comment: 'Great route',
};

// --- Helpers ---

function renderMenu(props: Partial<React.ComponentProps<typeof AscentActionsMenu>> = {}) {
  const onUpdate = vi.fn();
  const onDelete = vi.fn();

  const utils = render(
    <AscentActionsMenu
      ascent={defaultAscent}
      onUpdate={onUpdate}
      onDelete={onDelete}
      {...props}
    />,
  );

  return { onUpdate, onDelete, ...utils };
}

function openMenu() {
  const button = screen.getByRole('button', { name: /ascent actions/i });
  fireEvent.click(button);
}

// --- Tests ---

describe('AscentActionsMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the actions button with correct aria-label', () => {
    renderMenu();
    expect(screen.getByRole('button', { name: /ascent actions/i })).toBeTruthy();
  });

  it('opens menu with Edit and Delete options when clicked', () => {
    renderMenu();
    openMenu();

    expect(screen.getByRole('menuitem', { name: /edit/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /delete/i })).toBeTruthy();
  });

  it('opens edit dialog when Edit is clicked', () => {
    renderMenu();
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: /edit/i }));

    expect(screen.getByTestId('edit-ascent-dialog')).toBeTruthy();
  });

  it('shows confirm popover when Delete is clicked', () => {
    renderMenu();
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: /delete/i }));

    // ConfirmPopover renders a Popover with title and description
    expect(screen.getByText("Delete this ascent?")).toBeTruthy();
    expect(screen.getByText("This can't be undone.")).toBeTruthy();
  });

  it('calls onDelete with correct uuid after confirming delete', () => {
    const { onDelete } = renderMenu();
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: /delete/i }));

    // Click the confirm (Delete) button inside the popover
    const deleteButton = screen.getByRole('button', { name: /^delete$/i });
    fireEvent.click(deleteButton);

    expect(onDelete).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledWith('ascent-uuid-1');
  });

  it('disables actions button when updating=true', () => {
    renderMenu({ updating: true });

    const button = screen.getByRole('button', { name: /ascent actions/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('disables actions button when deleting=true', () => {
    renderMenu({ deleting: true });

    const button = screen.getByRole('button', { name: /ascent actions/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
