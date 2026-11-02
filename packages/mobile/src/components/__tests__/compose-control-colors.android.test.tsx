// @vitest-environment jsdom
// The tonal Button and the RadioGroup radio used to take colours the Compose
// scheme filled in from the phone's wallpaper (#6919). These check the Velvet
// colour sets actually reach the Compose controls, not just that the helpers
// compute them.
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Button.android `require()`s its Material icons as `.xml` assets, which Metro
// bundles and Node can't parse; stand each one in as its path.
vi.hoisted(() => {
  const nodeModule = process.getBuiltinModule('node:module') as unknown as {
    _extensions: Record<string, (module: { exports: unknown }, filename: string) => void>;
  };
  nodeModule._extensions['.xml'] = (module, filename) => {
    module.exports = filename;
  };
});

const composeProps = vi.hoisted(() => ({ byControl: {} as Record<string, Array<Record<string, unknown>>> }));

vi.mock('react-native', () => ({
  StyleSheet: { create: <Styles,>(styles: Styles) => styles },
  useWindowDimensions: () => ({ fontScale: 1 }),
  Platform: { OS: 'android', select: (options: { android?: unknown }) => options.android },
  PlatformColor: (name: string) => name,
}));
vi.mock('@expo/ui', () => ({
  Host: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('@expo/ui/jetpack-compose', () => {
  const recorder = (name: string) => (props: Record<string, unknown> & { children?: ReactNode }) => {
    (composeProps.byControl[name] ??= []).push(props);
    return createElement('div', null, props.children);
  };
  return {
    Button: recorder('Button'),
    FilledTonalButton: recorder('FilledTonalButton'),
    OutlinedButton: recorder('OutlinedButton'),
    TextButton: recorder('TextButton'),
    CircularProgressIndicator: recorder('CircularProgressIndicator'),
    Icon: recorder('Icon'),
    Row: recorder('Row'),
    Column: recorder('Column'),
    Text: recorder('Text'),
    RadioButton: recorder('RadioButton'),
  };
});
vi.mock('@expo/ui/jetpack-compose/modifiers', () => ({
  defaultMinSize: () => ({}),
  fillMaxWidth: () => ({}),
  height: () => ({}),
  padding: () => ({}),
  size: () => ({}),
  weight: () => ({}),
  alpha: () => ({}),
  selectable: () => ({}),
  selectableGroup: () => ({}),
}));
vi.mock('../../lib/haptics', () => ({ hapticSelection: vi.fn(), hapticLight: vi.fn() }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { primary: '#A78BFA', primaryFill: '#7C3AED', onPrimary: '#FFFFFF', error: '#F87171' },
    m3: {
      outline: '#817B8D',
      surfaceVariant: '#1D132F',
      onSurfaceVariant: '#A9A2B6',
      secondaryContainer: 'rgba(124, 58, 237, 0.28)',
      onSecondaryContainer: '#EADDFF',
    },
    colorScheme: 'dark',
  }),
}));

const { Button } = await import('../Button.android');
const { RadioGroup } = await import('../RadioGroup.android');

describe('Compose control colours', () => {
  it('fills a tonal button from Velvet and spins in its content colour', () => {
    composeProps.byControl = {};
    render(createElement(Button, { title: 'Try again', variant: 'tonal', loading: true, onPress: vi.fn() }));

    expect(composeProps.byControl.FilledTonalButton?.[0]?.colors).toEqual({
      containerColor: 'rgba(124, 58, 237, 0.28)',
      contentColor: '#EADDFF',
    });
    expect(composeProps.byControl.CircularProgressIndicator?.[0]?.color).toBe('#EADDFF');
  });

  it('dots the selected radio in the control tint', () => {
    composeProps.byControl = {};
    render(
      createElement(RadioGroup, {
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
        value: 'a',
        onChange: vi.fn(),
      }),
    );

    const radios = composeProps.byControl.RadioButton ?? [];
    expect(radios).toHaveLength(2);
    for (const radio of radios) {
      expect(radio.colors).toEqual({ selectedColor: '#A78BFA', unselectedColor: '#A9A2B6' });
    }
  });
});
