// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MoreFormModel, MoreSelectRow } from '../MoreForm.types';

// MoreForm.android require()s Android vector-drawable .xml assets, which Metro
// treats as assets; node cannot parse them, so stub the extension to a number.
vi.hoisted(() => {
  // oxlint-disable-next-line no-require-imports
  const nodeModule = require('node:module') as { _extensions: Record<string, (target: { exports: unknown }) => void> };
  nodeModule._extensions['.xml'] = (target) => {
    target.exports = 1;
  };
});

vi.mock('@expo/ui', () => ({
  Host: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-testid': 'compose-host' }, children),
}));
// The select row's exposed dropdown, recorded: Compose throws natively unless
// the anchor and the menu are direct children of the box, so the test reads
// the box's own children, and each item's modifiers and handlers.
type RecordedModifier = { name: string; args: unknown[] };
const compose = vi.hoisted(() => ({
  boxChildren: [] as { kind: string; modifiers: RecordedModifier[] }[][],
  boxExpanded: [] as boolean[],
  onExpandedChange: null as ((expanded: boolean) => void) | null,
  onDismissRequest: null as (() => void) | null,
  items: [] as { modifiers: RecordedModifier[]; onClick?: () => void }[],
}));
vi.mock('@expo/ui/jetpack-compose', async () => {
  const { Children, isValidElement } = await import('react');
  const Container = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const WithSlots = Object.assign(Container, {
    Trigger: Container,
    Items: Container,
    LeadingIcon: Container,
    Text: Container,
  });
  const Row = ({ children }: { children?: ReactNode; modifiers?: RecordedModifier[] }) =>
    createElement('div', null, children);
  const ExposedDropdownMenu = ({
    children,
    onDismissRequest,
  }: {
    children?: ReactNode;
    expanded: boolean;
    onDismissRequest?: () => void;
  }) => {
    compose.onDismissRequest = onDismissRequest ?? null;
    return createElement('div', { 'data-menu': 'true' }, children);
  };
  const ExposedDropdownMenuBox = ({
    children,
    expanded,
    onExpandedChange,
  }: {
    children?: ReactNode;
    expanded: boolean;
    onExpandedChange?: (expanded: boolean) => void;
  }) => {
    compose.boxExpanded.push(expanded);
    compose.onExpandedChange = onExpandedChange ?? null;
    compose.boxChildren.push(
      Children.toArray(children)
        .filter(isValidElement)
        .map((child) => {
          const props = child.props as { modifiers?: RecordedModifier[] };
          return {
            kind: child.type === Row ? 'Row' : child.type === ExposedDropdownMenu ? 'ExposedDropdownMenu' : 'other',
            modifiers: props.modifiers ?? [],
          };
        }),
    );
    return createElement('div', null, children);
  };
  const DropdownMenuItem = Object.assign(
    ({
      children,
      modifiers,
      onClick,
    }: {
      children?: ReactNode;
      modifiers?: RecordedModifier[];
      onClick?: () => void;
    }) => {
      compose.items.push({ modifiers: modifiers ?? [], onClick });
      return createElement('div', null, children);
    },
    { LeadingIcon: Container, Text: Container },
  );
  return {
    LazyColumn: Container,
    Card: Container,
    Column: Container,
    Row,
    ExposedDropdownMenuBox,
    ExposedDropdownMenu,
    Text: Container,
    Switch: Container,
    Button: Container,
    TextButton: Container,
    Badge: Container,
    Icon: Container,
    IconButton: Container,
    Spacer: Container,
    SingleChoiceSegmentedButtonRow: Container,
    SegmentedButton: Container,
    DropdownMenu: WithSlots,
    DropdownMenuItem,
    BasicTextField: Container,
    Slider: Container,
    CircularProgressIndicator: Container,
    useNativeState: (initial: unknown) => ({ value: initial }),
  };
});
vi.mock('@expo/ui/jetpack-compose/modifiers', () => {
  const modifier =
    (name: string) =>
    (...args: unknown[]) => ({ name, args });
  return {
    fillMaxWidth: modifier('fillMaxWidth'),
    padding: modifier('padding'),
    alpha: modifier('alpha'),
    weight: modifier('weight'),
    clickable: modifier('clickable'),
    size: modifier('size'),
    semantics: modifier('semantics'),
    menuAnchor: modifier('menuAnchor'),
    selectable: modifier('selectable'),
  };
});
vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (options: { android?: unknown }) => options.android },
  PlatformColor: (name: string) => name,
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../providers/theme-provider', async () => {
  const { makeThemeMock } = await import('../../test/theme-mock');
  const theme = makeThemeMock({ variant: 'material' });
  return { useTheme: () => theme };
});
import { MoreForm } from '../MoreForm.android';

const customModel: MoreFormModel = {
  sections: [
    { key: 'first', rows: [{ kind: 'value', key: 'v', label: 'Label', value: 'x' }] },
    {
      key: 'second',
      rows: [{ kind: 'custom', key: 'preview', content: createElement('span', null, 'Preview'), height: 120 }],
    },
  ],
};
const plainModel: MoreFormModel = {
  sections: [{ key: 'only', rows: [{ kind: 'value', key: 'v', label: 'Label', value: 'x' }] }],
};

afterEach(() => {
  cleanup();
  compose.boxChildren = [];
  compose.boxExpanded = [];
  compose.onExpandedChange = null;
  compose.onDismissRequest = null;
  compose.items = [];
});

