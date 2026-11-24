import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AuthModalProvider, useAuthModal } from '../auth-modal-provider';

const { mockAuthModal } = vi.hoisted(() => ({
  mockAuthModal: vi.fn(
    ({
      open,
      onClose,
      onSuccess,
      title,
      description,
    }: {
      open: boolean;
      onClose: () => void;
      onSuccess?: () => void;
      title?: string;
      description?: string;
    }) =>
      open ? (
        <div data-testid="auth-modal" data-title={title} data-description={description}>
          <button data-testid="auth-close" onClick={onClose}>
            Close
          </button>
          {onSuccess && (
            <button data-testid="auth-success" onClick={onSuccess}>
              Success
            </button>
          )}
        </div>
      ) : null,
  ),
}));

vi.mock('@/app/components/auth/auth-modal', () => ({
  default: mockAuthModal,
}));

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthModalProvider>{children}</AuthModalProvider>;
}

/** Helper to get the props passed to the last AuthModal render */
function lastAuthModalProps() {
  return mockAuthModal.mock.calls[mockAuthModal.mock.calls.length - 1][0] as {
    open: boolean;
    onClose: () => void;
    onSuccess: () => void;
    title?: string;
    description?: string;
  };
}

describe('AuthModalProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns openAuthModal function', async () => {
    const { result } = renderHook(() => useAuthModal(), { wrapper });
    expect(result.current.openAuthModal).toEqual(expect.any(Function));
  });

  it('opens AuthModal with provided config', async () => {
    const { result } = renderHook(() => useAuthModal(), { wrapper });

    await act(async () => {
      result.current.openAuthModal({
        title: 'Test Title',
        description: 'Test description',
      });
    });

    const props = lastAuthModalProps();
    expect(props.open).toBe(true);
    expect(props.title).toBe('Test Title');
    expect(props.description).toBe('Test description');
  });

  it('opens AuthModal with default config when no args provided', async () => {
    const { result } = renderHook(() => useAuthModal(), { wrapper });

    await act(async () => {
      result.current.openAuthModal();
    });

    expect(lastAuthModalProps().open).toBe(true);
  });

  it('closes AuthModal on close callback', async () => {
    const { result } = renderHook(() => useAuthModal(), { wrapper });

    await act(async () => {
      result.current.openAuthModal({ title: 'Test' });
    });
    expect(lastAuthModalProps().open).toBe(true);

    await act(async () => {
      lastAuthModalProps().onClose();
    });
    expect(lastAuthModalProps().open).toBe(false);
  });

  it('calls onSuccess callback and closes modal on success', async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useAuthModal(), { wrapper });

    await act(async () => {
      result.current.openAuthModal({ title: 'Test', onSuccess });
    });
    expect(lastAuthModalProps().open).toBe(true);

    await act(async () => {
      lastAuthModalProps().onSuccess();
    });

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(lastAuthModalProps().open).toBe(false);
  });

  it('onSuccess still fires even if onClose is called first (AuthModal calls onClose before onSuccess)', async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useAuthModal(), { wrapper });

    await act(async () => {
      result.current.openAuthModal({ title: 'Test', onSuccess });
    });

    // AuthModal internally calls onClose() then onSuccess?.() on successful login
    await act(async () => {
      lastAuthModalProps().onClose();
    });
    await act(async () => {
      lastAuthModalProps().onSuccess();
    });

    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('latest openAuthModal call wins when called multiple times', async () => {
    const { result } = renderHook(() => useAuthModal(), { wrapper });

    await act(async () => {
      result.current.openAuthModal({ title: 'First' });
      result.current.openAuthModal({ title: 'Second' });
    });

    const props = lastAuthModalProps();
    expect(props.open).toBe(true);
    expect(props.title).toBe('Second');
  });

  it('does not mount AuthModal until first open', async () => {
    const { result } = renderHook(() => useAuthModal(), { wrapper });

    expect(mockAuthModal).not.toHaveBeenCalled();

    await act(async () => {
      result.current.openAuthModal();
    });

    expect(mockAuthModal).toHaveBeenCalled();

    // After closing, the modal stays mounted with open=false so the close
    // animation can play and form state survives.
    await act(async () => {
      lastAuthModalProps().onClose();
    });
    expect(lastAuthModalProps().open).toBe(false);
  });

  it('works with default context outside provider (noop)', async () => {
    const { result } = renderHook(() => useAuthModal());
    // Should not throw — the default-context implementation is a no-op.
    expect(() => result.current.openAuthModal()).not.toThrow();
  });
});
