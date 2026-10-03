// @vitest-environment jsdom
// The play drawer now renders for a signed-out reader on app.boardsesh.com's
// read-only climb URLs. Everything that reaches the Logbook section in that
// state looks identical to a member who has never touched the climb — the
// logbook query is disabled, so it lands empty, and `userAscents` /
// `userAttempts` are viewer-scoped and arrive null — which used to fall through
// to "No tries yet. Get on it." That line is a claim about the reader's history,
// and for someone who has never had an account it is simply false.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode } & Record<string, unknown>) => createElement('div', null, children),
  ActivityIndicator: () => createElement('i', null),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'web' },
  PlatformColor: (name: string) => name,
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../LogbookEntryRow', () => ({ LogbookEntryRow: () => createElement('div', null) }));

vi.mock('../../PressableSurface', () => ({ PressableSurface: () => null }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ colorScheme: 'light', brandColors: {}, systemColors: {} }),
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGradeByDifficultyId: () => null }),
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({ useConnectivityField: () => false }));

// `fetchedUuids` holds the climb for the signed-in case: a member's empty
// state only shows once their (empty) history has actually been fetched.
const logbookState = vi.hoisted(() => ({
  logbook: [] as unknown[],
  fetchedUuids: new Set<string>(['climb-1']) as ReadonlySet<string>,
  error: null,
}));
vi.mock('@boardsesh/board-react', () => ({ useLogbook: () => logbookState }));
vi.mock('../../../hooks/use-local-ticks', () => ({ useLocalPendingTicks: () => ({ data: 0 }) }));

const authState = vi.hoisted(() => ({ current: { isAuthenticated: false } }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => authState.current }));

import { LogbookSection } from '../LogbookSection';

beforeEach(() => {
  logbookState.logbook = [];
  authState.current = { isAuthenticated: false };
});

describe('LogbookSection for a signed-out reader', () => {
  it('offers the sign-in line instead of claiming they have no tries yet', () => {
    const { container } = render(
      createElement(LogbookSection, {
        climbUuid: 'climb-1',
        boardName: 'kilter',
        layoutId: 1,
        angle: 40,
        userAscents: undefined,
        userAttempts: undefined,
      }),
    );

    expect(container.textContent).toContain('mobile.logbook.signedOut');
    // The negative half is the load-bearing one: asserting only that the prompt
    // renders would stay green if the empty state rendered underneath it too.
    expect(container.textContent).not.toContain('mobile.logbook.noEntries');
  });

  // The branch has to sit ahead of the count fallbacks, not just ahead of the
  // empty state: a stale denormalised count on the climb payload must not be
  // narrated as this reader's history either.
  it('does not narrate somebody else’s counts as the reader’s own', () => {
    const { container } = render(
      createElement(LogbookSection, {
        climbUuid: 'climb-1',
        boardName: 'kilter',
        layoutId: 1,
        angle: 40,
        userAscents: 3,
        userAttempts: 9,
      }),
    );

    expect(container.textContent).toContain('mobile.logbook.signedOut');
    expect(container.textContent).not.toContain('mobile.logbook.sendCount');
    expect(container.textContent).not.toContain('mobile.logbook.attemptCount');
  });

  // A member on the same empty climb still gets the real empty state — the fix
  // must not swallow it for everyone.
  it('leaves a signed-in member on the real empty state', () => {
    authState.current = { isAuthenticated: true };

    const { container } = render(
      createElement(LogbookSection, {
        climbUuid: 'climb-1',
        boardName: 'kilter',
        layoutId: 1,
        angle: 40,
        userAscents: 0,
        userAttempts: 0,
      }),
    );

    expect(container.textContent).toContain('mobile.logbook.noEntries');
    expect(container.textContent).not.toContain('mobile.logbook.signedOut');
  });
});
