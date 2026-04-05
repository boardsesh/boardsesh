import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import EditAscentDialog, { type EditAscentValues } from '../edit-ascent-dialog';

const defaultValues: EditAscentValues = {
  status: 'send',
  attemptCount: 3,
  quality: 4,
  comment: 'Great route',
};

function renderDialog(
  props?: Partial<React.ComponentProps<typeof EditAscentDialog>>,
) {
  const onClose = vi.fn();
  const onSave = vi.fn();

  const utils = render(
    <EditAscentDialog
      open={true}
      onClose={onClose}
      onSave={onSave}
      initialValues={defaultValues}
      {...props}
    />,
  );

  return { onClose, onSave, ...utils };
}

describe('EditAscentDialog', () => {
  it('renders dialog title "Edit ascent" when open', () => {
    renderDialog();
    expect(screen.getByText('Edit ascent')).toBeTruthy();
  });

  it('renders all three toggle buttons (Flash, Send, Attempt)', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: /flash/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /send/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /attempt/i })).toBeTruthy();
  });

  it('shows attempts field when status is "send" but not for "flash"', () => {
    const { rerender } = render(
      <EditAscentDialog
        open={true}
        onClose={vi.fn()}
        onSave={vi.fn()}
        initialValues={{ ...defaultValues, status: 'send' }}
      />,
    );

    // Attempts field is visible for "send"
    expect(screen.getByLabelText(/attempts/i)).toBeTruthy();

    // Re-render with flash — attempts field should not appear
    rerender(
      <EditAscentDialog
        open={true}
        onClose={vi.fn()}
        onSave={vi.fn()}
        initialValues={{ ...defaultValues, status: 'flash' }}
      />,
    );

    expect(screen.queryByLabelText(/attempts/i)).toBeNull();
  });

  it('hides quality rating when status is "attempt"', () => {
    renderDialog({ initialValues: { ...defaultValues, status: 'attempt', quality: null } });
    expect(screen.queryByText('Quality')).toBeNull();
  });

  it('shows quality rating when status is "send" or "flash"', () => {
    renderDialog({ initialValues: { ...defaultValues, status: 'send' } });
    expect(screen.getByText('Quality')).toBeTruthy();
  });

  it('calls onSave with correct values when Save is clicked', () => {
    const { onSave } = renderDialog({
      initialValues: {
        status: 'send',
        attemptCount: 5,
        quality: 3,
        comment: 'Solid climb',
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith({
      status: 'send',
      attemptCount: 5,
      quality: 3,
      comment: 'Solid climb',
    });
  });

  it('calls onClose when Cancel is clicked', () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('disables Save and Cancel buttons when saving=true', () => {
    renderDialog({ saving: true });

    const saveButton = screen.getByRole('button', { name: /save/i });
    const cancelButton = screen.getByRole('button', { name: /cancel/i });

    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
    expect((cancelButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('resets form values when re-opened with new initialValues', () => {
    const { rerender } = render(
      <EditAscentDialog
        open={false}
        onClose={vi.fn()}
        onSave={vi.fn()}
        initialValues={{ status: 'send', attemptCount: 3, quality: 4, comment: 'Old comment' }}
      />,
    );

    // Re-open with new initialValues
    rerender(
      <EditAscentDialog
        open={true}
        onClose={vi.fn()}
        onSave={vi.fn()}
        initialValues={{ status: 'flash', attemptCount: 1, quality: 5, comment: 'New comment' }}
      />,
    );

    // Attempts field should be hidden (flash hides it)
    expect(screen.queryByLabelText(/attempts/i)).toBeNull();

    // Comment field should show the new value
    const commentField = screen.getByLabelText(/comment/i) as HTMLTextAreaElement;
    expect(commentField.value).toBe('New comment');
  });
});
