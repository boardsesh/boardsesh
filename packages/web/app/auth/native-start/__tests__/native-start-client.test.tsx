import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import NativeStartClient from '../native-start-client';

const { selection, getCsrfToken } = vi.hoisted(() => ({
  selection: { provider: 'facebook' },
  getCsrfToken: vi.fn(async () => undefined),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams({ provider: selection.provider }),
}));
vi.mock('next-auth/react', () => ({ getCsrfToken }));
vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({ t: (key: string) => tFromCatalog(namespace, key) }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('native browser provider start', () => {
  it('refuses Facebook before requesting CSRF or creating a sign-in form', () => {
    selection.provider = 'facebook';
    const { container } = render(<NativeStartClient />);
    expect(screen.getByText(tFromCatalog('auth', 'nativeStart.invalidProvider'))).toBeTruthy();
    expect(getCsrfToken).not.toHaveBeenCalled();
    expect(container.querySelector('form')).toBeNull();
  });

  it.each(['google', 'apple'])('still prepares the supported %s sign-in form', async (provider) => {
    selection.provider = provider;
    const { container } = render(<NativeStartClient />);
    await waitFor(() => expect(getCsrfToken).toHaveBeenCalledOnce());
    expect(container.querySelector('form')?.getAttribute('action')).toBe(`/api/auth/signin/${provider}`);
  });
});
