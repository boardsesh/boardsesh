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
