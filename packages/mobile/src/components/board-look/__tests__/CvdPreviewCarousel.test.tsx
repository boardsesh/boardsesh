// @vitest-environment jsdom
//
// The regression this file exists for: the enlarged preview opened, closed,
// opened, closed — and then would not open a third time.
//
// Both the sheet's open state and the board it draws used to clear on the same
// event, so the hosted board was torn out of the sheet while it was still
// dismissing. The sheet coordinator treats a host that vanishes mid-dismiss as a
// settle it may never hear about, and a group whose dismiss never settles
// refuses the next present. The board now survives until the dismiss has really
// settled, and that same signal is the backstop that resyncs the id — without it
// a stale id turns re-tapping the same card into a no-op state write.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const sheet = vi.hoisted(() => ({
  visible: false,
  onClose: undefined as (() => void) | undefined,
  onFullyDismissed: undefined as (() => void) | undefined,
  hasBoard: false,
}));
const cards = vi.hoisted(() => ({ press: new Map<string, (id: string) => void>() }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1, absoluteFill: {} },
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  PlatformColor: (color: string) => color,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#888', tertiaryBackground: '#222' } }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../SnapCarousel', () => ({
  SNAP_CARD_GAP: 12,
  SnapCarousel: ({ data, renderItem }: { data: unknown[]; renderItem: (arg: { item: unknown }) => ReactNode }) =>
    createElement('div', null, ...data.map((item) => renderItem({ item }))),
}));
vi.mock('../CvdPreviewCard', () => ({
  CVD_PREVIEW_CARD_WIDTH: 168,
  CvdPreviewCard: (props: { option: { id: string }; onPress: (id: string) => void }) => {
    cards.press.set(props.option.id, props.onPress);
    return createElement('div', { 'data-testid': `cvd-card-${props.option.id}` });
  },
}));
vi.mock('../BoardPreviewSheet', () => ({
  BoardPreviewSheet: (props: {
    visible: boolean;
    title: string | null;
    onClose: () => void;
    onFullyDismissed: () => void;
  }) => {
    sheet.visible = props.visible;
    // `title` is non-null exactly while the sheet still has content to draw,
    // which is what must outlive the close.
    sheet.hasBoard = props.title != null;
    sheet.onClose = props.onClose;
    sheet.onFullyDismissed = props.onFullyDismissed;
    return createElement('div', null);
  },
}));

// Stops the real module graph (board-render-settings -> expo-secure-store)
// being pulled into a jsdom unit test; the ids are all this component reads.
vi.mock('../../../lib/board-render/cvd-preview-options', () => ({
  CVD_PREVIEW_OPTIONS: [
    { id: 'none', titleI18nKey: 't.none', subtitleI18nKey: 's.none', transform: undefined, transformKey: undefined },
    {
      id: 'deuteranopia',
      titleI18nKey: 't.deuteranopia',
      subtitleI18nKey: 's.deuteranopia',
      transform: (hex: string) => hex,
      transformKey: 'cvd-deuteranopia',
    },
  ],
}));
const { CvdPreviewCarousel } = await import('../CvdPreviewCarousel');

const PREVIEW = {
  frames: 'p1r12',
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  boardWidth: 1080,
  boardHeight: 1350,
};

function openFirstCard() {
  const press = cards.press.get('deuteranopia');
  act(() => press?.('deuteranopia'));
}

/** A full user close: the sheet reports the close, then the animation settles. */
function closeCompletely() {
  act(() => sheet.onClose?.());
  act(() => sheet.onFullyDismissed?.());
}

beforeEach(() => {
  cards.press.clear();
  sheet.visible = false;
  sheet.hasBoard = false;
});
afterEach(cleanup);

describe('CvdPreviewCarousel — enlarging a preview', () => {
  it('still opens on the third try', () => {
    render(<CvdPreviewCarousel preview={PREVIEW} />);

    for (const attempt of [1, 2, 3]) {
      openFirstCard();
      expect(sheet.visible, `attempt ${attempt} should open the sheet`).toBe(true);
      closeCompletely();
      expect(sheet.visible, `attempt ${attempt} should close the sheet`).toBe(false);
    }
  });

  it('keeps the board mounted while the sheet is still closing', () => {
    render(<CvdPreviewCarousel preview={PREVIEW} />);
    openFirstCard();

    // The close is reported, but the animation has NOT settled yet.
    act(() => sheet.onClose?.());
    expect(sheet.visible).toBe(false);
    expect(sheet.hasBoard).toBe(true);

    act(() => sheet.onFullyDismissed?.());
    expect(sheet.hasBoard).toBe(false);
  });

  it('reopens even if a close is only ever reported as fully dismissed', () => {
    // The backstop: whichever signal arrives, the id must not be left stale.
    render(<CvdPreviewCarousel preview={PREVIEW} />);
    openFirstCard();
    act(() => sheet.onFullyDismissed?.());

    openFirstCard();
    expect(sheet.visible).toBe(true);
  });
});
