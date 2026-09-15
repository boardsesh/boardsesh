// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

/**
 * The play drawer's "holds are gone" banner.
 *
 * Every suite that renders the drawer stubs this component out — it reaches the
 * design-system Button, which reaches native modules those suites have no runtime
 * for — so without this file the banner had no coverage at all. What is worth
 * pinning is not its layout but its three rules, each of which is a decision
 * somebody could quietly reverse:
 *
 *  1. it says nothing at all when nothing is missing, so an intact climb pays no
 *     strip of chrome;
 *  2. it counts through i18n's plural machinery rather than concatenating, so
 *     "1 hold" is not "1 holds";
 *  3. the Remix action is OPTIONAL — the drawer has surfaces (the iPad pane, the
 *     signed-out web view) that can show the banner and cannot reach the create
 *     route, and offering a button that goes nowhere is worse than offering none.
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

  it('renders nothing for a negative or absent count rather than "-1 holds gone"', () => {
    // `missingHoldCount` is nullable on the wire and materialised by a recompute,
    // so a nonsense value is a wire problem — not a thing to render.
    const { container } = render(createElement(LostHoldsBanner, { count: -1 }));
    expect(container.querySelector('[data-testid="lost-holds-banner"]')).toBeNull();
  });

  it('states the count through the plural key', () => {
    const { getByTestId } = render(createElement(LostHoldsBanner, { count: 3, onRemix: vi.fn() }));

    // `count` reaches i18next as `count`, which is what selects `_one` / `_other`.
    // Concatenating the number into the sentence here would read "1 holds are
    // gone" in English and be unfixable in German.
    expect(getByTestId('lost-holds-banner').textContent).toContain('mobile.lostHolds.banner#3');
    expect(translate).toHaveBeenCalledWith('mobile.lostHolds.banner', { count: 3 });
  });

  it('offers Remix and calls it once, only when the host can navigate', () => {
    const onRemix = vi.fn();
    const { getByRole } = render(createElement(LostHoldsBanner, { count: 2, onRemix }));

    const action = getByRole('button', { name: 'mobile.lostHolds.remix' });
    action.click();
    expect(onRemix).toHaveBeenCalledTimes(1);
  });

  it('is informational with no Remix handler — no dead button, no dead sentence', () => {
    const { getByTestId, queryByRole } = render(createElement(LostHoldsBanner, { count: 2 }));

    expect(getByTestId('lost-holds-banner').textContent).toContain('mobile.lostHolds.banner#2');
    expect(queryByRole('button')).toBeNull();
    // The body line only makes sense next to the action it describes.
    expect(getByTestId('lost-holds-banner').textContent).not.toContain('mobile.lostHolds.bannerBody');
  });
});
