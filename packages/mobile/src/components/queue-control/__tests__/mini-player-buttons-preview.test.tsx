// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('react-native', () => ({
  View: ({
    children,
    testID,
    accessibilityLabel,
    style,
  }: {
    children?: ReactNode;
    testID?: string;
    accessibilityLabel?: string;
    style?: unknown;
  }) => {
    const flattened = Object.assign({}, ...[style].flat(10).filter(Boolean));
    return createElement(
      'div',
      { 'data-testid': testID, 'aria-label': accessibilityLabel, 'data-flex': flattened.flex },
      children,
    );
  },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('../../../theme/tokens', () => ({
  borderRadius: { sm: 4, md: 8, lg: 12 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { success: 'green', primary: 'purple' },
    systemColors: {
      label: 'label',
      secondaryLabel: 'secondary',
      separator: 'separator',
      secondaryBackground: 'surface',
      tertiaryFill: 'fill',
    },
  }),
}));

import { FALLBACK_PREVIEW_BOARD } from '../../player-buttons/PlayerButtonsPreview';
import { MiniPlayerButtonsPreview } from '../MiniPlayerButtonsPreview';
import { publishMeasuredMiniPlayerBar, resetMeasuredMiniPlayerBar } from '../../../lib/mini-player-measured-bar-store';
import { DEFAULT_MINI_PLAYER_BUTTONS } from '../../../lib/mini-player-buttons';

afterEach(() => {
  cleanup();
  resetMeasuredMiniPlayerBar();
});

const TENSION = { ...FALLBACK_PREVIEW_BOARD, supportsMirroring: true };
const iconsIn = (element: Element) =>
  [...element.querySelectorAll('[data-icon]')].map((icon) => icon.getAttribute('data-icon'));

function preview(overrides: Partial<Parameters<typeof MiniPlayerButtonsPreview>[0]> = {}) {
  const screen = render(
    createElement(MiniPlayerButtonsPreview, {
      buttons: DEFAULT_MINI_PLAYER_BUTTONS,
      board: FALLBACK_PREVIEW_BOARD,
      wide: false,
      signedIn: true,
      ...overrides,
    }),
  );
  return {
    screen,
    open: iconsIn(screen.getByTestId('mini-player-preview-open')),
    collapsed: iconsIn(screen.getByTestId('mini-player-preview-collapsed')),
  };
}

