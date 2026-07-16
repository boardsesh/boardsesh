import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import EditSessionDialog from '../edit-session-dialog';

// Translate keys to themselves so assertions can target them directly.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' },
  }),
}));

const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

const mockMutate = vi.fn();
let mockIsPending = false;
vi.mock('@/app/hooks/use-update-session', () => ({
  useUpdateSession: () => ({ mutate: mockMutate, isPending: mockIsPending }),
}));

function renderDialog(props: Partial<React.ComponentProps<typeof EditSessionDialog>> = {}) {
  const onClose = vi.fn();
  render(
    <EditSessionDialog
      open
      onClose={onClose}
      sessionId="session-1"
      initialName="Old Name"
      initialNotes="Old notes"
      {...props}
    />,
  );
  return { onClose };
}

describe('EditSessionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMutate.mockReset();
    mockShowMessage.mockReset();
    mockIsPending = false;
  });

  it('seeds both fields from the current session', () => {
    renderDialog();
    const nameInput = screen.getByLabelText('detail.editNameLabel') as HTMLInputElement;
    const recapInput = screen.getByLabelText('detail.editRecapLabel') as HTMLTextAreaElement;
    expect(nameInput.value).toBe('Old Name');
    expect(recapInput.value).toBe('Old notes');
  });

  it('sends only the changed field on save', () => {
    const { onClose } = renderDialog();
    fireEvent.change(screen.getByLabelText('detail.editNameLabel'), { target: { value: 'New Name' } });
    fireEvent.click(screen.getByText('detail.editSave'));

    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate.mock.calls[0][0]).toEqual({ sessionId: 'session-1', name: 'New Name' });

    // Success snackbar + close fire from the per-call onSuccess.
    const onSuccess = mockMutate.mock.calls[0][1]?.onSuccess as (() => void) | undefined;
    onSuccess?.();
    expect(mockShowMessage).toHaveBeenCalledWith('detail.editSaved', 'success');
    expect(onClose).toHaveBeenCalled();
  });

  it('sends null when clearing the name', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('detail.editNameLabel'), { target: { value: '' } });
    fireEvent.click(screen.getByText('detail.editSave'));

    expect(mockMutate).toHaveBeenCalledWith({ sessionId: 'session-1', name: null }, expect.anything());
  });

  it('sends null when clearing the recap', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('detail.editRecapLabel'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('detail.editSave'));

    expect(mockMutate).toHaveBeenCalledWith({ sessionId: 'session-1', notes: null }, expect.anything());
  });

  it('sends both fields when both change', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('detail.editNameLabel'), { target: { value: 'New Name' } });
    fireEvent.change(screen.getByLabelText('detail.editRecapLabel'), { target: { value: 'New notes' } });
    fireEvent.click(screen.getByText('detail.editSave'));

    expect(mockMutate.mock.calls[0][0]).toEqual({
      sessionId: 'session-1',
      name: 'New Name',
      notes: 'New notes',
    });
  });

  it('does not mutate on save when nothing changed, and closes', () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByText('detail.editSave'));
    expect(mockMutate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('does not mutate on cancel', () => {
    const { onClose } = renderDialog();
    fireEvent.change(screen.getByLabelText('detail.editNameLabel'), { target: { value: 'New Name' } });
    fireEvent.click(screen.getByText('detail.editCancel'));
    expect(mockMutate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