describe('MoreForm on Android with custom rows', () => {
  it('fails loudly in dev when handed a custom row', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(createElement(MoreForm, { model: customModel }))).toThrow(/custom row "preview"/);
    vi.restoreAllMocks();
  });

  it('keeps the same Compose host when a model gains a section on rerender', () => {
    const { getByTestId, rerender } = render(createElement(MoreForm, { model: plainModel }));
    const host = getByTestId('compose-host');
    rerender(
      createElement(MoreForm, {
        model: {
          sections: [
            ...plainModel.sections,
            { key: 'extra', rows: [{ kind: 'value', key: 'w', label: 'W', value: 'y' }] },
          ],
        },
      }),
    );
    expect(getByTestId('compose-host')).toBe(host);
  });
});

describe('MoreForm on Android: a select row', () => {
  it('marks the current choice in the open menu with a ✓, and only that one', () => {
    const { container } = render(
      createElement(MoreForm, {
        model: {
          sections: [
            {
              key: 'keep',
              rows: [
                {
                  kind: 'select',
                  key: 'keep',
                  label: 'Keep lighting after Put on board',
                  selectedKey: '45',
                  options: [
                    { key: 'off', label: 'Off' },
                    { key: '45', label: '45 seconds' },
                    { key: '60', label: '1 minute' },
                  ],
                  onSelect: () => undefined,
                },
              ],
            },
          ],
        },
      }),
    );
    const text = container.textContent ?? '';
    expect(text.split('✓')).toHaveLength(2);
    expect(text).toContain('✓45 seconds');
  });

  // TalkBack (spec B4): the row reads as a drop-down list, and the open menu
  // gives the current choice the selected state as well as the ✓.
  function renderSelect(row: Partial<MoreSelectRow> = {}) {
    const onSelect = vi.fn();
    const view = render(
      createElement(MoreForm, {
        model: {
          sections: [
            {
              key: 'keep',
              rows: [
                {
                  kind: 'select',
                  key: 'keep',
                  label: 'Keep lighting after Put on board',
                  selectedKey: '45',
                  options: [
                    { key: 'off', label: 'Off' },
                    { key: '45', label: '45 seconds' },
                  ],
                  onSelect,
                  ...row,
                },
              ],
            },
          ],
        },
      }),
    );
    return { ...view, onSelect };
  }
  const named = (modifiers: RecordedModifier[], name: string) => modifiers.find((entry) => entry.name === name);

  it('anchors a drop-down list as a direct child of the box, with the menu beside it', () => {
    renderSelect();
    const children = compose.boxChildren.at(-1) ?? [];
    expect(children.map((child) => child.kind)).toEqual(['Row', 'ExposedDropdownMenu']);
    expect(named(children[0]?.modifiers ?? [], 'menuAnchor')?.args).toEqual(['primaryNotEditable', true]);
    // The ripple and the merged label stay.
    expect(named(children[0]?.modifiers ?? [], 'clickable')).toBeDefined();
  });

  it('gives only the current choice the selected state, which picks like a tap', () => {
    const { onSelect } = renderSelect();
    act(() => compose.onExpandedChange?.(true));
    let items = compose.items.slice(-2);
    expect(items.map((item) => named(item.modifiers, 'selectable')?.args[0] ?? null)).toEqual([null, true]);
    const activate = named(items[1]?.modifiers ?? [], 'selectable')?.args[1] as (() => void) | undefined;
    // One tap on the current choice can reach its `selectable` and the item's
    // own click: one pick, one report, and the menu closes.
    act(() => {
      activate?.();
      items[1]?.onClick?.();
    });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('45');
    expect(compose.boxExpanded.at(-1)).toBe(false);

    act(() => compose.onExpandedChange?.(true));
    items = compose.items.slice(-2);
    act(() => items[0]?.onClick?.());
    expect(onSelect).toHaveBeenLastCalledWith('off');
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  // M3's anchor click is a toggle and the row's `clickable` only opens: a tap
  // reaches both, so the box's `false` is dropped or the two would race. The
  // menu closes on a dismiss (an outside tap, back) or a pick.
  it('only opens from the anchor, and closes on a dismiss', () => {
    renderSelect();
    const clickable = named(compose.boxChildren.at(-1)?.[0]?.modifiers ?? [], 'clickable')?.args[0] as
      | (() => void)
      | undefined;
    act(() => {
      compose.onExpandedChange?.(true);
      clickable?.();
    });
    expect(compose.boxExpanded.at(-1)).toBe(true);
    // A second tap on the anchor with the menu open: M3 asks to close, the row opens.
    act(() => {
      compose.onExpandedChange?.(false);
      clickable?.();
    });
    expect(compose.boxExpanded.at(-1)).toBe(true);
    act(() => compose.onExpandedChange?.(false));
    expect(compose.boxExpanded.at(-1)).toBe(true);

    act(() => compose.onDismissRequest?.());
    expect(compose.boxExpanded.at(-1)).toBe(false);
  });

  it('opens from the box and never for a disabled row', () => {
    renderSelect();
    expect(compose.boxExpanded.at(-1)).toBe(false);
    act(() => compose.onExpandedChange?.(true));
    expect(compose.boxExpanded.at(-1)).toBe(true);
    cleanup();
    renderSelect({ disabled: true });
    act(() => compose.onExpandedChange?.(true));
    expect(compose.boxExpanded.at(-1)).toBe(false);
    const anchor = compose.boxChildren.at(-1)?.[0]?.modifiers ?? [];
    expect(named(anchor, 'menuAnchor')?.args).toEqual(['primaryNotEditable', false]);
    expect(named(anchor, 'clickable')).toBeUndefined();
  });
});
