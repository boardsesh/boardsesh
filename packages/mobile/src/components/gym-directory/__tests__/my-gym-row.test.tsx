// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Gym } from '@boardsesh/shared-schema';

type Children = { children?: ReactNode };
type PressProps = { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string };

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('../../StatusPill', () => ({
  StatusPill: ({ label, icon, tone }: { label: string; icon?: string; tone?: string }) =>
    createElement('span', { 'data-icon': icon, 'data-tone': tone ?? 'neutral' }, label),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: Children) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, accessibilityLabel }: PressProps) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel, type: 'button' }, children),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 8: 32 },
  borderRadius: { lg: 12, full: 9999 },
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      secondaryBackground: '#fff',
      separator: '#ccc',
      label: '#000',
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
      fill: '#eee',
    },
    brandColors: { primary: '#6D28D9', onPrimary: '#fff' },
  }),
}));

import { MyGymRow } from '../MyGymRow';

const roleLabels = { owner: 'Owner', admin: 'Admin', editor: 'Editor', member: 'Member' };

function makeGym(overrides: Partial<Gym>): Gym {
  return {
    uuid: 'g1',
    slug: 'movement',
    ownerId: 'owner-1',
    name: 'Movement',
    address: '1 Crag St',
    canEdit: true,
    myRole: null,
    ...overrides,
  } as unknown as Gym;
}

function renderRow(
  gym: Gym,
  currentUserId?: string,
  onOpenGym = vi.fn(),
  onManageKiosks = vi.fn(),
  onOpenAnalytics = vi.fn(),
) {
  return {
    onOpenGym,
    onManageKiosks,
    onOpenAnalytics,
    ...render(
      <MyGymRow
        gym={gym}
        currentUserId={currentUserId}
        roleLabels={roleLabels}
        manageLabel="Manage kiosks & TVs"
        manageAccessibilityLabel="Manage kiosks and TVs for Movement"
        analyticsLabel="Gym analytics"
        analyticsAccessibilityLabel="Open analytics for Movement"
        noAddressLabel="No address yet"
        onOpenAnalytics={onOpenAnalytics}
        onOpenGym={onOpenGym}
        onManageKiosks={onManageKiosks}
      />,
    ),
  };
}

describe('MyGymRow', () => {
  it('shows the Owner badge when the viewer owns the gym', () => {
    const { getByText } = renderRow(makeGym({ myRole: 'editor' }), 'owner-1');
    // Owner beats a membership role even when both are present.
    expect(getByText('Owner')).toBeTruthy();
    expect(getByText('Owner').getAttribute('data-icon')).toBe('crown.fill');
  });

  it('falls back to the membership role badge when the viewer is not the owner', () => {
    const { getByText, queryByText } = renderRow(makeGym({ myRole: 'editor' }), 'someone-else');
    expect(getByText('Editor')).toBeTruthy();
    expect(queryByText('Owner')).toBeNull();
  });

  it('renders no role badge when there is no ownership or membership', () => {
    const { queryByText } = renderRow(makeGym({ myRole: null }), 'someone-else');
    expect(queryByText('Owner')).toBeNull();
    expect(queryByText('Editor')).toBeNull();
    expect(queryByText('Member')).toBeNull();
  });

  it('shows the no-address fallback when the gym has no address', () => {
    const { getByText } = renderRow(makeGym({ address: null }), 'owner-1');
    expect(getByText('No address yet')).toBeTruthy();
  });

  it('opens the gym page when the summary is tapped', () => {
    const gym = makeGym({});
    const onOpenGym = vi.fn();
    const { getByRole } = renderRow(gym, 'owner-1', onOpenGym);
    fireEvent.click(getByRole('button', { name: 'Movement' }));
    expect(onOpenGym).toHaveBeenCalledWith(gym);
  });

  it('hands off to the manage console when the manage affordance is tapped', () => {
    const gym = makeGym({});
    const onManageKiosks = vi.fn();
    const { getByRole } = renderRow(gym, 'owner-1', vi.fn(), onManageKiosks);
    fireEvent.click(getByRole('button', { name: 'Manage kiosks and TVs for Movement' }));
    expect(onManageKiosks).toHaveBeenCalledWith(gym);
  });

  it('opens staff analytics for an editor who does not own the gym', () => {
    const gym = makeGym({ myRole: 'editor' });
    const { getByRole, onOpenAnalytics } = renderRow(gym, 'someone-else');
    fireEvent.click(getByRole('button', { name: 'Open analytics for Movement' }));
    expect(onOpenAnalytics).toHaveBeenCalledWith(gym);
  });

  it('renders no pressable affordances when the viewer cannot edit', () => {
    const { queryAllByRole } = renderRow(makeGym({ canEdit: false }), 'someone-else');
    // No edit tap target and no manage hand-off for a non-editor.
    expect(queryAllByRole('button')).toHaveLength(0);
  });
});
