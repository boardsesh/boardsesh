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

const openAppSettings = vi.fn();
vi.mock('../../../lib/open-app-settings', () => ({
  canOpenAppSettings: () => platform.OS === 'ios' || platform.OS === 'android',
  openAppSettings: (...args: unknown[]) => openAppSettings(...args),
}));

import { GymLocationPrompt } from '../GymLocationPrompt';

beforeEach(() => {
  platform.OS = 'ios';
  openAppSettings.mockReset();
});

describe('GymLocationPrompt', () => {
  it('shows a spinner while idle or loading, without a button', () => {
    const { getByTestId, queryByRole } = render(<GymLocationPrompt status="idle" onRequest={vi.fn()} />);
    expect(getByTestId('spinner')).toBeTruthy();
    expect(queryByRole('button')).toBeNull();
  });

  it('pressing the button in idle/denied-on-native state calls onRequest or openAppSettings appropriately', () => {
    const onRequest = vi.fn();
    const { getByText } = render(<GymLocationPrompt status="unavailable" onRequest={onRequest} />);

    fireEvent.click(getByText('mobile.gyms.grantLocation'));

    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(openAppSettings).not.toHaveBeenCalled();
  });

  it('on native (ios/android), denied renders the button and pressing it deep-links to Settings, not onRequest', () => {
    platform.OS = 'ios';
    const onRequest = vi.fn();
    const { getByText } = render(<GymLocationPrompt status="denied" onRequest={onRequest} />);

    fireEvent.click(getByText('mobile.gyms.grantLocation'));

    expect(openAppSettings).toHaveBeenCalledTimes(1);
    expect(onRequest).not.toHaveBeenCalled();
  });

  // Regression guard for BOARDSESH-DT: on web there's no settings deep-link and
  // the browser won't re-prompt, so denied must render explanatory copy and NO
  // dead button — the header search field above this panel is the working path.
  it('on web, denied renders explanatory copy and no button', () => {
    platform.OS = 'web';
    const { getByText, queryByRole } = render(<GymLocationPrompt status="denied" onRequest={vi.fn()} />);

    expect(getByText('mobile.gyms.locationBlocked')).toBeTruthy();
    expect(queryByRole('button')).toBeNull();
  });
});
