// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
const openUrl = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));
const discord = vi.hoisted(() => ({ openDiscordInvite: vi.fn() }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (colorName: string) => colorName,
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('section', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useRouter: () => routerMock }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: { count?: number }) =>
      ({
        'mobile.acknowledgements.becomeSponsor': 'Become a sponsor',
        'mobile.acknowledgements.ossLicensesLink': 'Open source licenses',
        'mobile.acknowledgements.friendsTitle': 'The crew',
        'mobile.acknowledgements.discordTitle': 'Everyone on our Discord',
        'mobile.acknowledgements.privateSponsorsThanks': `and ${vars?.count ?? 0} more sponsoring privately — thank you too`,
      })[key] ?? key,
  }),
}));

vi.mock('../../src/lib/acknowledgements', () => ({
  contributors: [
    {
      login: 'alpha',
      name: null,
      avatarUrl: '',
      htmlUrl: 'https://github.com/alpha',
      pullRequests: 3,
      issues: 2,
      contributions: 5,
    },
  ],
  sponsors: [{ login: 'bluejayio', name: 'Shuying Zhang', avatarUrl: '', url: 'https://github.com/bluejayio' }],
  privateSponsorCount: 1,
  friends: ['Gabby', 'Caz', 'Joz'],
  dogName: 'Scout',
  SPONSORS_URL: 'https://github.com/sponsors/boardsesh',
}));
vi.mock('../../src/lib/open-url', () => openUrl);
vi.mock('../../src/lib/discord', () => discord);

vi.mock('../../src/components/Button', () => ({
  Button: ({ onPress, title }: { onPress: () => void; title: string }) =>
    createElement('button', { onClick: onPress, type: 'button' }, title),
}));
vi.mock('../../src/components/Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));
vi.mock('../../src/components/PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel, type: 'button' }, children),
}));
vi.mock('../../src/components/SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('h2', null, title),
}));
vi.mock('../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 80 }),
}));
vi.mock('../../src/providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { onPrimary: '#fff', primaryFill: '#6D28D9' },
    systemColors: { accent: '#6D28D9', fill: '#eee', secondaryBackground: '#fff', secondaryLabel: '#666' },
  }),
}));

import AcknowledgementsScreen from '../acknowledgements';

beforeEach(() => {
  routerMock.push.mockClear();
  openUrl.openExternalUrl.mockClear();
  discord.openDiscordInvite.mockClear();
});

describe('AcknowledgementsScreen', () => {
  it('renders a contributor chip that opens the GitHub profile', () => {
    render(<AcknowledgementsScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));

    expect(openUrl.openExternalUrl).toHaveBeenCalledWith('https://github.com/alpha', 'acknowledgements');
  });

  it('renders a public sponsor chip that opens their profile', () => {
    render(<AcknowledgementsScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'Shuying Zhang' }));

    expect(openUrl.openExternalUrl).toHaveBeenCalledWith('https://github.com/bluejayio', 'acknowledgements');
  });

  it('thanks private sponsors as an anonymous count', () => {
    render(<AcknowledgementsScreen />);

    expect(screen.getByText('and 1 more sponsoring privately — thank you too')).toBeTruthy();
  });

  it('thanks the crew, Alex, and the dog', () => {
    render(<AcknowledgementsScreen />);

    expect(screen.getByText('The crew')).toBeTruthy();
    expect(screen.getByText('Alex')).toBeTruthy();
    expect(screen.getByText('Scout')).toBeTruthy();
  });

  it('opens the Discord invite from the community card', () => {
    render(<AcknowledgementsScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'Everyone on our Discord' }));

    expect(discord.openDiscordInvite).toHaveBeenCalledWith('acknowledgements');
  });

  it('links to the open source licenses screen', () => {
    render(<AcknowledgementsScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'Open source licenses' }));

    expect(routerMock.push).toHaveBeenCalledWith('/licenses');
  });

  it('opens the Scout easter-egg page from the dog card', () => {
    render(<AcknowledgementsScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'Scout' }));

    expect(routerMock.push).toHaveBeenCalledWith('/scout');
  });

  it('shows the empty-state Become-a-sponsor CTA when there are no sponsors', async () => {
    // Re-mock the data module with no sponsors and re-import the screen so the
    // sponsors.length === 0 branch renders.
    vi.resetModules();
    vi.doMock('../../src/lib/acknowledgements', () => ({
      contributors: [],
      sponsors: [],
      privateSponsorCount: 0,
      friends: ['Gabby'],
      dogName: 'Scout',
      SPONSORS_URL: 'https://github.com/sponsors/boardsesh',
    }));
    const { default: EmptySponsorsScreen } = await import('../acknowledgements');

    render(<EmptySponsorsScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Become a sponsor' }));

    expect(openUrl.openExternalUrl).toHaveBeenCalledWith(
      'https://github.com/sponsors/boardsesh',
      'acknowledgements-sponsor',
    );

    vi.doUnmock('../../src/lib/acknowledgements');
    vi.resetModules();
  });
});
