// @vitest-environment jsdom

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FeatureFlagsProvider } from '../../../../src/providers/feature-flags-provider';
import NewSprayWall from '../new';
import EditSprayWallHolds from '../holds';

const accessState = vi.hoisted(() => ({
  params: {} as {
    returnTo?: string;
    wallUuid?: string | string[];
    boardUuid?: string | string[];
    resetOf?: string | string[];
  },
  posthogFlags: {} as Record<string, boolean>,
  overrides: {} as Record<string, boolean>,
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => accessState.params,
  Redirect: ({ href }: { href: string }) => createElement('div', { 'data-testid': 'redirect' }, href),
}));
vi.mock('../../../../src/lib/analytics', () => ({
  readPosthogFeatureFlags: () => accessState.posthogFlags,
  readPosthogFeatureFlagsRequestId: () => undefined,
  subscribePosthogFeatureFlags: () => () => undefined,
}));
vi.mock('../../../../src/lib/feature-flag-overrides', () => ({
  useFeatureFlagOverrides: () => ({ overrides: accessState.overrides }),
}));
vi.mock('../../../../src/lib/is-dev-build', () => ({ isDevBuild: () => true }));
vi.mock('../../../../src/components/spray-wall/SprayWallWizardScreen', () => ({
  SprayWallWizardScreen: ({ returnTo, resetOfWallUuid }: { returnTo: string; resetOfWallUuid: string | null }) =>
    createElement('div', { 'data-testid': 'wizard', 'data-reset-of': resetOfWallUuid ?? '' }, returnTo),
}));

vi.mock('../../../../src/components/spray-wall/SprayWallHoldsScreen', () => ({
  SprayWallHoldsScreen: ({ wallUuid }: { wallUuid: string }) =>
    createElement('div', { 'data-testid': 'holds' }, wallUuid),
}));

beforeEach(() => {
  accessState.params = {};
  accessState.posthogFlags = {};
  accessState.overrides = {};
});
afterEach(cleanup);

describe('spray-wall access after the rollout flag is retired', () => {
  it.each(['unresolved or unavailable flags', 'stale PostHog disable', 'stale tester override'])(
    'opens both flows immediately with %s',
    (flagCondition) => {
      if (flagCondition === 'stale PostHog disable') accessState.posthogFlags = { 'spray-walls': false };
      if (flagCondition === 'stale tester override') accessState.overrides = { 'spray-walls': false };
      accessState.params = { returnTo: '/(tabs)/discover', wallUuid: 'wall-uuid' };

      render(
        <FeatureFlagsProvider>
          <NewSprayWall />
          <EditSprayWallHolds />
        </FeatureFlagsProvider>,
      );

      expect(screen.getByTestId('wizard').textContent).toBe('/(tabs)/discover');
      expect(screen.getByTestId('holds').textContent).toBe('wall-uuid');
      expect(screen.queryByTestId('redirect')).toBeNull();
    },
  );

  it('opens the wizard as a reset only with a single resetOf wall', () => {
    accessState.params = { resetOf: 'wall-uuid' };
    render(<NewSprayWall />);
    expect(screen.getByTestId('wizard').getAttribute('data-reset-of')).toBe('wall-uuid');
    cleanup();

    accessState.params = { resetOf: ['wall-1', 'wall-2'] };
    render(<NewSprayWall />);
    expect(screen.getByTestId('wizard').getAttribute('data-reset-of')).toBe('');
    cleanup();

    accessState.params = { resetOf: ' ' };
    render(<NewSprayWall />);
    expect(screen.getByTestId('wizard').getAttribute('data-reset-of')).toBe('');
  });

  it('accepts restored hold-editor links using the legacy boardUuid alias', () => {
    accessState.params = { boardUuid: 'legacy-wall' };
    render(<EditSprayWallHolds />);
    expect(screen.getByTestId('holds').textContent).toBe('legacy-wall');
    expect(screen.queryByTestId('redirect')).toBeNull();
  });

  it.each([{}, { wallUuid: '' }, { wallUuid: ['wall-1'] }, { wallUuid: '', boardUuid: 'legacy-wall' }])(
    'returns hold-editor links with missing or ambiguous wall identity to the picker',
    (params) => {
      accessState.params = params;
      render(<EditSprayWallHolds />);
      expect(screen.getAllByTestId('redirect').map((redirect) => redirect.textContent)).toEqual(['/boards']);
      expect(screen.queryByTestId('holds')).toBeNull();
    },
  );
});
