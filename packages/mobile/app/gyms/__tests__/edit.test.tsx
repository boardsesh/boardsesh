// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Gym } from '@boardsesh/shared-schema';

type Children = { children?: ReactNode };
type ButtonProps = { title: string; onPress: () => void };

// Mutable per-test gym driving the mocked `useGym`, so a test can flip
// `canClaim` the way an approved-claim refetch does.
const state = vi.hoisted(() => ({
  gym: {} as Gym,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
  useLocalSearchParams: () => ({ gymUuid: 'gym-uuid-1' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../src/lib/graphql/hooks', () => ({
  useGym: () => ({ data: state.gym, isLoading: false }),
  useUpdateGym: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock('../../../src/providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { background: '#fff', label: '#000', secondaryLabel: '#666' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../src/hooks/use-stack-screen-options', () => ({ useStackScreenOptions: () => ({}) }));
vi.mock('../../../src/lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../src/theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 } }));
vi.mock('../../../src/theme/ios-colors', () => ({ iosSystemColors: { systemGray: '#8e8e93' } }));

vi.mock('../../../src/components/Text', () => ({
  Text: ({ children }: Children) => createElement('span', null, children),
}));
vi.mock('../../../src/components/Icon', () => ({ Icon: () => createElement('i') }));
vi.mock('../../../src/components/Button', () => ({
  Button: ({ title, onPress }: ButtonProps) => createElement('button', { onClick: onPress, type: 'button' }, title),
}));
vi.mock('../../../src/components/ActivityIndicator', () => ({ ActivityIndicator: () => createElement('div') }));
vi.mock('../../../src/components/gym-directory/GymForm', () => ({
  GymForm: ({ extraSections }: { extraSections?: ReactNode }) => createElement('div', null, extraSections),
}));
vi.mock('../../../src/components/gym-directory/GymWriteAccessSection', () => ({
  GymWriteAccessSection: () => createElement('div'),
}));
// Stub the sheet down to a marker: this test only cares whether it stays mounted.
vi.mock('../../../src/components/gym-directory/ClaimGymSheet', () => ({
  ClaimGymSheet: () => createElement('div', { 'data-testid': 'claim-sheet' }),
}));

import EditGym from '../edit';

function makeGym(overrides: Partial<Gym>): Gym {
  return {
    uuid: 'gym-uuid-1',
    slug: null,
    name: 'Bonsist',
    canEdit: true,
    canClaim: true,
    canGrantAccess: false,
    isPublic: true,
    ...overrides,
  } as unknown as Gym;
}

describe('EditGym — claim sheet lifetime', () => {
  beforeEach(() => {
    state.gym = makeGym({});
  });

  it('keeps the claim sheet mounted after an approved claim flips canClaim false', () => {
    const view = render(<EditGym />);
    expect(screen.getByTestId('claim-sheet')).toBeTruthy();

    fireEvent.click(screen.getByText('mobile.gymClaim.claimAction'));

    // The approved claim invalidates the gym query; the refetch comes back with
    // the claimant as owner, so `canClaim` is now false.
    state.gym = makeGym({ canClaim: false });
    view.rerender(<EditGym />);

    // The sheet is still up showing the confirmation + "Set up your gym" CTA.
    expect(screen.getByTestId('claim-sheet')).toBeTruthy();
    // The claim entry point itself is correctly gone.
    expect(screen.queryByText('mobile.gymClaim.claimAction')).toBeNull();
  });

  it('does not mount the claim sheet for a gym the viewer cannot claim', () => {
    state.gym = makeGym({ canClaim: false });

    render(<EditGym />);

    expect(screen.queryByTestId('claim-sheet')).toBeNull();
  });
});
