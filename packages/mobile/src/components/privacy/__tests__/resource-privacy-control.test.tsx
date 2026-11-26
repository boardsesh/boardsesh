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
const push = vi.hoisted(() => vi.fn());
const gym = vi.hoisted(() => ({ current: undefined as undefined | null | Record<string, unknown> }));

vi.mock('react-native', () => ({ View: 'div', StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../lib/routing/scoped-navigation', () => ({ scopedRouter: { push } }));
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
// A checkbox stand-in, so a test can flip "Show to friends".
vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({
    label,
    description,
    value,
    onValueChange,
  }: {
    label: string;
    description?: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <label>
      <input
        type="checkbox"
        aria-label={label}
        checked={value}
        onChange={(event) => onValueChange(event.currentTarget.checked)}
      />
      {description ? <span>{description}</span> : null}
    </label>
  ),
}));
vi.mock('../AudiencePicker', () => ({
  AudiencePicker: ({ onChange }: { onChange: (audience: string) => void }) => (
    <button type="button" onClick={() => onChange('invite_only')}>
      audience:invite_only
    </button>
  ),
  BOARD_AUDIENCES: [],
  SESSION_AUDIENCES: [],
}));
vi.mock('../../../lib/graphql/hooks/use-resource-privacy', () => ({
  useResourcePrivacy: () => ({ data: privacy.current }),
  useUpdateResourcePrivacy: () => ({ mutate, isPending: false, isError: false }),
}));
vi.mock('../../../lib/graphql/hooks/use-privacy', () => ({
  usePrivacySettings: () => ({ data: { enabled: true, isPrivate: false } }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: 'owner-id' } }),
  useGym: () => ({ data: gym.current }),
}));
vi.mock('../../board-discovery/OwnPublicGymWarning', () => ({
  OwnPublicGymWarning: ({ gymUuid }: { gymUuid?: string | null }) => <span>{`warning:${gymUuid ?? 'none'}`}</span>,
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({ useConnectivity: () => ({ effectiveOffline: false }) }));

import { ResourcePrivacyControl } from '../ResourcePrivacyControl';
import { GymRouteStackContext } from '../../gym-page/use-gym-route-stack';

const boardPrivacy = (overrides: Record<string, unknown> = {}) => ({
  kind: 'board',
  resourceId: 'board-uuid',
  ownerId: 'owner-id',
  audience: 'public',
  locationAudience: 'public',
  inheritFollowers: false,
  listedToFollowers: false,
  revision: 1,
  ...overrides,
});

beforeEach(() => {
  mutate.mockReset();
  push.mockReset();
  privacy.current = null;
  gym.current = undefined;
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

// Edit board stands in the board picker's stack, where the root Manage access
// pushed on top would be presented as a second sheet.
describe('ResourcePrivacyControl Manage access', () => {
  it("opens the picker's copy from Edit board", () => {
    privacy.current = boardPrivacy();
    const view = render(
      <GymRouteStackContext.Provider value="boards">
        <ResourcePrivacyControl kind="board" resourceId="board-uuid" />
      </GymRouteStackContext.Provider>,
    );
    fireEvent.click(view.getByText('privacy.manageAccess'));
    expect(push).toHaveBeenCalledWith({
      pathname: '/boards/privacy-access',
      params: { kind: 'board', resourceId: 'board-uuid' },
    });
  });

  it("opens Settings' copy everywhere else", () => {
    privacy.current = boardPrivacy();
    const view = render(<ResourcePrivacyControl kind="session" resourceId="session-uuid" />);
    fireEvent.click(view.getByText('privacy.manageAccess'));
    expect(push).toHaveBeenCalledWith({
      pathname: '/settings/privacy-access',
      params: { kind: 'session', resourceId: 'session-uuid' },
    });
  });
});

describe('ResourcePrivacyControl "Show to friends"', () => {
  it('sends no listedToFollowers when the audience changes', () => {
    privacy.current = boardPrivacy({ audience: 'unlisted', listedToFollowers: true });
    const view = render(<ResourcePrivacyControl kind="board" resourceId="board-uuid" />);
    fireEvent.click(view.getByText('audience:invite_only'));
    expect(mutate).toHaveBeenCalledWith({ kind: 'board', resourceId: 'board-uuid', audience: 'invite_only' });
    expect(mutate.mock.calls[0][0]).not.toHaveProperty('listedToFollowers');
  });

  it('sends listedToFollowers with the current audience when flipped', () => {
    privacy.current = boardPrivacy({ audience: 'invite_only' });
    const view = render(<ResourcePrivacyControl kind="board" resourceId="board-uuid" />);
    expect(view.getByText('privacy.listedToFollowersInviteHint')).toBeTruthy();
    fireEvent.click(view.getByLabelText('privacy.listedToFollowers'));
    expect(mutate).toHaveBeenCalledWith({
      kind: 'board',
      resourceId: 'board-uuid',
      audience: 'invite_only',
      listedToFollowers: true,
    });
  });

  it('says friends can climb on an Unlisted board', () => {
    privacy.current = boardPrivacy({ audience: 'unlisted' });
    const view = render(<ResourcePrivacyControl kind="board" resourceId="board-uuid" />);
    expect(view.getByText('privacy.listedToFollowersUnlistedHint')).toBeTruthy();
  });

  it('hides the switch on a Public board and at a public listed gym', () => {
    privacy.current = boardPrivacy();
    const publicBoard = render(<ResourcePrivacyControl kind="board" resourceId="board-uuid" />);
    expect(publicBoard.queryByLabelText('privacy.listedToFollowers')).toBeNull();
    publicBoard.unmount();

    privacy.current = boardPrivacy({ audience: 'unlisted' });
    gym.current = { ownerId: 'owner-id', isPublic: true, isListed: true };
    const atGym = render(<ResourcePrivacyControl kind="board" resourceId="board-uuid" gymUuid="gym-uuid" />);
    expect(atGym.queryByLabelText('privacy.listedToFollowers')).toBeNull();
  });

  it("shows it at the owner's own private gym", () => {
    privacy.current = boardPrivacy({ audience: 'unlisted' });
    gym.current = { ownerId: 'owner-id', isPublic: false, isListed: false };
    const view = render(<ResourcePrivacyControl kind="board" resourceId="board-uuid" gymUuid="gym-uuid" />);
    expect(view.getByLabelText('privacy.listedToFollowers')).toBeTruthy();
  });
});
