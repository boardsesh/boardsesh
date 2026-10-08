// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivacySettings } from '@boardsesh/graphql/operations/privacy';
const state = vi.hoisted(() => ({ settings: undefined as PrivacySettings | undefined }));
vi.mock('../../../lib/graphql/hooks/use-privacy', () => ({ usePrivacySettings: () => ({ data: state.settings }) }));
import { usePublicationAudience } from '../use-publication-audience';

beforeEach(() => {
  state.settings = {
    enabled: true,
    isPrivate: true,
    privacyRevision: 4,
    privacyOnboardingVersion: 1,
    defaultSessionAudience: 'followers',
  };
});
describe('publication audience', () => {
  it('defaults private accounts to followers and carries the server revision', () => {
    const { result } = renderHook(() => usePublicationAudience('tick-a'));
    expect(result.current.publication).toEqual({ audience: 'followers', privacyRevision: 4 });
  });
  it('retains the chosen revision so another-device privacy changes cannot republish stale public drafts', () => {
    const { result, rerender } = renderHook(() => usePublicationAudience('tick-a'));
    act(() => result.current.chooseAudience('public'));
    state.settings = { ...state.settings!, privacyRevision: 5 };
    rerender();
    expect(result.current.publication).toEqual({ audience: 'public', privacyRevision: 4 });
    expect(result.current.revisionChanged).toBe(true);
    act(() => result.current.chooseAudience('public'));
    expect(result.current.revisionChanged).toBe(false);
    expect(result.current.publication).toEqual({ audience: 'public', privacyRevision: 5 });
  });
  it('does not carry a public choice to a different climb', () => {
    const { result, rerender } = renderHook(({ id }) => usePublicationAudience(id), { initialProps: { id: 'tick-a' } });
    act(() => result.current.chooseAudience('public'));
    rerender({ id: 'tick-b' });
    expect(result.current.audience).toBe('followers');
  });
  it('clears the previous publication choice when a sheet closes', () => {
    const { result, rerender } = renderHook(({ open }) => usePublicationAudience('beta', open), {
      initialProps: { open: true },
    });
    act(() => result.current.chooseAudience('public'));
    rerender({ open: false });
    rerender({ open: true });
    expect(result.current.audience).toBe('followers');
  });
  it('hides controls and omits publication when server enforcement is unavailable', () => {
    state.settings = undefined;
    const { result } = renderHook(() => usePublicationAudience('tick-a'));
    expect(result.current.enabled).toBe(false);
    expect(result.current.publication).toBeUndefined();
  });
});
