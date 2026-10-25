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
  Button: ({ title, onPress, disabled }: { title: string; onPress?: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: onPress, disabled }, title),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('span', { 'data-testid': 'link-loading' }),
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
vi.mock('../../../lib/open-url', () => ({ openExternalUrl: vi.fn(async () => {}) }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 2: 8, 3: 12, 4: 16, 6: 24 },
  borderRadius: { lg: 12 },
}));

import { BoardShareSheet } from '../BoardShareSheet';
import { Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { openExternalUrl } from '../../../lib/open-url';

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

const INVITE_URL = 'https://www.boardsesh.com/b/the-garage?invite=Ab3_dE-fGhIjKlMnOpQrSt';

describe('BoardShareSheet for a home board', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says what each link does, in the board copy', () => {
    const cases = [
      ['public', 'mobile.boardShare.publicBody'],
      ['unlisted', 'mobile.boardShare.unlistedBody'],
      ['invite', 'mobile.boardShare.inviteBody'],
    ] as const;
    for (const [visibility, body] of cases) {
      const { getByText, unmount } = render(
        <BoardShareSheet
          visible
          onDismiss={vi.fn()}
          shareUrl={INVITE_URL}
          wallName="Garage"
          visibility={visibility}
          subject="board"
        />,
      );
      expect(getByText('mobile.boardShare.title')).toBeTruthy();
      expect(getByText(body)).toBeTruthy();
      unmount();
    }
  });

  it('shares the tokened link and offers Reset only when asked to', async () => {
    const onResetLink = vi.fn();
    const { getByText } = render(
      <BoardShareSheet
        visible
        onDismiss={vi.fn()}
        shareUrl={INVITE_URL}
        wallName="Garage"
        visibility="invite"
        subject="board"
        onResetLink={onResetLink}
      />,
    );
    await act(async () => getByText('mobile.sprayShare.copyLink').click());
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(INVITE_URL);
    act(() => getByText('mobile.boardShare.resetLink').click());
    expect(onResetLink).toHaveBeenCalledOnce();
  });

  it('holds the QR space with a spinner while the link loads, and copies nothing', async () => {
    const { getByTestId, getByText, queryByText } = render(
      <BoardShareSheet
        visible
        onDismiss={vi.fn()}
        shareUrl={null}
        wallName="Garage"
        visibility="invite"
        subject="board"
      />,
    );
    expect(getByTestId('link-loading')).toBeTruthy();
    expect(queryByText('mobile.boardShare.resetLink')).toBeNull();
    expect((getByText('mobile.sprayShare.copyLink') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => getByText('mobile.sprayShare.copyLink').click());
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
  });

  it('says so when the link could not be fetched', () => {
    const { getByText } = render(
      <BoardShareSheet
        visible
        onDismiss={vi.fn()}
        shareUrl={null}
        linkFailed
        wallName="Garage"
        visibility="invite"
        subject="board"
      />,
    );
    expect(getByText('mobile.boardShare.loadFailed')).toBeTruthy();
  });
});

const POSTER_URL = 'https://www.boardsesh.com/poster/b/garage?wall=abc';

describe('BoardShareSheet poster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the poster page in the in-app browser', () => {
    const { getByText } = render(
      <BoardShareSheet
        visible
        onDismiss={vi.fn()}
        shareUrl={URL}
        wallName="Garage"
        visibility="unlisted"
        posterUrl={POSTER_URL}
      />,
    );
    expect(getByText('mobile.wallPoster.sprayHint')).toBeTruthy();
    act(() => getByText('mobile.wallPoster.print').click());
    expect(openExternalUrl).toHaveBeenCalledWith(POSTER_URL, 'board-share-poster');
  });

  it("says board, not wall, under a home board's poster", () => {
    const { getByText, queryByText } = render(
      <BoardShareSheet
        visible
        onDismiss={vi.fn()}
        shareUrl="https://www.boardsesh.com/b/garage"
        wallName="Garage"
        visibility="public"
        subject="board"
        posterUrl="https://www.boardsesh.com/poster/b/garage"
      />,
    );
    expect(getByText('mobile.wallPoster.boardHint')).toBeTruthy();
    expect(queryByText('mobile.wallPoster.sprayHint')).toBeNull();
  });

  it.each([
    ['no poster URL', undefined],
    ['a null poster URL', null],
  ])('hides the action with %s', (_label, posterUrl) => {
    const { queryByText } = render(
      <BoardShareSheet
        visible
        onDismiss={vi.fn()}
        shareUrl={URL}
        wallName="Garage"
        visibility="public"
        posterUrl={posterUrl}
      />,
    );
    expect(queryByText('mobile.wallPoster.print')).toBeNull();
    expect(queryByText('mobile.wallPoster.sprayHint')).toBeNull();
  });

  // An invite token taped to a wall is no longer an invite.
  it('never offers a poster for an invite link, whatever the caller passes', () => {
    const { queryByText } = render(
      <BoardShareSheet
        visible
        onDismiss={vi.fn()}
        shareUrl={INVITE_URL}
        wallName="Garage"
        visibility="invite"
        subject="board"
        posterUrl="https://www.boardsesh.com/poster/b/the-garage"
      />,
    );
    expect(queryByText('mobile.wallPoster.print')).toBeNull();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
});
