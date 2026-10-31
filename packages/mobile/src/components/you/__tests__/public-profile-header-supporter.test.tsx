// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { PublicUserProfile } from '@boardsesh/shared-schema';

vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../lib/routing/scoped-navigation', () => ({ useScopedRouter: () => ({ push: vi.fn() }) }));
vi.mock('../../../lib/graphql/hooks/use-privacy', () => ({
  usePrivacySettings: () => ({ data: undefined }),
  usePrivacyRelationship: () => ({ data: undefined, isPending: false }),
  usePrivacyFollowAction: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({ useConnectivity: () => ({ effectiveOffline: false }) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useToggleUserFollow: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, variant: 'liquidGlass' }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../lib/open-external-link', () => ({ openValidatedUrl: vi.fn() }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Avatar', () => ({ Avatar: () => null }));
vi.mock('../../Button', () => ({ Button: ({ title }: { title: string }) => createElement('button', null, title) }));
vi.mock('../../DraftChip', () => ({ climbChipStyles: { chip: {} } }));
vi.mock('../../../theme/tokens', () => ({ spacing: {}, borderRadius: {} }));
vi.mock('../../../theme/variants', () => ({
  selectByVariant: (_variant: string, options: { liquidGlass: string }) => options.liquidGlass,
}));

import { PublicProfileHeaderBlock } from '../PublicProfileHeaderBlock';

const TAG_TEST_ID = 'public-profile-supporter-tag';

function profileWith(isSupporter: boolean | null | undefined): PublicUserProfile {
  return {
    id: 'climber-1',
    displayName: 'Ada',
    avatarUrl: undefined,
    followerCount: 3,
    followingCount: 4,
    isFollowedByMe: false,
    canViewActivity: true,
    isSupporter,
  };
}

describe('PublicProfileHeaderBlock supporter tag', () => {
  it('shows the Supporter tag next to the name when isSupporter is true', () => {
    render(<PublicProfileHeaderBlock profile={profileWith(true)} instagramUrl={null} currentUserId="viewer" />);
    expect(screen.getByTestId(TAG_TEST_ID).textContent).toBe('mobile.social.supporterTag');
    expect(screen.getByText('Ada')).toBeTruthy();
  });

  it.each([
    ['false', false],
    ['null', null],
    ['missing', undefined],
  ])('hides the Supporter tag when isSupporter is %s', (_label, isSupporter) => {
    render(<PublicProfileHeaderBlock profile={profileWith(isSupporter)} instagramUrl={null} currentUserId="viewer" />);
    expect(screen.queryByTestId(TAG_TEST_ID)).toBeNull();
    expect(screen.queryByText('mobile.social.supporterTag')).toBeNull();
  });
});
