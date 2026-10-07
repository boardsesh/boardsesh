// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

/**
 * The play drawer's "This climb lost a hold" banner.
 *
 * Every suite that renders the drawer stubs this component out (it reaches the
 * design-system Button, which reaches native modules those suites have no
 * runtime for), so this file is its coverage. Three rules worth pinning:
 *
 *  1. it says nothing when nothing is missing;
 *  2. it offers exactly one action, Remix: no Edit, no put-back;
 *  3. Remix is optional: on an archived wall the sentence stays and the button
 *     goes, because a button that leads nowhere is worse than none.
 */

const translate = vi.fn((key: string, options?: { count?: number }) =>
  options?.count == null ? key : `${key}#${options.count}`,
);

// `testID` is React Native's handle and means nothing to React DOM, so the stub
// translates it — the banner is found in these tests the same way the drawer's
// own suites find it on a device.
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
}));

// The token module reads `PlatformColor` at load; the banner only ever wants two
// numbers out of it, and neither is what is under test here.
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { lg: 12 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryBackground: '#1C1C1E', secondaryLabel: '#8E8E93' } }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children, variant }: { children?: ReactNode; variant?: string }) =>
    createElement('span', { 'data-variant': variant }, children),
}));

vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));

vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));

const { LostHoldsBanner } = await import('../LostHoldsBanner');

describe('LostHoldsBanner', () => {
  it('renders nothing for a climb that has lost nothing', () => {
    const { container } = render(createElement(LostHoldsBanner, { count: 0, onRemix: vi.fn() }));
    expect(container.querySelector('[data-testid="lost-holds-banner"]')).toBeNull();
  });

  it('renders nothing for a negative count', () => {
    const { container } = render(createElement(LostHoldsBanner, { count: -1 }));
    expect(container.querySelector('[data-testid="lost-holds-banner"]')).toBeNull();
  });

  it('says the climb lost a hold and offers Remix, once, and nothing else', () => {
    const onRemix = vi.fn();
    const { getByRole, getAllByRole, getByTestId } = render(createElement(LostHoldsBanner, { count: 2, onRemix }));

    expect(getByTestId('lost-holds-banner').textContent).toContain('mobile.lostHolds.banner');
    expect(getAllByRole('button')).toHaveLength(1);
    getByRole('button', { name: 'mobile.lostHolds.remix' }).click();
    expect(onRemix).toHaveBeenCalledTimes(1);
  });

  it('keeps the sentence and drops the button without a Remix handler', () => {
    const { getByTestId, queryByRole } = render(createElement(LostHoldsBanner, { count: 2 }));

    expect(getByTestId('lost-holds-banner').textContent).toContain('mobile.lostHolds.banner');
    expect(queryByRole('button')).toBeNull();
  });
});
