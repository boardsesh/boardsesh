// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// #5960: on the glass sheet the body copy and the URL were light grey and hard
// to read, and the URL sat right against the buttons.

const COLORS = {
  label: '#LABEL',
  secondaryLabel: '#SECONDARY',
  tertiaryLabel: '#TERTIARY',
  secondaryBackground: '#BG',
};

type TextMockProps = { children?: ReactNode; color?: string; style?: { marginBottom?: number } };
type ModalMockProps = {
  children?: ReactNode;
  header?: ReactNode;
  visible?: boolean;
  scrollable?: boolean;
  snapPoints?: (string | number)[];
  onClose?: () => void;
  onFullyDismissed?: () => void;
};
const captures = vi.hoisted(() => ({ modal: undefined as ModalMockProps | undefined }));
vi.mock('react-native', () => ({
  Share: { share: vi.fn() },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: (props: ModalMockProps) => {
    captures.modal = props;
    if (!props.visible) return null;
    return createElement(
      'div',
      null,
      props.header,
      createElement('div', { 'data-testid': props.scrollable ? 'share-scroll-body' : 'share-body' }, props.children),
    );
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));
vi.mock('../../Text', () => ({
  Text: ({ children, color, style }: TextMockProps) =>
    createElement(
      'span',
      { 'data-color': color ?? '', 'data-margin-bottom': String(style?.marginBottom ?? 0) },
      children,
    ),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
type TopBarMockProps = { title: string; leading?: { kind: string; onPress: () => void } };
vi.mock('../../SheetTopBar', () => ({
  SheetTopBar: ({ title, leading }: TopBarMockProps) =>
    createElement(
      'div',
      null,
      title,
      leading ? createElement('button', { 'data-testid': `leading-${leading.kind}`, onClick: leading.onPress }) : null,
    ),
}));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: COLORS }) }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../sheet-snap-points', () => ({
  MEDIUM_LARGE_SNAP_POINTS: ['50%', '90%'],
}));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 2: 8, 3: 12, 4: 16, 6: 24 },
  borderRadius: { lg: 12 },
}));

import { BoardShareSheet } from '../BoardShareSheet';
import { Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';

const URL = 'https://www.boardsesh.com/b/garage/40/list?wall=abc';

describe('BoardShareSheet text', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captures.modal = undefined;
  });
  function renderSheet(onDismiss: () => void = vi.fn()) {
    return render(
      <BoardShareSheet visible onDismiss={onDismiss} shareUrl={URL} wallName="Garage" visibility="unlisted" />,
    );
  }

  it('keeps the QR code and actions in a scroll body at the medium detent', () => {
    const { getByTestId, getByText } = renderSheet();
    expect(captures.modal?.snapPoints).toEqual(['50%', '90%']);
    expect(getByTestId('share-scroll-body').contains(getByText('mobile.sprayShare.share'))).toBe(true);
    expect(getByTestId('share-scroll-body').contains(getByText('mobile.sprayShare.title'))).toBe(false);
  });

  it('forwards native closing and settled-dismissal events to the parent', () => {
    const onDismiss = vi.fn();
    const onFullyDismissed = vi.fn();
    const { rerender, queryByText } = render(
      <BoardShareSheet
        visible
        onDismiss={onDismiss}
        onFullyDismissed={onFullyDismissed}
        shareUrl={URL}
        wallName="Garage"
        visibility="unlisted"
      />,
    );
    act(() => captures.modal?.onClose?.());
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onFullyDismissed).not.toHaveBeenCalled();
    act(() => captures.modal?.onFullyDismissed?.());
    expect(onFullyDismissed).toHaveBeenCalledOnce();
    rerender(
      <BoardShareSheet visible={false} onDismiss={onDismiss} shareUrl={URL} wallName="Garage" visibility="unlisted" />,
    );
    expect(captures.modal?.visible).toBe(false);
    expect(queryByText('mobile.sprayShare.title')).toBeNull();
  });

  it('copies and shares the same wall link from the scroll body', async () => {
    const { getByText } = renderSheet();
    await act(async () => getByText('mobile.sprayShare.copyLink').click());
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(URL);
    act(() => getByText('mobile.sprayShare.share').click());
    expect(Share.share).toHaveBeenCalledWith({ message: URL, url: URL });
  });

  it('closes from the top bar, which carries the title', () => {
    const onDismiss = vi.fn();
    const { getByTestId, getByText } = renderSheet(onDismiss);
    expect(getByText('mobile.sprayShare.title')).toBeTruthy();
    act(() => getByTestId('leading-close').click());
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('draws the body in the full label colour', () => {
    expect(renderSheet().getByText('mobile.sprayShare.unlistedBody').getAttribute('data-color')).toBe('#LABEL');
  });

  it('draws the URL in secondary label, spaced off the buttons', () => {
    const url = renderSheet().getByText(URL);
    expect(url.getAttribute('data-color')).toBe('#SECONDARY');
    expect(Number(url.getAttribute('data-margin-bottom'))).toBeGreaterThan(0);
  });
});
