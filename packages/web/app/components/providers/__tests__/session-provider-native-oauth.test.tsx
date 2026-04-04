import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import React from 'react';

// Mock next-auth/react
const mockSignIn = vi.fn();
vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  signIn: (...args: unknown[]) => mockSignIn(...args),
}));

// Mock capacitor-utils
const mockIsNativeApp = vi.fn();
vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  isNativeApp: () => mockIsNativeApp(),
}));

import SessionProviderWrapper from '../session-provider';

type AppUrlOpenListener = (event: { url: string }) => void;

describe('SessionProviderWrapper native OAuth deep link', () => {
  let capturedListener: AppUrlOpenListener | null = null;
  const mockRemove = vi.fn().mockResolvedValue(undefined);
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockAddListener = vi.fn();
  const mockLocationAssign = vi.fn();
  let originalLocation: Location;

  beforeEach(() => {
    capturedListener = null;
    mockSignIn.mockReset();
    mockRemove.mockClear();
    mockClose.mockClear();
    mockAddListener.mockReset();
    mockLocationAssign.mockClear();
    mockIsNativeApp.mockReturnValue(false);

    mockAddListener.mockImplementation(
      (_event: string, listener: AppUrlOpenListener) => {
        capturedListener = listener;
        return Promise.resolve({ remove: mockRemove });
      },
    );

    // Mock window.location.assign — jsdom marks location properties as
    // non-configurable, so vi.spyOn fails on repeated calls. Replace the
    // entire location object instead.
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, assign: mockLocationAssign },
      writable: true,
      configurable: true,
    });

    // Reset window.Capacitor mock
    Object.defineProperty(window, 'Capacitor', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'Capacitor', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  function setupCapacitorMock() {
    mockIsNativeApp.mockReturnValue(true);
    Object.defineProperty(window, 'Capacitor', {
      value: {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        Plugins: {
          App: { addListener: mockAddListener },
          Browser: { close: mockClose },
        },
      },
      writable: true,
      configurable: true,
    });
  }

  it('does not register listener when not a native app', () => {
    mockIsNativeApp.mockReturnValue(false);
    render(
      <SessionProviderWrapper>
        <div>child</div>
      </SessionProviderWrapper>,
    );
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it('registers appUrlOpen listener in native app', async () => {
    setupCapacitorMock();
    render(
      <SessionProviderWrapper>
        <div>child</div>
      </SessionProviderWrapper>,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockAddListener).toHaveBeenCalledWith(
      'appUrlOpen',
      expect.any(Function),
    );
    expect(capturedListener).not.toBeNull();
  });

  it('handles malformed deep link URL gracefully', async () => {
    setupCapacitorMock();

    render(
      <SessionProviderWrapper>
        <div>child</div>
      </SessionProviderWrapper>,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      capturedListener?.({
        url: 'com.boardsesh.app://auth/callback%%%malformed',
      });
    });

    expect(mockClose).toHaveBeenCalled();
    expect(mockSignIn).not.toHaveBeenCalled();
    expect(mockLocationAssign).toHaveBeenCalledWith('/auth/login');
  });

  it('ignores non-auth deep links', async () => {
    setupCapacitorMock();
    render(
      <SessionProviderWrapper>
        <div>child</div>
      </SessionProviderWrapper>,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      capturedListener?.({ url: 'com.boardsesh.app://some/other/path' });
    });

    expect(mockSignIn).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('closes browser and redirects to login on error param', async () => {
    setupCapacitorMock();

    render(
      <SessionProviderWrapper>
        <div>child</div>
      </SessionProviderWrapper>,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      capturedListener?.({
        url: 'com.boardsesh.app://auth/callback?error=session_missing',
      });
    });

    expect(mockClose).toHaveBeenCalled();
    expect(mockSignIn).not.toHaveBeenCalled();
    expect(mockLocationAssign).toHaveBeenCalledWith('/auth/login');
  });

  it('closes browser and redirects to login when transfer token is missing', async () => {
    setupCapacitorMock();

    render(
      <SessionProviderWrapper>
        <div>child</div>
      </SessionProviderWrapper>,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      capturedListener?.({
        url: 'com.boardsesh.app://auth/callback',
      });
    });

    expect(mockClose).toHaveBeenCalled();
    expect(mockSignIn).not.toHaveBeenCalled();
    expect(mockLocationAssign).toHaveBeenCalledWith('/auth/login');
  });

  it('calls signIn with transfer token and redirects on success', async () => {
    setupCapacitorMock();
    mockSignIn.mockResolvedValue({ url: '/dashboard', error: null });

    render(
      <SessionProviderWrapper>
        <div>child</div>
      </SessionProviderWrapper>,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      capturedListener?.({
        url: 'com.boardsesh.app://auth/callback?transferToken=abc123&next=/dashboard',
      });
    });

    expect(mockClose).toHaveBeenCalled();
    expect(mockSignIn).toHaveBeenCalledWith('native-oauth', {
      transferToken: 'abc123',
      callbackUrl: '/dashboard',
      redirect: false,
    });
    expect(mockLocationAssign).toHaveBeenCalledWith('/dashboard');
  });

  it('redirects to login when signIn returns an error', async () => {
    setupCapacitorMock();
    mockSignIn.mockResolvedValue({ url: null, error: 'CredentialsSignin' });

    render(
      <SessionProviderWrapper>
        <div>child</div>
      </SessionProviderWrapper>,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      capturedListener?.({
        url: 'com.boardsesh.app://auth/callback?transferToken=bad-token&next=/settings',
      });
    });

    expect(mockLocationAssign).toHaveBeenCalledWith('/auth/login');
  });

  it('sanitizes non-relative next path to root', async () => {
    setupCapacitorMock();
    mockSignIn.mockResolvedValue({ url: '/', error: null });

    render(
      <SessionProviderWrapper>
        <div>child</div>
      </SessionProviderWrapper>,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      capturedListener?.({
        url: 'com.boardsesh.app://auth/callback?transferToken=abc&next=https://evil.com',
      });
    });

    expect(mockSignIn).toHaveBeenCalledWith('native-oauth', {
      transferToken: 'abc',
      callbackUrl: '/',
      redirect: false,
    });
  });

  it('removes listener on unmount', async () => {
    setupCapacitorMock();
    const { unmount } = render(
      <SessionProviderWrapper>
        <div>child</div>
      </SessionProviderWrapper>,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    unmount();
    expect(mockRemove).toHaveBeenCalled();
  });

  it('removes listener if component unmounts before registration completes', async () => {
    setupCapacitorMock();
    let resolveListener: ((value: { remove: () => Promise<void> }) => void) | null = null;
    mockAddListener.mockImplementation(
      (_event: string, listener: AppUrlOpenListener) => {
        capturedListener = listener;
        return new Promise((resolve) => {
          resolveListener = resolve;
        });
      },
    );

    const { unmount } = render(
      <SessionProviderWrapper>
        <div>child</div>
      </SessionProviderWrapper>,
    );

    // Unmount before the listener promise resolves
    unmount();

    // Now resolve the listener registration
    await act(async () => {
      resolveListener?.({ remove: mockRemove });
      await new Promise((r) => setTimeout(r, 0));
    });

    // The cancelled flag should cause immediate cleanup
    expect(mockRemove).toHaveBeenCalled();
  });
});
