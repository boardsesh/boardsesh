// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('../../lib/env', () => ({
  BACKEND_URL: 'https://ws.boardsesh.com',
  WEB_BASE_URL: 'https://www.boardsesh.com',
}));

import {
  ConnectionSettingsProvider,
  useConnectionSettings,
  useBackendUrl,
} from '../connection-settings-provider';

describe('ConnectionSettingsProvider', () => {
  it('exposes the env-derived backendUrl through useConnectionSettings', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ConnectionSettingsProvider>{children}</ConnectionSettingsProvider>
    );
    const { result } = renderHook(() => useConnectionSettings(), { wrapper });
    expect(result.current.backendUrl).toBe('https://ws.boardsesh.com');
  });

  it('useBackendUrl returns the same backendUrl', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ConnectionSettingsProvider>{children}</ConnectionSettingsProvider>
    );
    const { result } = renderHook(() => useBackendUrl(), { wrapper });
    expect(result.current).toEqual({ backendUrl: 'https://ws.boardsesh.com' });
  });

  it('useConnectionSettings throws when called outside a provider', () => {
    expect(() => renderHook(() => useConnectionSettings())).toThrow(
      /must be used within a ConnectionSettingsProvider/,
    );
  });
});

// Separate suite with BACKEND_URL mocked to null, exercising the `string | null`
// half of the contract. The provider reads BACKEND_URL once at module load, so
// the mock has to be set BEFORE the dynamic import.
describe('ConnectionSettingsProvider with null BACKEND_URL', () => {
  it('exposes backendUrl as null when the env constant resolves to null', async () => {
    vi.resetModules();
    vi.doMock('../../lib/env', () => ({
      BACKEND_URL: null,
      WEB_BASE_URL: 'https://www.boardsesh.com',
    }));
    const mod = await import('../connection-settings-provider');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <mod.ConnectionSettingsProvider>{children}</mod.ConnectionSettingsProvider>
    );
    const { result } = renderHook(() => mod.useConnectionSettings(), { wrapper });
    expect(result.current.backendUrl).toBeNull();
    vi.doUnmock('../../lib/env');
  });
});
