// @vitest-environment jsdom
//
// The location choice always governs the board's own place, at a gym or not.
// At a gym the control says what others see instead (the public gym's listed
// location) and carries the own-public-gym warning; it never locks.
import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const privacy = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}));
const mutate = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({ View: 'div', StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../lib/routing/scoped-navigation', () => ({ scopedRouter: { push: vi.fn() } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ spacing: [0, 4, 8, 12], brandColors: { error: 'red' } }),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress?: () => void; disabled?: boolean }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {title}
    </button>
  ),
}));
vi.mock('../../SwitchRow', () => ({ SwitchRow: () => null }));
vi.mock('../AudiencePicker', () => ({ AudiencePicker: () => null, BOARD_AUDIENCES: [], SESSION_AUDIENCES: [] }));
vi.mock('../../../lib/graphql/hooks/use-resource-privacy', () => ({
  useResourcePrivacy: () => ({ data: privacy.current }),
  useUpdateResourcePrivacy: () => ({ mutate, isPending: false, isError: false }),
}));
vi.mock('../../../lib/graphql/hooks/use-privacy', () => ({
  usePrivacySettings: () => ({ data: { enabled: true, isPrivate: false } }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({ useProfile: () => ({ data: { id: 'owner-id' } }) }));
vi.mock('../../board-discovery/OwnPublicGymWarning', () => ({
  OwnPublicGymWarning: ({ gymUuid }: { gymUuid?: string | null }) => <span>{`warning:${gymUuid ?? 'none'}`}</span>,
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({ useConnectivity: () => ({ effectiveOffline: false }) }));

import { ResourcePrivacyControl } from '../ResourcePrivacyControl';

const boardPrivacy = (overrides: Record<string, unknown> = {}) => ({
  kind: 'board',
  resourceId: 'board-uuid',
  ownerId: 'owner-id',
  audience: 'public',
  locationAudience: 'public',
  inheritFollowers: false,
  revision: 1,
  ...overrides,
});

beforeEach(() => {
  mutate.mockReset();
  privacy.current = null;
});

describe('ResourcePrivacyControl board location', () => {
  it('keeps the location choice editable at a gym, says what others see, and carries the gym warning', () => {
    privacy.current = boardPrivacy();
    const view = render(<ResourcePrivacyControl kind="board" resourceId="board-uuid" gymUuid="gym-uuid" />);

    expect(view.getByText('mobile.create.gymLocationHint')).toBeTruthy();
    expect(view.getByText('warning:gym-uuid')).toBeTruthy();
    const onlyMe = view.getByText('privacy.audiences.onlyMe') as HTMLButtonElement;
    expect(onlyMe.disabled).toBe(false);
    fireEvent.click(onlyMe);
    expect(mutate).toHaveBeenCalledWith({
      kind: 'board',
      resourceId: 'board-uuid',
      audience: 'public',
      locationAudience: 'only_me',
    });
  });

  it('shows no gym hint for a board with no gym', () => {
    privacy.current = boardPrivacy();
    const view = render(<ResourcePrivacyControl kind="board" resourceId="board-uuid" />);
    expect(view.queryByText('mobile.create.gymLocationHint')).toBeNull();
  });
});
