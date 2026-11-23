// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Gym } from '@boardsesh/shared-schema';

type Children = { children?: ReactNode };
type ButtonProps = { title: string; onPress: () => void };

// Mutable per-test gym driving the mocked `useGym`.
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
vi.mock('../../../src/components/report-problem/WhoCanEdit', () => ({
  WhoCanEditGym: ({ gym }: { gym: Gym }) => createElement('div', { 'data-testid': 'who-can-edit-gym' }, gym.name),
}));
vi.mock('../../../src/components/gym-directory/GymWriteAccessSection', () => ({
  GymWriteAccessSection: () => createElement('div', { 'data-testid': 'write-access' }),
}));

import EditGym from '../edit';

function makeGym(overrides: Partial<Gym>): Gym {
  return {
    uuid: 'gym-uuid-1',
    slug: null,
    name: 'Bonsist',
    canEdit: true,
    canClaim: false,
    canGrantAccess: false,
    isPublic: true,
    ...overrides,
  } as unknown as Gym;
}

describe('EditGym', () => {
  beforeEach(() => {
    state.gym = makeGym({});
  });

  it('offers no claim on the edit form: a claimant cannot edit, so they never reach it', () => {
    state.gym = makeGym({ canClaim: true });
    render(<EditGym />);
    expect(screen.queryByText('mobile.gymClaim.claimAction')).toBeNull();
    expect(screen.queryByText('mobile.gymClaim.sectionTitle')).toBeNull();
  });

  it('shows the write-access section to someone who can grant it', () => {
    state.gym = makeGym({ canGrantAccess: true });
    render(<EditGym />);
    expect(screen.getByTestId('write-access')).toBeTruthy();
  });

  it('says who can change the gym, instead of the form, for a viewer who cannot edit it', () => {
    state.gym = makeGym({ canEdit: false, canClaim: true });
    render(<EditGym />);
    expect(screen.getByTestId('who-can-edit-gym').textContent).toBe('Bonsist');
    expect(screen.queryByTestId('write-access')).toBeNull();
  });
});
