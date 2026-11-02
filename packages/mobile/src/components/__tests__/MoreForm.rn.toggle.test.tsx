// @vitest-environment jsdom
// MoreFormRN's switch rows (Android Settings › Board renders through it): a
// row named on its own and, while greyed out, its reason at full contrast
// outside the dimmed switch (spec B4.1).
import { createElement, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MoreFormModel, MoreToggleRow } from '../MoreForm.types';
import type { SwitchRowProps } from '../SwitchRow.types';

const seen = vi.hoisted(() => ({
  switchRows: [] as SwitchRowProps[],
  texts: [] as { text: ReactNode; color?: string }[],
}));
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  ActivityIndicator: () => null,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: 'label', secondaryLabel: 'secondaryLabel' } }),
}));
vi.mock('../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
  borderRadius: { lg: 12 },
}));
vi.mock('../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: string }) => {
    seen.texts.push({ text: children, color });
    return createElement('span', null, children);
  },
}));
vi.mock('../PressableSurface', () => ({ PressableSurface: () => null }));
vi.mock('../Icon', () => ({ Icon: () => null }));
vi.mock('../ListRow', () => ({ ListRow: () => null }));
vi.mock('../AppMenu', () => ({ AppMenu: () => null }));
vi.mock('../SectionHeader', () => ({ SectionHeader: () => null }));
vi.mock('../SegmentedControl', () => ({ SegmentedControl: () => null }));
vi.mock('../SwitchRow', () => ({
  SwitchRow: (props: SwitchRowProps) => {
    seen.switchRows.push(props);
    return null;
  },
}));
vi.mock('../settings/MarkerMultiplierSlider', () => ({ MarkerMultiplierSlider: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const { MoreFormRN } = await vi.importActual<typeof import('../MoreForm.rn')>('../MoreForm.rn');

const REASON = 'Turn on Keep lighting after Put on board to use this.';

function sessionRow(overrides: Partial<MoreToggleRow> = {}): MoreToggleRow {
  return {
    kind: 'toggle',
    key: 'putOnBoardDrivesInSession',
    label: 'In a session too',
    accessibilityLabel: 'Keep lighting in a session too',
    subtitle: 'With a crew in your session',
    disabledReason: REASON,
    value: false,
    disabled: true,
    onValueChange: vi.fn(),
    ...overrides,
  };
}

function renderRow(row: MoreToggleRow) {
  const model: MoreFormModel = { sections: [{ key: 'keepLighting', rows: [row] }] };
  render(createElement(MoreFormRN, { model }));
  const switchRow = seen.switchRows.at(-1);
  if (!switchRow) throw new Error('no SwitchRow');
  return switchRow;
}

afterEach(() => {
  cleanup();
  seen.switchRows = [];
  seen.texts = [];
});

describe('MoreFormRN switch rows', () => {
  it('names the switch on its own, not by the bare "In a session too"', () => {
    expect(renderRow(sessionRow()).accessibilityLabel).toBe('Keep lighting in a session too');
  });

  it('draws a greyed-out row’s reason outside the dimmed switch, in the full label colour', () => {
    const switchRow = renderRow(sessionRow());
    // Not inside SwitchRow, where the greyed row's alpha would dim it.
    expect(switchRow.description).toBeUndefined();
    expect(seen.texts).toContainEqual({ text: REASON, color: 'label' });
  });

  it('keeps the subtitle as the switch’s own line while the row is on offer', () => {
    const switchRow = renderRow(sessionRow({ disabled: false }));
    expect(switchRow.description).toBe('With a crew in your session');
    expect(seen.texts.map(({ text }) => text)).not.toContain(REASON);
  });
});
