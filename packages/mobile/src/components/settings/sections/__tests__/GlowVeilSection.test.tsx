// @vitest-environment jsdom
//
// Visibility guard for the plateau-share slider (issue #2202): it only makes
// sense while the glow is actually falling off as a plateau, so it must track
// the EFFECTIVE falloff — not the raw picker — the same way the preset row and
// the Classic marker rows track their effective/raw split elsewhere on this
// screen (see BoardLookSettingsScreen.test.tsx). A future rollout flag that
// resolves `default` to `plateau` must surface the slider even though the
// climber never touched the falloff control.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { DEFAULT_BOARDSESH_RENDER_SETTINGS, type BoardseshRenderSettings } from '../../../../lib/board-render-settings';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  // Something in the render tree reaches `theme/ios-colors.ts`, which reads
  // `Platform.OS` at module top level (outside any component body) — needed
  // even though nothing in this suite exercises a platform branch directly
  // (see BoardLookSettingsScreen.test.tsx, which hits the same import).
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  PlatformColor: (color: string) => color,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      accent: '#6D28D9',
      background: '#ffffff',
      fill: '#eeeeee',
      secondaryLabel: '#888888',
      separator: '#cccccc',
    },
  }),
}));

vi.mock('../../../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('h3', null, title),
}));

vi.mock('../../../SegmentedControl', () => ({
  SegmentedControl: ({ accessibilityLabel }: { accessibilityLabel?: string }) =>
    createElement('div', { role: 'group', 'aria-label': accessibilityLabel }),
}));

// Stubbed to a text-bearing node keyed on `accessibilityLabel` (the same i18n
// key used as each slider's title) so a plain `queryByText` proves whether
// GlowVeilSection decided to render that particular slider at all — the
// slider's own drag/commit behaviour is covered by MarkerMultiplierSlider's
// own test file, not here.
vi.mock('../../MarkerMultiplierSlider', () => ({
  MarkerMultiplierSlider: ({ accessibilityLabel }: { accessibilityLabel: string }) =>
    createElement('div', { 'data-testid': 'slider' }, accessibilityLabel),
  useCommittedSliderValue: (externalValue: number, commit: (value: number) => void) => ({
    draftValue: externalValue,
    setDraftValue: vi.fn(),
    handleChangeEnd: commit,
  }),
}));

const { GlowVeilSection } = await import('../GlowVeilSection');

const BASE_BOARDSESH: BoardseshRenderSettings = { ...DEFAULT_BOARDSESH_RENDER_SETTINGS };
const PLATEAU_SHARE_LABEL = 'mobile.more.boardLook.glowVeil.plateauShare.title';

afterEach(() => {
  cleanup();
});

describe('GlowVeilSection — plateau-share slider visibility', () => {
  it('hides the plateau-share slider when the effective falloff is soft, even if the raw picker is "plateau"', () => {
    const { queryByText } = render(
      <GlowVeilSection
        boardsesh={{ ...BASE_BOARDSESH, glowFalloff: 'plateau' }}
        effectiveGlowFalloff="soft"
        setBoardseshField={vi.fn()}
      />,
    );

    expect(queryByText(PLATEAU_SHARE_LABEL)).toBeNull();
  });

  it('shows the plateau-share slider when the effective falloff is plateau, even if the raw picker is "default"', () => {
    const { queryByText } = render(
      <GlowVeilSection
        boardsesh={{ ...BASE_BOARDSESH, glowFalloff: 'default' }}
        effectiveGlowFalloff="plateau"
        setBoardseshField={vi.fn()}
      />,
    );

    expect(queryByText(PLATEAU_SHARE_LABEL)).not.toBeNull();
  });
});
