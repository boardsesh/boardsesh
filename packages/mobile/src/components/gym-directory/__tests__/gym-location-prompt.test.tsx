// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type TextProps = { children?: ReactNode };
type ButtonProps = { title?: string; onPress?: () => void };

const platform = vi.hoisted(() => ({ OS: 'ios' as string }));

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  Platform: platform,
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: TextProps) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: ButtonProps) => createElement('button', { onClick: onPress, type: 'button' }, title),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { tertiaryLabel: '#999', secondaryLabel: '#666' },
  }),
}));

// The i18n mock returns the key so assertions pin which copy rendered,
// independent of catalog text (parity is covered by the catalog tests).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const snooze = vi.hoisted(() => ({ snoozed: false }));
vi.mock('../../../lib/location-ask', () => ({
  useLocationAskSnoozed: () => snooze.snoozed,
  shouldOfferLocationAsk: (permission: string, snoozed: boolean) =>
    (permission === 'ask' || permission === 'blocked') && !snoozed,
}));
// The card's buttons, snooze and Settings trip are its own suite's
// (components/location/__tests__/LocationAskCard.test.tsx).
vi.mock('../../location/LocationAskCard', () => ({
  LocationAskCard: ({ permission, surface }: { permission: string; surface: string }) =>
    createElement('div', {
      'data-testid': 'location-ask-card',
      'data-permission': permission,
      'data-surface': surface,
    }),
}));

import { GymLocationPrompt, type GymLocationPromptProps } from '../GymLocationPrompt';

const onRequest = vi.fn(async () => 'granted' as const);
const onRecheck = vi.fn(async () => 'granted' as const);

function renderPrompt(overrides: Partial<GymLocationPromptProps>) {
  return render(
    <GymLocationPrompt
      status="idle"
      permission="ask"
      permissionChecked
      onRequest={onRequest}
      onRecheck={onRecheck}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  platform.OS = 'ios';
  snooze.snoozed = false;
  onRequest.mockClear();
  onRecheck.mockClear();
});

describe('GymLocationPrompt', () => {
  it('shows a spinner, without a button, until the on-open read is back', () => {
    const { getByTestId, queryByRole, queryByTestId } = renderPrompt({
      permissionChecked: false,
      permission: 'unknown',
    });
    expect(getByTestId('spinner')).toBeTruthy();
    expect(queryByRole('button')).toBeNull();
    expect(queryByTestId('location-ask-card')).toBeNull();
  });

  it('shows a spinner while a fix is on its way', () => {
    const { getByTestId } = renderPrompt({ status: 'loading', permission: 'granted' });
    expect(getByTestId('spinner')).toBeTruthy();
  });

  it.each(['ask', 'blocked'] as const)('asks with "See gyms near you" while location is %s', (permission) => {
    const { getByTestId } = renderPrompt({ permission });
    const card = getByTestId('location-ask-card');
    expect(card.getAttribute('data-permission')).toBe(permission);
    expect(card.getAttribute('data-surface')).toBe('gym_finder');
    // Asking is the card's tap, never the screen's open.
    expect(onRequest).not.toHaveBeenCalled();
  });

  it('points at search instead once a "Not now" holds', () => {
    snooze.snoozed = true;
    const { queryByTestId, getByText, queryByRole } = renderPrompt({ permission: 'blocked' });
    expect(queryByTestId('location-ask-card')).toBeNull();
    expect(getByText('mobile.locationAsk.searchHint')).toBeTruthy();
    expect(queryByRole('button')).toBeNull();
  });

  it('retries a failed fix from Use my location', () => {
    const { getByText } = renderPrompt({ status: 'unavailable', permission: 'granted' });
    fireEvent.click(getByText('mobile.gyms.grantLocation'));
    expect(onRequest).toHaveBeenCalledTimes(1);
  });
});
