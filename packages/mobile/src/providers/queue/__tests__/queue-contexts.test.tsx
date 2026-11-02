// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { QueueRestoredContext, QueueSharedSessionContext, useIsCrewSession, useQueueRestored } from '../queue-contexts';

describe('useIsCrewSession', () => {
  it('reads the crew half of the shared-session context', () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        QueueSharedSessionContext.Provider,
        { value: { isSharedSession: false, isCrewSession: true } },
        children,
      );
    const { result } = renderHook(() => useIsCrewSession(), { wrapper });
    expect(result.current).toBe(true);
  });

  it('throws when called outside a provider', () => {
    expect(() => renderHook(() => useIsCrewSession())).toThrow(/useIsCrewSession must be used within QueueProvider/);
  });
});

describe('useQueueRestored', () => {
  it('reads whether the cold-start restore has landed', () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueueRestoredContext.Provider, { value: true }, children);
    const { result } = renderHook(() => useQueueRestored(), { wrapper });
    expect(result.current).toBe(true);
  });

  // No provider, no restore: every change of current stays the climber's own.
  it('reads false outside a provider', () => {
    const { result } = renderHook(() => useQueueRestored());
    expect(result.current).toBe(false);
  });
});
