// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MoreFormModel, MoreSelectRow } from '../MoreForm.types';

const nativeClick = vi.hoisted(() => ({ current: null as (() => void) | null }));

// Keep the real Android menu handlers; only native views become DOM elements.
vi.mock('@expo/ui', () => ({ Host: ({ children }: { children?: ReactNode }) => createElement('div', null, children) }));
vi.mock('@expo/ui/jetpack-compose', () => {
  const Container = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const DropdownMenu = Object.assign(Container, { Trigger: Container, Items: Container });
  const DropdownMenuItem = Object.assign(
    ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => {
      nativeClick.current = onClick ?? null;
      return createElement('button', { onClick }, children);
    },
    { LeadingIcon: Container, Text: Container },
  );
  return {
    DropdownMenu,
    DropdownMenuItem,
    Row: Container,
    Text: Container,
    IconButton: Container,
    Icon: () => null,
    HorizontalDivider: () => null,
  };
});
vi.mock('@expo/ui/jetpack-compose/modifiers', () => ({ clickable: () => ({}), padding: () => ({}) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (options: { android?: unknown }) => options.android },
  PlatformColor: (name: string) => name,
  StyleSheet: { create: (styles: unknown) => styles },
  ActivityIndicator: () => null,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../providers/theme-provider', async () => {
  const { makeThemeMock } = await import('../../test/theme-mock');
  const theme = makeThemeMock({ variant: 'material' });
  return { useTheme: () => theme };
});
vi.mock('../AppMenu', async () => import('../AppMenu.android'));
vi.mock('../AppMenu.icons.android', () => ({ MORE_VERT_ICON: 1 }));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../PressableSurface', () => ({ PressableSurface: () => null }));
vi.mock('../Icon', () => ({ Icon: () => null }));
vi.mock('../ListRow', () => ({ ListRow: () => null }));
vi.mock('../SectionHeader', () => ({ SectionHeader: () => null }));
vi.mock('../SegmentedControl', () => ({ SegmentedControl: () => null }));
vi.mock('../SwitchRow', () => ({ SwitchRow: () => null }));
vi.mock('../settings/MarkerMultiplierSlider', () => ({ MarkerMultiplierSlider: () => null }));

import { MoreFormRN } from '../MoreForm.rn';

function modelFor(row: MoreSelectRow): MoreFormModel {
  return { sections: [{ key: 'settings', rows: [row] }] };
}

afterEach(() => {
  cleanup();
  nativeClick.current = null;
});

describe('MoreFormRN with the Android AppMenu', () => {
  it('preserves current and queued selections after an identical option rebuild', () => {
    const initialSelection = vi.fn();
    const currentSelection = vi.fn();
    const row: MoreSelectRow = {
      kind: 'select',
      key: 'timeout',
      label: 'Disconnect timeout',
      selectedKey: '10',
      options: [
        { key: '10', label: '10 seconds' },
        { key: '20', label: '20 seconds' },
      ],
      onSelect: initialSelection,
    };
    const view = render(<MoreFormRN model={modelFor(row)} />);
    // Native may enqueue this item's handler before the parent updates props.
    const queuedItemClick = nativeClick.current;
    view.rerender(
      <MoreFormRN
        model={modelFor({
          ...row,
          options: row.options.map((option) => ({ ...option })),
          onSelect: currentSelection,
        })}
      />,
    );

    fireEvent.click(view.getByRole('button', { name: '20 seconds' }));
    expect(currentSelection).toHaveBeenCalledTimes(1);
    act(() => queuedItemClick?.());
    expect(currentSelection).toHaveBeenCalledTimes(2);
    expect(currentSelection).toHaveBeenLastCalledWith('20');
    expect(initialSelection).not.toHaveBeenCalled();
  });
});
