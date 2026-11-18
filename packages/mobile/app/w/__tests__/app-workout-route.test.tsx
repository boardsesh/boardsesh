// @vitest-environment jsdom
import { createElement } from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { AppWorkout } from '../../../src/lib/pending-workout-store';

const state = vi.hoisted(() => ({
  authenticated: true,
  enabled: true,
  consent: true,
  sessionId: null as string | null,
  answer: null as AppWorkout | null,
  error: null as unknown,
}));
const { replace, signOut, setItem } = vi.hoisted(() => ({
  replace: vi.fn(),
  signOut: vi.fn(async () => {}),
  setItem: vi.fn(async () => {}),
}));
vi.mock('react-native', () => ({ View: 'div', StyleSheet: { create: (styles: unknown) => styles } }));
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ workoutId: 'wk_link' }),
  useRouter: () => ({ replace }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: state.answer, error: state.error, isError: state.error !== null, refetch: vi.fn() }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { setItem } }));
vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: state.authenticated, signOut }),
}));
vi.mock('../../../src/providers/feature-flags-provider', () => ({ useAppWorkoutsFlag: () => state.enabled }));
vi.mock('../../../src/providers/queue-provider', () => ({ useQueueSessionId: () => ({ sessionId: state.sessionId }) }));
vi.mock('../../../src/lib/graphql/client', () => ({ getHttpClient: vi.fn() }));
vi.mock('../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: { boardType: 'kilter' } }),
}));
vi.mock('../../../src/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../src/lib/consent-hooks', () => ({ useConsentSettled: () => state.consent }));
vi.mock('../../../src/components/Text', () => ({
  Text: ({ children }: { children: string }) => createElement('span', null, children),
}));
vi.mock('../../../src/components/Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../../src/components/ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../src/lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../../src/theme/tokens', () => ({ spacing: { 4: 16 } }));

import AppWorkoutRoute from '../[workoutId]';
import { getPendingWorkout, resetPendingWorkoutStore } from '../../../src/lib/pending-workout-store';

const workout: AppWorkout = {
  id: 'wk_link',
  clientId: 'app_planner',
  title: 'Private workout',
  sourceAppName: 'Planner',
  status: 'opened',
  notes: 'Private note',
  expiresAt: '2026-12-01T00:00:00Z',
  spec: { title: 'Private workout', externalRef: 'private', blocks: [{ type: 'freeClimbing' }] },
};
beforeEach(() => {
  Object.assign(state, {
    authenticated: true,
    enabled: true,
    consent: true,
    sessionId: null,
    answer: null,
    error: null,
  });
  vi.clearAllMocks();
  resetPendingWorkoutStore();
});

describe('partner workout route', () => {
  it('does not redirect signed-out climbers to sign-in when workouts are disabled', () => {
    state.authenticated = false;
    state.enabled = false;
    const view = render(createElement(AppWorkoutRoute));
    expect(view.getByText('partnerWorkouts.unavailable')).toBeTruthy();
    expect(setItem).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
  it('does not publish cached workout content while the feature is disabled', () => {
    state.enabled = false;
    state.answer = workout;
    render(createElement(AppWorkoutRoute));
    expect(getPendingWorkout()).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('offers an ordinary authenticated join for a started workout on another local session', () => {
    state.answer = { ...workout, status: 'started', sessionId: 'remote-session' };
    state.sessionId = 'another-session';
    const view = render(createElement(AppWorkoutRoute));
    expect(getPendingWorkout()).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(view.getByText('partnerWorkouts.resume'));
    expect(replace).toHaveBeenCalledWith({ pathname: '/join/[sessionId]', params: { sessionId: 'remote-session' } });
    expect(getPendingWorkout()).toBeNull();
  });
  it('stashes a signed-out destination before opening sign-in', async () => {
    state.authenticated = false;
    render(createElement(AppWorkoutRoute));
    await waitFor(() => expect(setItem).toHaveBeenCalledWith('boardsesh_pending_app_workout_id', 'wk_link'));
    expect(replace).toHaveBeenCalledWith('/auth/login');
  });

  it('waits for consent before publishing private workout content', () => {
    state.answer = workout;
    state.consent = false;
    const view = render(createElement(AppWorkoutRoute));
    expect(getPendingWorkout()).toBeNull();
    state.consent = true;
    view.rerender(createElement(AppWorkoutRoute));
    expect(getPendingWorkout()).toEqual(workout);
    expect(replace).toHaveBeenCalledWith('/(tabs)/record');
  });

  it('shows no target identity on mismatch and preserves the link while switching account', async () => {
    state.error = {
      response: {
        errors: [
          {
            message: 'Do not show backend text',
            extensions: { code: 'FORBIDDEN', reason: 'APP_WORKOUT_ACCOUNT_MISMATCH' },
          },
        ],
      },
    };
    const view = render(createElement(AppWorkoutRoute));
    expect(view.getByText('partnerWorkouts.wrongAccount')).toBeTruthy();
    expect(view.queryByText('Do not show backend text')).toBeNull();
    fireEvent.click(view.getByText('partnerWorkouts.switchAccount'));
    await waitFor(() => expect(signOut).toHaveBeenCalled());
    expect(setItem).toHaveBeenCalledWith('boardsesh_pending_app_workout_id', 'wk_link');
    expect(getPendingWorkout()).toBeNull();
  });
});
