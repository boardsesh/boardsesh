// @vitest-environment jsdom
//
// A board in a public gym is shown at the gym's location to anyone its own
// location is hidden from. When that public gym is the climber's own, its
// listing can be their home, so the owner is warned and pointed at the gym's
// settings. A synced or someone else's gym never warns.
import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gymState = vi.hoisted(() => ({ gym: null as null | Record<string, unknown> }));
const push = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({ View: 'div', StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => (values?.name ? `${key}:${values.name}` : key),
  }),
}));
vi.mock('../../../lib/routing/scoped-navigation', () => ({ scopedRouter: { push } }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ spacing: [0, 4, 8, 12] }) }));
vi.mock('../../Text', () => ({ Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) => (
    <button type="button" onClick={onPress}>
      {title}
    </button>
  ),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: 'owner-id' } }),
  useGym: (gymUuid: string | null) => ({ data: gymUuid ? gymState.gym : undefined }),
}));

import { OwnPublicGymWarning } from '../OwnPublicGymWarning';

const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
const gym = (overrides: Record<string, unknown>) => ({
  uuid: 'gym-uuid',
  name: 'My Garage',
  isPublic: true,
  ownerId: 'owner-id',
  ...overrides,
});

beforeEach(() => {
  push.mockReset();
  gymState.gym = null;
});

describe('OwnPublicGymWarning', () => {
  it("warns the owner that their own public gym shows its location, and opens the gym's settings", () => {
    gymState.gym = gym({});
    const view = render(<OwnPublicGymWarning gymUuid="gym-uuid" />);

    expect(view.getByText('mobile.publicGymWarning.message:My Garage')).toBeTruthy();
    fireEvent.click(view.getByText('mobile.publicGymWarning.openSettings'));
    expect(push).toHaveBeenCalledWith({ pathname: '/gyms/edit', params: { gymUuid: 'gym-uuid' } });
  });

  it.each([
    ['a synced gym', { ownerId: SYSTEM_OWNER, name: 'Boulder Central' }],
    ["someone else's public gym", { ownerId: 'someone-else' }],
    ['their own private gym', { isPublic: false }],
  ])('says nothing for %s', (_label, overrides) => {
    gymState.gym = gym(overrides);
    const view = render(<OwnPublicGymWarning gymUuid="gym-uuid" />);
    expect(view.queryByText(/mobile\.publicGymWarning/)).toBeNull();
  });

  it('says nothing for a board with no gym', () => {
    gymState.gym = gym({});
    const view = render(<OwnPublicGymWarning gymUuid={null} />);
    expect(view.queryByText(/mobile\.publicGymWarning/)).toBeNull();
  });
});
