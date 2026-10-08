// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BetaLink } from '@boardsesh/shared-schema';

// Regression guard for the Android nested-scroll fix (issue #3506): the play
// drawer's outer scroll is a react-native-gesture-handler ScrollView, so the
// horizontal beta strip must scroll with RNGH's ScrollView too — a plain
// react-native ScrollView isn't in RNGH's gesture tree and Android's outer scroll
// swallows its horizontal pans. Two distinct stubs let us assert which module the
// strip came from, so a refactor back to the RN ScrollView fails here.
vi.mock('../../privacy/ContentAudienceControl', () => ({ ContentAudienceControl: () => null }));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'rn-scroll' }, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: unknown) => styles,
    hairlineWidth: 1,
  },
}));

vi.mock('react-native-gesture-handler', () => ({
  ScrollView: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'rngh-scroll' }, children),
}));

const betaLinks = vi.hoisted(() => ({
  data: undefined as BetaLink[] | undefined,
  isLoading: false,
  isError: false,
  isRefetching: false,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@boardsesh/shared-schema', () => ({ betaLinkIdentity: (url: string) => url }));
vi.mock('../../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: string }) =>
    createElement('span', { 'data-color': color }, children),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useBetaLinks: () => ({
    data: betaLinks.data,
    isLoading: betaLinks.isLoading,
    isError: betaLinks.isError,
    isRefetching: betaLinks.isRefetching,
    refetch: vi.fn(),
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    brandColors: { primary: '#000' },
    systemColors: { secondaryLabel: 'theme-secondary-label', fill: 'theme-fill', error: 'theme-error' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12 },
  borderRadius: { md: 8, full: 999 },
}));
vi.mock('../BetaVideoCard', () => ({
  BETA_CARD_WIDTH: 108,
  BETA_CARD_HEIGHT: 192,
  BetaVideoCard: ({ link }: { link: BetaLink }) =>
    createElement('div', { 'data-testid': 'beta-card', 'data-link': link.link }),
}));

import { BetaVideosSection } from '../BetaVideosSection';

function betaLink(url: string): BetaLink {
  return {
    climb_uuid: 'climb-1',
    link: url,
    foreign_username: null,
    angle: 40,
    thumbnail: null,
    is_listed: true,
    created_at: '2026-06-12T00:00:00.000Z',
    tick_uuid: null,
    board_id: null,
  };
}

beforeEach(() => {
  betaLinks.data = undefined;
  betaLinks.isLoading = false;
  betaLinks.isError = false;
  betaLinks.isRefetching = false;
});

describe('BetaVideosSection', () => {
  it('scrolls the loaded beta strip with the gesture-handler ScrollView (Android nested-scroll fix)', () => {
    betaLinks.data = [betaLink('https://www.instagram.com/reel/aaa/'), betaLink('https://www.tiktok.com/@u/video/1')];

    const { getByTestId, queryByTestId, getAllByTestId } = render(
      createElement(BetaVideosSection, { climbUuid: 'climb-1', boardName: 'kilter' }),
    );

    expect(getByTestId('rngh-scroll')).toBeTruthy();
    expect(queryByTestId('rn-scroll')).toBeNull();
    expect(getAllByTestId('beta-card')).toHaveLength(2);
  });

  it('renders the video count in the scheme-aware secondary label', () => {
    betaLinks.data = [betaLink('https://www.instagram.com/reel/aaa/')];

    const { getByText } = render(createElement(BetaVideosSection, { climbUuid: 'climb-1', boardName: 'kilter' }));

    expect(getByText('mobile.betaVideos.videoCount').getAttribute('data-color')).toBe('theme-secondary-label');
  });

  it('paints the load error glyph in the error role and its copy in the secondary label', () => {
    betaLinks.isError = true;

    const { container, getByText } = render(
      createElement(BetaVideosSection, { climbUuid: 'climb-1', boardName: 'kilter' }),
    );

    expect(container.querySelector('i[data-icon="error"]')?.getAttribute('data-color')).toBe('theme-error');
    expect(getByText('mobile.betaVideos.errorTitle').getAttribute('data-color')).toBe('theme-secondary-label');
  });
});