describe('MiniPlayerButtonsPreview', () => {
  it('draws an iPhone bar of three slots: the first button that is on, then Board light and Log', () => {
    const { open, collapsed } = preview();
    expect(open).toEqual(['skip.next', 'lightbulb', 'tick.outline']);
    // Collapsed keeps one slot: the bulb while the board is free.
    expect(collapsed).toEqual(['lightbulb']);
  });

  it("draws a wide bar in Music's iPad layout: ⏮ ⏭ filled, the others, then ⋯ 💡 and the hero ✓", () => {
    const { open, collapsed } = preview({ wide: true, board: TENSION });
    expect(open).toEqual([
      'skip.previous.fill',
      'skip.next.fill',
      'mirror',
      'favorite',
      'more',
      'lightbulb',
      'checkmark.circle.fill',
    ]);
    // The collapsed bar keeps its one slot, as on an iPhone.
    expect(collapsed).toEqual(['lightbulb']);
  });

  it("says ⋯ in the wide bar's sentence", () => {
    const { screen } = preview({ wide: true, board: TENSION });
    expect(screen.getByTestId('mini-player-preview-open').getAttribute('aria-label')).toContain(
      'mobile.settings.miniPlayer.more',
    );
  });

  it('leaves Mirror off a board that cannot mirror, and Angle off a fixed-angle board', () => {
    const buttons = {
      order: DEFAULT_MINI_PLAYER_BUTTONS.order,
      visible: { ...DEFAULT_MINI_PLAYER_BUTTONS.visible, angle: true },
    };
    const kilter = preview({ wide: true, buttons, board: { ...FALLBACK_PREVIEW_BOARD, angleAvailable: false } });
    expect(kilter.open).toEqual([
      'skip.previous.fill',
      'skip.next.fill',
      'favorite',
      'more',
      'lightbulb',
      'checkmark.circle.fill',
    ]);
  });

  it("follows the climber's order for the others and keeps previous and next together, first", () => {
    const buttons = {
      order: ['share', 'next', 'favorite', 'previous', 'mirror', 'queue', 'angle'] as const,
      visible: { ...DEFAULT_MINI_PLAYER_BUTTONS.visible, share: true, favorite: true },
    };
    const { open } = preview({ wide: true, buttons, board: TENSION });
    expect(open).toEqual([
      'skip.previous.fill',
      'skip.next.fill',
      'share',
      'favorite',
      'mirror',
      'more',
      'lightbulb',
      'checkmark.circle.fill',
    ]);
  });

  it('on an iPhone the first button in the list that is on takes the third slot', () => {
    const buttons = {
      order: ['share', 'next', 'favorite', 'previous', 'mirror', 'queue', 'angle'] as const,
      visible: { ...DEFAULT_MINI_PLAYER_BUTTONS.visible, share: true },
    };
    expect(preview({ buttons }).open).toEqual(['share', 'lightbulb', 'tick.outline']);
  });

  it('draws only Board light and Log with every button off, and says each bar in one sentence', () => {
    const allOff = {
      order: DEFAULT_MINI_PLAYER_BUTTONS.order,
      visible: Object.fromEntries(DEFAULT_MINI_PLAYER_BUTTONS.order.map((id) => [id, false])) as Record<
        (typeof DEFAULT_MINI_PLAYER_BUTTONS.order)[number],
        boolean
      >,
    };
    const { screen, open } = preview({ buttons: allOff });
    expect(open).toEqual(['lightbulb', 'tick.outline']);
    expect(screen.getByTestId('mini-player-preview-open').getAttribute('aria-label')).toBe(
      'mobile.settings.miniPlayer.previewLabel ' +
        JSON.stringify({
          shape: 'mobile.settings.miniPlayer.shapeOpen',
          buttons: 'mobile.settings.playerButtons.fixed.boardLight, mobile.settings.playerButtons.fixed.log',
        }),
    );
  });

  it('leaves Favorite and Queue out when signed out, as the bar does', () => {
    const buttons = {
      order: DEFAULT_MINI_PLAYER_BUTTONS.order,
      visible: { ...DEFAULT_MINI_PLAYER_BUTTONS.visible, favorite: true, queue: true },
    };
    const signedIn = preview({ wide: true, buttons, board: TENSION }).open;
    expect(signedIn).toEqual([
      'skip.previous.fill',
      'skip.next.fill',
      'mirror',
      'favorite',
      'queue',
      'more',
      'lightbulb',
      'checkmark.circle.fill',
    ]);
    cleanup();
    const signedOut = preview({ wide: true, buttons, board: TENSION, signedIn: false }).open;
    expect(signedOut).toEqual([
      'skip.previous.fill',
      'skip.next.fill',
      'mirror',
      'more',
      'lightbulb',
      'checkmark.circle.fill',
    ]);
  });

  it("draws the width the bar measured: an iPhone Duo's closed display (290pt) holds Board light alone", () => {
    publishMeasuredMiniPlayerBar({ rowWidth: 290, widthBesideName: 68 });
    const { open, collapsed } = preview();
    expect(open).toEqual(['lightbulb']);
    expect(collapsed).toEqual(['lightbulb']);
  });

  it('falls back to the representative widths when the bar has not drawn', () => {
    expect(preview().open).toEqual(['skip.next', 'lightbulb', 'tick.outline']);
    cleanup();
    expect(preview({ wide: true, board: TENSION }).open).toContain('mirror');
  });
});
