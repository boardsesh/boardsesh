// @vitest-environment jsdom
// Exercise the actual iOS chip row via its explicit platform path. The default
// extensionless import is aliased to a native-free stub by mobile Vitest.
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOGBOOK_FILTERS, type LogbookFilterState } from '@boardsesh/logbook';
import type { Grade } from '@boardsesh/shared-schema';

type ModifierRecord = { modifier: string; arg?: unknown };
type ButtonRecord = { label?: string; systemImage?: string; modifiers?: ModifierRecord[]; onPress?: () => void };
type ToggleRecord = { label: string; isOn: boolean; onIsOnChange: (next: boolean) => void };

const captured = vi.hoisted(() => ({ buttons: [] as ButtonRecord[], toggles: [] as ToggleRecord[] }));

// Each modifier factory records its name + argument so the test can assert the
// styling applied to the native sort and facet controls.
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
    fixedSize: make('fixedSize'),
  };
});

vi.mock('@expo/ui/swift-ui', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Host: passthrough,
    ScrollView: passthrough,
    HStack: passthrough,
    Menu: passthrough,
    Toggle: (props: ToggleRecord) => {
      captured.toggles.push(props);
      return null;
    },
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
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
}));

vi.mock('react-i18next', () => ({
  // Return the key so the assertions can name the exact catalog key in play.
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primaryFill: '#6D28D9', onPrimary: '#fff' } }),
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

const onSelectPreset = vi.fn();
const onToggleFacet = vi.fn();
const onUpdateFilters = vi.fn();

beforeEach(() => {
  captured.buttons = [];
  captured.toggles = [];
  vi.clearAllMocks();
});

function renderRow(filters: LogbookFilterState = DEFAULT_LOGBOOK_FILTERS) {
  render(
    createElement(LogbookChipRow, {
      sortPreset: 'recent',
      onSelectPreset,
      filters,
      grades: GRADES,
      onToggleFacet,
      onUpdateFilters,
    }),
  );
}

function buttonByLabel(label: string): ButtonRecord {
  const button = captured.buttons.find((button) => button.label === label);
  if (!button) throw new Error(`missing chip ${label}`);
  return button;
}

function toggleByLabel(label: string): ToggleRecord {
  const toggle = captured.toggles.find((toggle) => toggle.label === label);
  if (!toggle) throw new Error(`missing toggle ${label}`);
  return toggle;
}

describe('LogbookChipRow.ios native actions', () => {
  it('starts with sort chips and has no duplicate full-filter opener', () => {
    renderRow();

    expect(captured.buttons.slice(0, 2).map((button) => button.label)).toEqual([
      'mobile.logbook.preset.latest',
      'mobile.logbook.preset.hardest',
    ]);
    expect(captured.buttons.some((button) => button.label === 'mobile.logbook.filter')).toBe(false);
    expect(captured.buttons.some((button) => button.systemImage === 'line.3.horizontal.decrease')).toBe(false);
  });

  it('routes sort and facet taps to their respective handlers', () => {
    renderRow();

    buttonByLabel('mobile.logbook.preset.latest').onPress?.();
    buttonByLabel('mobile.logbook.preset.hardest').onPress?.();
    expect(onSelectPreset.mock.calls).toEqual([['recent'], ['hardest']]);

    buttonByLabel('mobile.logbook.grade').onPress?.();
    buttonByLabel('mobile.logbook.angle').onPress?.();
    buttonByLabel('mobile.logbook.dateRange').onPress?.();
    expect(onToggleFacet.mock.calls).toEqual([['grade'], ['angle'], ['date']]);
  });

  it('keeps an active grade facet tinted after removing the sheet chip', () => {
    renderRow({ ...DEFAULT_LOGBOOK_FILTERS, minGrade: 10 });
    const gradeChip = buttonByLabel('≥6a');

    expect(gradeChip.modifiers).toContainEqual({ modifier: 'buttonStyle', arg: 'glassProminent' });
    expect(gradeChip.modifiers).toContainEqual({ modifier: 'tint', arg: '#6D28D9' });
    expect(buttonByLabel('mobile.logbook.angle').modifiers).toContainEqual({ modifier: 'buttonStyle', arg: 'glass' });
  });

  it('live-commits native Show selections and clears flash when sends are disabled', () => {
    renderRow({ ...DEFAULT_LOGBOOK_FILTERS, flashOnly: true });

    toggleByLabel('mobile.logbook.status.sends').onIsOnChange(false);
    expect(onUpdateFilters).toHaveBeenCalledWith({ includeSends: false, flashOnly: false });
    toggleByLabel('mobile.logbook.benchmarksOnly').onIsOnChange(true);
    expect(onUpdateFilters).toHaveBeenCalledWith({ benchmarkOnly: true });
  });

  it('keeps at least one status selected in the native Show menu', () => {
    renderRow({ ...DEFAULT_LOGBOOK_FILTERS, includeSends: false });
    toggleByLabel('mobile.logbook.status.attempts').onIsOnChange(false);
    expect(onUpdateFilters).not.toHaveBeenCalled();
  });
});
