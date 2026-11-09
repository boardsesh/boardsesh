// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { SetterFollowButton } from '../SetterFollowButton';

const mocks = vi.hoisted(() => ({
  isAuthenticated: true,
  snapshotError: false,
  snapshotLoading: false,
  isFetching: false,
  following: false,
  toggleStatus: 'idle' as 'idle' | 'pending' | 'success',
  variables: undefined as { follow: boolean } | undefined,
  mutate: vi.fn(),
  reset: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: mocks.isAuthenticated }),
}));
vi.mock('../../providers/toast-provider', () => ({ useToast: () => ({ showToast: mocks.showToast }) }));
vi.mock('../../lib/graphql/hooks/use-followed-authors', () => ({
  useFollowedAuthors: () => ({
    data: mocks.snapshotError || mocks.snapshotLoading ? undefined : {},
    setterNames: new Set(mocks.following ? ['accountless'] : []),
    isError: mocks.snapshotError,
    isFetching: mocks.isFetching,
  }),
  useToggleAuthorFollow: () => ({
    isPending: mocks.toggleStatus === 'pending',
    isSuccess: mocks.toggleStatus === 'success',
    variables: mocks.variables,
    mutate: mocks.mutate,
    reset: mocks.reset,
  }),
}));
vi.mock('../FollowIconButton', () => ({
  FollowIconButton: ({
    isFollowing,
    onToggle,
    disabled,
  }: {
    isFollowing: boolean;
    onToggle: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onToggle} disabled={disabled}>
      {isFollowing ? 'following' : 'follow'}
    </button>
  ),
}));

beforeEach(() => {
  mocks.isAuthenticated = true;
  mocks.snapshotError = false;
  mocks.snapshotLoading = false;
  mocks.isFetching = false;
  mocks.following = false;
  mocks.toggleStatus = 'idle';
  mocks.variables = undefined;
  mocks.mutate.mockReset();
  mocks.reset.mockReset();
  mocks.showToast.mockReset();
});

describe('SetterFollowButton', () => {
  it('renders nothing signed out', () => {
    mocks.isAuthenticated = false;
    const { container } = render(<SetterFollowButton username="accountless" />);
    expect(container.childElementCount).toBe(0);
  });

  it('follows on a tap', () => {
    const { getByRole } = render(<SetterFollowButton username="accountless" />);
    fireEvent.click(getByRole('button'));
    expect(mocks.mutate.mock.calls[0]?.[0]).toEqual({ kind: 'setter', identifier: 'accountless', follow: true });
  });

  it('shows the tapped state, disabled, while the follow is saving', () => {
    mocks.toggleStatus = 'pending';
    mocks.variables = { follow: true };
    const { getByRole } = render(<SetterFollowButton username="accountless" />);
    const button = getByRole('button') as HTMLButtonElement;
    expect(button.textContent).toBe('following');
    expect(button.disabled).toBe(true);
  });

  it('holds the tapped state through the refetch after a save', () => {
    mocks.toggleStatus = 'success';
    mocks.variables = { follow: true };
    mocks.isFetching = true;
    const { getByRole } = render(<SetterFollowButton username="accountless" />);
    expect(getByRole('button').textContent).toBe('following');
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it('forgets the tap once the refetch lands, so later refetches show the stored state', () => {
    mocks.toggleStatus = 'success';
    mocks.variables = { follow: true };
    render(<SetterFollowButton username="accountless" />);
    expect(mocks.reset).toHaveBeenCalledTimes(1);
  });

  it('goes back to the stored state once a failed save settles', () => {
    mocks.variables = { follow: true };
    const { getByRole } = render(<SetterFollowButton username="accountless" />);
    expect(getByRole('button').textContent).toBe('follow');
  });

  it('toasts a failed follow, and only that', () => {
    const { getByRole } = render(<SetterFollowButton username="accountless" />);
    fireEvent.click(getByRole('button'));
    const options = mocks.mutate.mock.calls[0]?.[1] as { onError: () => void };
    expect(mocks.showToast).not.toHaveBeenCalled();
    options.onError();
    expect(mocks.showToast).toHaveBeenCalledWith('authors.followError', 'error');
  });

  it('explains the missing follow list on a tap instead of a dead button', () => {
    mocks.snapshotError = true;
    const { getByRole } = render(<SetterFollowButton username="accountless" />);
    const button = getByRole('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(mocks.showToast).toHaveBeenCalledWith('authors.syncNeeded', 'error');
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('waits for the first follow list to load', () => {
    mocks.snapshotLoading = true;
    const { getByRole } = render(<SetterFollowButton username="accountless" />);
    expect((getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
