// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'data-label': accessibilityLabel ?? '' }, children),
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: unknown }) =>
    createElement('span', { 'data-text-color': typeof color === 'string' ? color : '' }, children),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: unknown }) =>
    createElement('span', { 'data-icon': name, 'data-color': typeof color === 'string' ? color : '' }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#000', tertiaryLabel: '#999' },
    brandColors: { primary: '#6D28D9', error: '#C81E1E' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12 } }));

import { SessionScreenHeader } from '../SessionScreenHeader';

const SHARE = '[data-label="mobile.session.invite"]';
const END = '[data-label="mobile.session.inEndSession"]';
const MINIMIZE = '[data-label="mobile.session.minimize"]';

describe('SessionScreenHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('docks an End control (calling onEndSession) when onEndSession is provided', () => {
    const onEndSession = vi.fn();
    const { container } = render(<SessionScreenHeader sessionActive onShare={vi.fn()} onEndSession={onEndSession} />);
    const end = container.querySelector(END) as HTMLButtonElement | null;
    expect(end).not.toBeNull();
    end!.click();
    expect(onEndSession).toHaveBeenCalledTimes(1);
  });

  it('renders no End control when onEndSession is absent (e.g. pre-session)', () => {
    const { container } = render(<SessionScreenHeader sessionActive={false} />);
    expect(container.querySelector(END)).toBeNull();
  });

  it('docks the share control (calling onShare) when onShare is provided', () => {
    const onShare = vi.fn();
    const { container } = render(<SessionScreenHeader sessionActive onShare={onShare} inviteHint />);
    const share = container.querySelector(SHARE) as HTMLButtonElement | null;
    expect(share).not.toBeNull();
    expect(share?.querySelector('[data-icon="share"]')?.getAttribute('data-color')).toBe('#000');
    expect(share?.querySelector('[data-text-color]')?.getAttribute('data-text-color')).toBe('#000');
    share!.click();
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it('renders the minimize chevron only in overlay mode (onClose provided)', () => {
    const onClose = vi.fn();
    const overlay = render(<SessionScreenHeader sessionActive={false} onClose={onClose} />);
    const chevron = overlay.container.querySelector(MINIMIZE) as HTMLButtonElement | null;
    expect(chevron).not.toBeNull();
    chevron!.click();
    expect(onClose).toHaveBeenCalledTimes(1);

    const tab = render(<SessionScreenHeader sessionActive={false} />);
    expect(tab.container.querySelector(MINIMIZE)).toBeNull();
  });
});
