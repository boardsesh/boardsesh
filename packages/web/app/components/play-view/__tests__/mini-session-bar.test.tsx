// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vite-plus/test';
import React from 'react';
import { render, screen } from '@testing-library/react';
import type { SessionUser } from '@boardsesh/shared-schema';
import { MiniSessionBar } from '../mini-session-bar';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { ClimbQueueItem } from '../../queue-control/types';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('@mui/icons-material/CheckOutlined', () => ({
  default: () => React.createElement('svg', { 'data-testid': 'icon-check' }),
}));

const user = (id: string, username: string, overrides: Partial<SessionUser> = {}): SessionUser =>
  ({
    id,
    username,
    isLeader: false,
    connectionState: 'connected',
    ...overrides,
  }) as SessionUser;

const climbItem = (uuid: string, name: string): ClimbQueueItem =>
  ({
    uuid: `q-${uuid}`,
    suggested: false,
    climb: {
      uuid,
      name,
      tickedBy: [],
    },
  }) as unknown as ClimbQueueItem;

function defaultProps(overrides: Partial<React.ComponentProps<typeof MiniSessionBar>> = {}) {
  return {
    isPersistentSessionActive: true,
    sessionUsers: [user('me', 'me'), user('marco', 'Marco'), user('sara', 'Sara')],
    participantId: 'me',
    currentClimbQueueItem: climbItem('wall-uuid', 'Bone Saw'),
    ...overrides,
  } satisfies React.ComponentProps<typeof MiniSessionBar>;
}

describe('MiniSessionBar (always-live audience indicator)', () => {
  it('renders nothing for solo users (isPersistentSessionActive=false)', () => {
    const { container } = render(<MiniSessionBar {...defaultProps({ isPersistentSessionActive: false })} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('mini-session-bar')).toBeNull();
  });

  it('renders nothing when there is no wall climb yet', () => {
    const { container } = render(<MiniSessionBar {...defaultProps({ currentClimbQueueItem: null })} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders an audience AvatarGroup excluding the local user', () => {
    render(
      <MiniSessionBar
        {...defaultProps({
          sessionUsers: [user('me', 'me'), user('sara', 'Sara'), user('jules', 'Jules'), user('marco', 'Marco')],
          participantId: 'me',
        })}
      />,
    );
    expect(screen.getByTestId('mini-session-bar')).toBeTruthy();
    const audience = screen.getByTestId('mini-session-bar-audience');
    expect(audience).toBeTruthy();
    // Audience text reflects the count (excludes self → 3 others).
    expect(screen.getByText('3 others watching')).toBeTruthy();
    const avatars = audience.querySelectorAll('.MuiAvatar-root');
    expect(avatars.length).toBeGreaterThan(0);
  });

  it('renders nothing when the session has only the local user (no audience)', () => {
    const { container } = render(
      <MiniSessionBar
        {...defaultProps({
          sessionUsers: [user('me', 'me')],
        })}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('mini-session-bar-audience')).toBeNull();
  });
});
