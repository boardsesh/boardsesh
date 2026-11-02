// @vitest-environment jsdom
// The SwiftUI settings rows' accessibility (spec B4): a row whose visible label
// leans on the row above carries a name of its own, and a greyed-out switch's
// reason sits outside the disabled Toggle, which would dim it.
import { createElement, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Modifier = { kind: string; args: unknown[] };
type NativeProps = Record<string, unknown> & { children?: ReactNode; modifiers?: Modifier[] };

const nativeCalls = vi.hoisted(() => ({ toggle: [] as NativeProps[], picker: [] as NativeProps[] }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  PlatformColor: (name: string) => name,
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('@expo/ui/swift-ui', () => {
  const passthrough = ({ children }: NativeProps) => createElement('div', null, children);
  const labelOf = (modifiers: Modifier[] | undefined) =>
    modifiers?.find((modifier) => modifier.kind === 'accessibilityLabel')?.args[0] as string | undefined;
  const isDisabled = (modifiers: Modifier[] | undefined) =>
    modifiers?.some((modifier) => modifier.kind === 'disabled' && modifier.args[0] === true) ?? false;
  return {
    Toggle: (props: NativeProps) => {
      nativeCalls.toggle.push(props);
      return createElement(
        'div',
        {
          role: 'switch',
          'aria-label': labelOf(props.modifiers),
          'data-disabled': String(isDisabled(props.modifiers)),
        },
        props.children,
      );
    },
    Picker: (props: NativeProps) => {
      nativeCalls.picker.push(props);
      return createElement('div', { role: 'listbox', 'aria-label': labelOf(props.modifiers) }, props.label as string);
    },
    Text: ({ children, modifiers }: NativeProps) =>
      createElement(
        'span',
        { 'data-modifiers': (modifiers ?? []).map((modifier) => modifier.kind).join(',') },
        children,
      ),
    VStack: passthrough,
    HStack: passthrough,
    Spacer: () => null,
    Button: passthrough,
    Image: () => null,
    Slider: () => null,
    Label: passthrough,
    ProgressView: () => null,
    RNHostView: passthrough,
  };
});
vi.mock('@expo/ui/swift-ui/modifiers', () => {
  const modifier =
    (kind: string) =>
    (...args: unknown[]) => ({ kind, args });
  return {
    pickerStyle: modifier('pickerStyle'),
    tint: modifier('tint'),
    tag: modifier('tag'),
    textSelection: modifier('textSelection'),
    badge: modifier('badge'),
    accessibilityLabel: modifier('accessibilityLabel'),
    accessibilityValue: modifier('accessibilityValue'),
    accessibilityHint: modifier('accessibilityHint'),
    frame: modifier('frame'),
    listRowInsets: modifier('listRowInsets'),
    listRowSeparator: modifier('listRowSeparator'),
    disabled: modifier('disabled'),
    font: modifier('font'),
    foregroundStyle: modifier('foregroundStyle'),
  };
});

import { renderSettingsRow } from '../settings-rows.ios';
import type { MoreSelectRow, MoreToggleRow } from '../MoreForm.types';

const TINTS = { control: '#6D28D9', fill: '#6D28D9' };

const inSession = (disabled: boolean): MoreToggleRow => ({
  kind: 'toggle',
  key: 'putOnBoardDrivesInSession',
  label: 'In a session too',
  accessibilityLabel: 'Keep lighting in a session too',
  subtitle: 'When your phone has the crew’s board.',
  disabledReason: 'Turn on Keep lighting after Put on board to use this.',
  value: true,
  disabled,
  onValueChange: vi.fn(),
});

const modifierKinds = (props: NativeProps | undefined) => (props?.modifiers ?? []).map((modifier) => modifier.kind);

afterEach(() => {
  cleanup();
  nativeCalls.toggle.length = 0;
  nativeCalls.picker.length = 0;
});

describe('renderSettingsRow (iOS)', () => {
  it('names a switch on its own, its description riding as the hint', () => {
    const view = render(createElement('div', null, renderSettingsRow(inSession(false), TINTS)));
    expect(view.getByRole('switch').getAttribute('aria-label')).toBe('Keep lighting in a session too');
    const hint = nativeCalls.toggle.at(-1)?.modifiers?.find((modifier) => modifier.kind === 'accessibilityHint');
    expect(hint?.args[0]).toBe('When your phone has the crew’s board.');
    // The description is still drawn under the label, and no reason is.
    expect(view.getByRole('switch').textContent).toContain('When your phone has the crew’s board.');
    expect(view.queryByText('Turn on Keep lighting after Put on board to use this.')).toBeNull();
  });

  it('draws a greyed switch’s reason outside the disabled Toggle, at full label contrast', () => {
    const view = render(createElement('div', null, renderSettingsRow(inSession(true), TINTS)));
    const toggle = view.getByRole('switch');
    expect(toggle.dataset.disabled).toBe('true');
    expect(toggle.textContent).toBe('In a session too');
    const reason = view.getByText('Turn on Keep lighting after Put on board to use this.');
    expect(toggle.contains(reason)).toBe(false);
    expect(reason.dataset.modifiers).toBe('font,foregroundStyle');
    // No hint: the reason is its own element, read after the switch.
    expect(modifierKinds(nativeCalls.toggle.at(-1))).not.toContain('accessibilityHint');
  });

  it('keeps a plain switch as it was: title and subtitle inside, no name of its own', () => {
    const view = render(
      createElement(
        'div',
        null,
        renderSettingsRow(
          { kind: 'toggle', key: 'plain', label: 'Plain', subtitle: 'Below', value: false, onValueChange: vi.fn() },
          TINTS,
        ),
      ),
    );
    expect(view.getByRole('switch').getAttribute('aria-label')).toBeNull();
    expect(view.getByRole('switch').textContent).toBe('PlainBelow');
    expect(modifierKinds(nativeCalls.toggle.at(-1))).not.toContain('accessibilityHint');
  });

  it('names a select row on its own', () => {
    const row: MoreSelectRow = {
      kind: 'select',
      key: 'putOnBoardKeepsLighting',
      label: 'After',
      accessibilityLabel: 'Stop driving the wall after',
      options: [{ key: 'until_stopped', label: 'Until I stop' }],
      selectedKey: 'until_stopped',
      onSelect: vi.fn(),
    };
    const view = render(createElement('div', null, renderSettingsRow(row, TINTS)));
    expect(view.getByRole('listbox').getAttribute('aria-label')).toBe('Stop driving the wall after');
  });
});
