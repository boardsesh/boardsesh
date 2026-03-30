import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { SSRInitialClimbsProvider, useSSRInitialClimbs } from '../ssr-initial-climbs-context';
import type { Climb } from '@/app/lib/types';

const mockClimb: Climb = {
  uuid: 'climb-1',
  setter_username: 'setter1',
  name: 'Test Climb',
  description: 'A test climb',
  frames: '',
  angle: 40,
  ascensionist_count: 5,
  difficulty: '7',
  quality_average: '3.5',
  stars: 3,
  difficulty_error: '',
  mirrored: false,
  benchmark_difficulty: null,
  userAscents: 0,
  userAttempts: 0,
};

const mockClimb2: Climb = {
  ...mockClimb,
  uuid: 'climb-2',
  name: 'Test Climb 2',
};

describe('SSRInitialClimbsContext', () => {
  describe('useSSRInitialClimbs', () => {
    it('returns null when no provider wraps it', () => {
      const { result } = renderHook(() => useSSRInitialClimbs());
      expect(result.current).toBeNull();
    });

    it('returns climbs and hasMore when provider supplies data', () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <SSRInitialClimbsProvider initialClimbs={[mockClimb, mockClimb2]} hasMore={true}>
          {children}
        </SSRInitialClimbsProvider>
      );

      const { result } = renderHook(() => useSSRInitialClimbs(), { wrapper });
      expect(result.current).toEqual({
        climbs: [mockClimb, mockClimb2],
        hasMore: true,
      });
    });

    it('returns null when provider supplies empty climbs array', () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <SSRInitialClimbsProvider initialClimbs={[]} hasMore={false}>
          {children}
        </SSRInitialClimbsProvider>
      );

      const { result } = renderHook(() => useSSRInitialClimbs(), { wrapper });
      expect(result.current).toBeNull();
    });

    it('returns hasMore=false when no more results', () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <SSRInitialClimbsProvider initialClimbs={[mockClimb]} hasMore={false}>
          {children}
        </SSRInitialClimbsProvider>
      );

      const { result } = renderHook(() => useSSRInitialClimbs(), { wrapper });
      expect(result.current).toEqual({
        climbs: [mockClimb],
        hasMore: false,
      });
    });

    it('memoizes the value when props are the same reference', () => {
      const climbs = [mockClimb];
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <SSRInitialClimbsProvider initialClimbs={climbs} hasMore={true}>
          {children}
        </SSRInitialClimbsProvider>
      );

      const { result, rerender } = renderHook(() => useSSRInitialClimbs(), { wrapper });
      const firstValue = result.current;
      rerender();
      expect(result.current).toBe(firstValue);
    });
  });
});
