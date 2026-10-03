// @vitest-environment jsdom
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({
  params: {} as {
    wallUuid?: string | string[];
    boardUuid?: string | string[];
    versionId?: string | string[];
    returnTo?: string;
  },
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => route.params,
  Redirect: ({ href }: { href: string }) => createElement('div', { 'data-testid': 'redirect' }, href),
}));
vi.mock('../../../../src/components/spray-wall/SprayWallHoldsScreen', () => ({
  SprayWallHoldsScreen: ({ wallUuid }: { wallUuid: string }) =>
    createElement('div', { 'data-testid': 'holds-screen' }, wallUuid),
}));
vi.mock('../../../../src/components/spray-wall/SprayWallResetScreen', () => ({
  SprayWallResetScreen: (props: { wallUuid: string; versionId?: string }) =>
    createElement('div', { 'data-testid': 'reset-screen' }, JSON.stringify(props)),
}));
vi.mock('../../../../src/components/spray-wall/SprayWallWizardScreen', () => ({
  SprayWallWizardScreen: (props: { wallUuid?: string; versionId?: string; returnTo: string }) =>
    createElement('div', { 'data-testid': 'wizard-screen' }, JSON.stringify(props)),
}));

const { default: EditSprayWallHolds } = await import('../holds');
const { default: ResetSprayWall } = await import('../reset');
const { default: NewSprayWall } = await import('../new');

beforeEach(() => {
  route.params = { wallUuid: 'wall-1' };
});

describe('/boards/spray/reset completion routes', () => {
  it.each(['version-2', ['version-2', 'ignored-version']])(
    'preserves the completion version target %j',
    (versionId) => {
      route.params = { wallUuid: 'wall-1', versionId };
      render(createElement(ResetSprayWall));
      expect(JSON.parse(screen.getByTestId('reset-screen').textContent!)).toEqual({
        wallUuid: 'wall-1',
        versionId: 'version-2',
      });
    },
  );

  it('preserves legacy wall identity with the exact completion version', () => {
    route.params = { boardUuid: 'legacy-wall', versionId: 'version-3' };
    render(createElement(ResetSprayWall));
    expect(JSON.parse(screen.getByTestId('reset-screen').textContent!)).toEqual({
      wallUuid: 'legacy-wall',
      versionId: 'version-3',
    });
  });

  it('rejects missing wall identity before mounting a completion target', () => {
    route.params = { versionId: 'version-2' };
    render(createElement(ResetSprayWall));
    expect(screen.getByTestId('redirect').textContent).toBe('/boards');
    expect(screen.queryByTestId('reset-screen')).toBeNull();
  });
});

describe('/boards/spray/new completion routes', () => {
  it('carries the exact import target and originating tab into the wizard', () => {
    route.params = { wallUuid: 'wall-1', versionId: 'version-1', returnTo: '/(tabs)/record' };
    render(createElement(NewSprayWall));
    expect(JSON.parse(screen.getByTestId('wizard-screen').textContent!)).toEqual({
      wallUuid: 'wall-1',
      versionId: 'version-1',
      returnTo: '/(tabs)/record',
    });
  });

  it('defaults notification imports to Climbs when no originating tab is supplied', () => {
    route.params = { wallUuid: 'wall-1', versionId: 'version-1' };
    render(createElement(NewSprayWall));
    expect(JSON.parse(screen.getByTestId('wizard-screen').textContent!).returnTo).toBe('/(tabs)/climbs');
  });
});

describe('/boards/spray/holds', () => {
  it('mounts the standalone editor host for the requested wall', () => {
    render(createElement(EditSprayWallHolds));
    expect(screen.getByTestId('holds-screen').textContent).toBe('wall-1');
  });

  it('accepts the legacy boardUuid link parameter', () => {
    route.params = { boardUuid: 'legacy-wall' };
    render(createElement(EditSprayWallHolds));
    expect(screen.getByTestId('holds-screen').textContent).toBe('legacy-wall');
  });

  it.each([{}, { wallUuid: '' }, { wallUuid: ['wall-1'] }, { wallUuid: '', boardUuid: 'legacy-wall' }])(
    'redirects missing or ambiguous wall identity without adopting another parameter',
    (params) => {
      route.params = params;
      render(createElement(EditSprayWallHolds));
      expect(screen.getByTestId('redirect').textContent).toBe('/boards');
      expect(screen.queryByTestId('holds-screen')).toBeNull();
    },
  );
});
