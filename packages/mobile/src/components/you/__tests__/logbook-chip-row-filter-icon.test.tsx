// @vitest-environment jsdom
//
// Locks the icon-only Filter chip (#3782). The iOS chip row is platform-split, so
// it is imported by its EXPLICIT `.ios` path — the extensionless specifier is
// aliased to a null stub in packages/mobile/vite.config.ts, and `.ios` sidesteps
// that alias. @expo/ui resolves native views at module load, so the SwiftUI
// surface is mocked and the assertions run against the props/modifiers the row
// hands the native Button.
//
// NOTE: the mobile vitest config inlines `__DEV__: 'true'` (a define, not a
// global), so this suite never gates on `!__DEV__`.
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOGBOOK_FILTERS, type LogbookFilterState } from '@boardsesh/logbook';
import type { Grade } from '@boardsesh/shared-schema';

type ModifierRecord = { modifier: string; arg?: unknown };
type ButtonRecord = { label?: string; systemImage?: string; modifiers?: ModifierRecord[] };

const captured = vi.hoisted(() => ({ buttons: [] as ButtonRecord[] }));

// Each modifier factory records its name + argument so the test can assert the
// exact SwiftUI modifiers applied to the Filter chip.
vi.mock('@expo/ui/swift-ui/modifiers', () => {
  const make =
    (modifier: string) =>
    (arg?: unknown): ModifierRecord => ({ modifier, arg });
  return {
    buttonStyle: make('buttonStyle'),
    controlSize: make('controlSize'),
    tint: make('tint'),
    foregroundColor: make('foregroundColor'),
    padding: make('padding'),
    menuActionDismissBehavior: make('menuActionDismissBehavior'),
    labelStyle: make('labelStyle'),
    accessibilityLabel: make('accessibilityLabel'),
  };
});

vi.mock('@expo/ui/swift-ui', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Host: passthrough,
    ScrollView: passthrough,
    HStack: passthrough,
    Menu: passthrough,
    Toggle: () => null,
    Button: (props: ButtonRecord) => {
      captured.buttons.push(props);
      return null;
    },
  };
});

vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T): T => styles },
  // src/theme/colors.ts reads Platform.OS / PlatformColor at module load.
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));

vi.mock('react-i18next', () => ({
  // Return the key so the assertions can name the exact catalog key in play.
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { accent: '#F5A524' } }),
}));

vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (name: string) => name }),
}));

// Imported after the mocks so the module graph resolves against them.
const { LogbookChipRow } = await import('../LogbookChipRow.ios');

const GRADES: Grade[] = [
  { difficultyId: 10, name: '6a' },
  { difficultyId: 14, name: '6b' },
];

function renderRow(filters: LogbookFilterState = DEFAULT_LOGBOOK_FILTERS) {
  captured.buttons = [];
  render(
    createElement(LogbookChipRow, {
      sortPreset: 'recent' as const,
      onSelectPreset: vi.fn(),
      onOpenFilters: vi.fn(),
      filters,
      grades: GRADES,
      onToggleFacet: vi.fn(),
      onUpdateFilters: vi.fn(),
    }),
  );
  const filterButton = captured.buttons[0];
  if (!filterButton) throw new Error('the Filter chip did not render');
  return filterButton;
}

function modifierNames(button: ButtonRecord): string[] {
  return (button.modifiers ?? []).map((entry) => entry.modifier);
}

describe('LogbookChipRow.ios Filter chip', () => {
  it('renders the filter symbol with the title dropped from layout', () => {
    const filterButton = renderRow();

    expect(filterButton.systemImage).toBe('line.3.horizontal.decrease');
    // Icon-only: without this the SwiftUI Label lays the title out beside the
    // symbol and the glass HStack compresses it to "F…" (#3782).
    expect(filterButton.modifiers).toContainEqual({ modifier: 'labelStyle', arg: 'iconOnly' });
  });

  it('keeps the mobile.logbook.filter wording as the accessible name', () => {
    const filterButton = renderRow();

    // @expo/ui only renders `systemImage` when a `label` is present, so the title
    // must still be passed even though iconOnly hides it.
    expect(filterButton.label).toBe('mobile.logbook.filter');
    expect(filterButton.modifiers).toContainEqual({
      modifier: 'accessibilityLabel',
      arg: 'mobile.logbook.filter',
    });
  });

  it('keeps the neutral-glass chip styling alongside the icon-only modifiers', () => {
    const filterButton = renderRow();

    // Default filters ⇒ no facet active ⇒ neutral glass, not amber prominent.
    expect(filterButton.modifiers).toContainEqual({ modifier: 'buttonStyle', arg: 'glass' });
    expect(modifierNames(filterButton)).toEqual(['buttonStyle', 'controlSize', 'labelStyle', 'accessibilityLabel']);
  });

  it('keeps the icon-only modifiers on the amber chip once a facet is set', () => {
    // A grade bound makes the grade facet active ⇒ anyFilterActive ⇒ amber
    // prominent glass. The icon-only pair must survive that longer modifier list,
    // otherwise the chip regresses to "F…" exactly when a filter is in play.
    const filterButton = renderRow({ ...DEFAULT_LOGBOOK_FILTERS, minGrade: 10 });

    expect(filterButton.modifiers).toContainEqual({ modifier: 'buttonStyle', arg: 'glassProminent' });
    expect(modifierNames(filterButton)).toEqual([
      'buttonStyle',
      'controlSize',
      'tint',
      'foregroundColor',
      'labelStyle',
      'accessibilityLabel',
    ]);
  });

  it('leaves the other chips as plain text chips', () => {
    renderRow();

    const otherButtons = captured.buttons.slice(1);
    expect(otherButtons.length).toBeGreaterThan(0);
    for (const button of otherButtons) {
      expect(button.systemImage).toBeUndefined();
      expect(modifierNames(button)).not.toContain('labelStyle');
    }
  });
});
