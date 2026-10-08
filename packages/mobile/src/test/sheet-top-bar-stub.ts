// A DOM stand-in for SheetTopBar, for tests that hand-mock react-native and the
// sheet wrappers. It keeps what a test needs to drive the bar: the leading and
// trailing actions as buttons (same testIDs as the real bar), the title, and the
// error text. Use it with
//   vi.mock('../../SheetTopBar', async () => (await import('<rel>/test/sheet-top-bar-stub')).sheetTopBarModule);
// and make the mocked ModalSheet / Sheet render their `header` prop.
import { createElement } from 'react';

type StubAction = {
  label?: string;
  kind?: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
};

type StubProps = {
  title: string;
  subtitle?: string;
  leading?: StubAction;
  trailing?: StubAction;
  error?: string | null;
};

export function SheetTopBar({ title, subtitle, leading, trailing, error }: StubProps) {
  return createElement(
    'div',
    { 'data-sheet-top-bar': 'true' },
    leading
      ? createElement(
          'button',
          {
            type: 'button',
            'data-testid': 'sheet-top-bar-leading',
            'data-kind': leading.kind,
            'aria-label': leading.accessibilityLabel,
            onClick: leading.onPress,
          },
          leading.kind,
        )
      : null,
    createElement('span', { 'data-testid': 'sheet-top-bar-title' }, title),
    subtitle ? createElement('span', { 'data-testid': 'sheet-top-bar-subtitle' }, subtitle) : null,
    trailing
      ? createElement(
          'button',
          {
            type: 'button',
            'data-testid': 'sheet-top-bar-trailing',
            'data-button': trailing.label,
            'aria-label': trailing.accessibilityLabel,
            'data-loading': trailing.loading ? 'true' : 'false',
            disabled: Boolean(trailing.disabled || trailing.loading),
            onClick: trailing.disabled || trailing.loading ? undefined : trailing.onPress,
          },
          trailing.loading ? createElement('span', { role: 'progressbar' }) : null,
          trailing.label,
        )
      : null,
    error ? createElement('span', { 'data-testid': 'sheet-top-bar-error' }, error) : null,
  );
}

export const sheetTopBarModule = { SheetTopBar };
