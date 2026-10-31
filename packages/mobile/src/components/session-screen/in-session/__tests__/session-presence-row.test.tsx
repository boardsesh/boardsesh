// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@boardsesh/shared-schema';
import { SessionPresenceRow } from '../SessionPresenceRow';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (colors: { light: string }) => colors.light,
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options: { count: number }) => `${options.count} climbing`,
  }),
}));
vi.mock('../../../Text', () => ({
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('span', { 'data-testid': testID }, children),
}));
vi.mock('../../../you/AvatarGroup', () => ({
  AvatarGroup: ({ participants }: { participants: Array<{ userId?: string; testID?: string }> }) =>
    createElement(
      'div',
      null,
      participants.map((participant) =>
        createElement('button', { key: participant.userId, 'data-testid': participant.testID }),
      ),
    ),
}));

const sessionId = '11111111-2222-4333-8444-555555555555';
function user(userId: string, connectionState: SessionUser['connectionState'] = 'CONNECTED'): SessionUser {
  return { id: `connection-${userId}`, userId, username: userId, isLeader: false, connectionState };
}

describe('visible session presence identity', () => {
  it('puts the real session and deduplicated count on the existing text leaf while keeping roster and avatar identifiers', () => {
    const first = user('holder');
    const { getByTestId } = render(
      <SessionPresenceRow
        sessionId={sessionId}
        users={[first, { ...first, id: 'reconnected-holder' }, user('peer')]}
      />,
    );
    const count = getByTestId(`session-presence-${sessionId}-2`);
    expect(count.tagName).toBe('SPAN');
    expect(count.textContent).toBe('2 climbing');
    expect(getByTestId('session-roster-2').tagName).toBe('DIV');
    expect(getByTestId('session-user-holder-CONNECTED').tagName).toBe('BUTTON');
    expect(getByTestId('session-user-peer-CONNECTED').tagName).toBe('BUTTON');
  });

  it('updates the session, count and connection identities without retaining an old leaf identifier', () => {
    const { getByTestId, queryByTestId, rerender } = render(
      <SessionPresenceRow sessionId={sessionId} users={[user('holder'), user('peer')]} />,
    );
    const nextSession = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    rerender(<SessionPresenceRow sessionId={nextSession} users={[user('holder', 'RECONNECTING')]} />);
    expect(queryByTestId(`session-presence-${sessionId}-2`)).toBeNull();
    expect(getByTestId(`session-presence-${nextSession}-1`).textContent).toBe('1 climbing');
    expect(getByTestId('session-roster-1')).toBeDefined();
    expect(queryByTestId('session-user-holder-CONNECTED')).toBeNull();
    expect(getByTestId('session-user-holder-RECONNECTING')).toBeDefined();
  });

  it('does not invent an active session identifier for an absent session or an empty roster', () => {
    const { container, rerender } = render(<SessionPresenceRow sessionId={null} users={[user('holder')]} />);
    expect(container.textContent).toBe('1 climbing');
    expect(container.querySelector('[data-testid^="session-presence-"]')).toBeNull();
    rerender(<SessionPresenceRow sessionId={sessionId} users={[]} />);
    expect(container.childElementCount).toBe(0);
  });
});
