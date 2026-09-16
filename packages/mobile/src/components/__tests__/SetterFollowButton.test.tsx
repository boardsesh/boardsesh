// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SetterFollowButton } from '../SetterFollowButton';

const mocks = vi.hoisted(() => ({ mutationError: false, snapshotError: false, mutate: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../lib/graphql/hooks/use-followed-authors', () => ({
  useFollowedAuthors: () => ({
    data: mocks.snapshotError ? undefined : {},
    setterNames: new Set(),
    isError: mocks.snapshotError,
  }),
  useToggleAuthorFollow: () => ({ isError: mocks.mutationError, isPending: false, mutate: mocks.mutate }),
}));
vi.mock('../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) => (
    <button onClick={onPress} disabled={disabled}>
      {title}
    </button>
  ),
}));
vi.mock('../Text', () => ({ Text: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
beforeEach(() => {
  mocks.mutationError = false;
  mocks.snapshotError = false;
  mocks.mutate.mockReset();
});

describe('SetterFollowButton errors', () => {
  it('shows follow failure, not sync guidance, when a mutation fails', () => {
    mocks.mutationError = true;
    const screen = render(<SetterFollowButton username="accountless" />);
    expect(screen.getByText('authors.followError')).not.toBeNull();
    expect(screen.queryByText('authors.syncNeeded')).toBeNull();
    expect((screen.getByRole('button', { name: 'authors.follow' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'authors.follow' }));
    expect(mocks.mutate).toHaveBeenCalledWith({ kind: 'setter', identifier: 'accountless', follow: true });
  });
  it('shows sync guidance when the author snapshot fails', () => {
    mocks.snapshotError = true;
    const screen = render(<SetterFollowButton username="accountless" />);
    expect(screen.getByText('authors.syncNeeded')).not.toBeNull();
    expect(screen.queryByText('authors.followError')).toBeNull();
    const followButton = screen.getByRole('button', { name: 'authors.follow' }) as HTMLButtonElement;
    expect(followButton.disabled).toBe(true);
    fireEvent.click(followButton);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
