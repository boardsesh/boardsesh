// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePrivacyScopedState } from '../use-privacy-scoped-state';
import { invalidatePrivacySnapshots } from '../../lib/privacy/privacy-cache';

describe('copied view snapshots', () => {
  it('withdraws retained drawer and animation content immediately', () => {
    const { result } = renderHook(() => usePrivacyScopedState({ name: 'Private climb', frames: 'secret' }));
    expect(result.current[0]?.name).toBe('Private climb');
    act(() => invalidatePrivacySnapshots());
    expect(result.current[0]).toBeNull();
  });

  it('rejects a stale callback before React renders the new privacy generation', () => {
    const { result } = renderHook(() => usePrivacyScopedState<{ name: string }>());
    const staleSetter = result.current[1];
    act(() => {
      invalidatePrivacySnapshots();
      staleSetter({ name: 'Late private response' });
    });
    expect(result.current[0]).toBeNull();
    act(() => staleSetter({ name: 'Still stale after rerender' }));
    expect(result.current[0]).toBeNull();
    act(() => result.current[1]({ name: 'Fresh authorized selection' }));
    expect(result.current[0]?.name).toBe('Fresh authorized selection');
  });

  it('does not let a stale functional update recover the previous snapshot', () => {
    const { result } = renderHook(() => usePrivacyScopedState({ name: 'Previous account' }));
    const staleSetter = result.current[1];
    act(() => invalidatePrivacySnapshots());
    act(() => staleSetter((previous) => previous ?? { name: 'Captured response' }));
    expect(result.current[0]).toBeNull();
  });

  it('preserves only target references for a composer until the credential changes', () => {
    const withdraw = (target: { uuid: string; name: string }) => ({ uuid: target.uuid, name: '' });
    const { result } = renderHook(() => usePrivacyScopedState({ uuid: 'target', name: 'Private climb' }, withdraw));
    act(() => invalidatePrivacySnapshots());
    expect(result.current[0]).toEqual({ uuid: 'target', name: '' });
    act(() => invalidatePrivacySnapshots('credential'));
    expect(result.current[0]).toBeNull();
  });
});
