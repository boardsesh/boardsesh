// @vitest-environment jsdom
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ params: {} as { wallUuid?: string | string[]; boardUuid?: string | string[] } }));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => route.params,
  Redirect: ({ href }: { href: string }) => createElement('div', { 'data-testid': 'redirect' }, href),
}));
vi.mock('../../../../src/components/spray-wall/SprayWallHoldsScreen', () => ({
  SprayWallHoldsScreen: ({ wallUuid }: { wallUuid: string }) =>
    createElement('div', { 'data-testid': 'holds-screen' }, wallUuid),
}));

const { default: EditSprayWallHolds } = await import('../holds');

beforeEach(() => {
  route.params = { wallUuid: 'wall-1' };
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
