// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import enUSCatalog from '../../../../../shared/i18n/locales/en-US/boards.json';
import esCatalog from '../../../../../shared/i18n/locales/es/boards.json';
import frCatalog from '../../../../../shared/i18n/locales/fr/boards.json';
import deCatalog from '../../../../../shared/i18n/locales/de/boards.json';

const labels = vi.hoisted(() => ({ holds: '', maybes: '' }));
vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  StyleSheet: { absoluteFill: {}, create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
}));
vi.mock('react-native-reanimated', () => {
  const animation = {
    springify: () => animation,
    damping: () => animation,
    stiffness: () => animation,
    mass: () => animation,
  };
  return {
    default: { View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children) },
    ZoomIn: animation,
  };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === 'sprayEditor.bar.holds' ? labels.holds : key === 'sprayEditor.bar.maybes' ? labels.maybes : key,
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#eee', label: '#000', secondaryLabel: '#555' },
    brandColors: { primary: '#111', accent: '#222' },
  }),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../GlassIconButton', () => ({
  GlassIconButton: ({ accessibilityLabel }: { accessibilityLabel: string }) =>
    createElement('button', {}, accessibilityLabel),
}));
vi.mock('../../GlassSurface', () => ({ GlassSurface: () => null }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'capsule' }, children),
}));
vi.mock('../SprayCountCrossfade', () => ({
  SprayCountCrossfade: ({ text }: { text: string }) => createElement('span', {}, text),
}));
vi.mock('../../../theme/animations', () => ({ springs: { bouncy: { damping: 1, stiffness: 1, mass: 1 } } }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 }, borderRadius: { xl: 24 } }));
vi.mock('../../../theme/layout', () => ({ glassSize: { standard: 48, capsule: 44 } }));
import { SprayEditorBottomBar } from '../SprayEditorBottomBar';

describe('translated spray count capsule', () => {
  it.each([
    ['en-US', enUSCatalog],
    ['es', esCatalog],
    ['fr', frCatalog],
    ['de', deCatalog],
  ] as const)('gives %s counts the space between Undo and Add, apart from Publish', (_locale, catalog) => {
    const holds = catalog.sprayEditor.bar.holds_other.replace('{{count}}', '1500');
    const maybes = catalog.sprayEditor.bar.maybes_other.replace('{{count}}', '91');
    labels.holds = holds;
    labels.maybes = maybes;
    const { getByText, getByTestId } = render(
      createElement(SprayEditorBottomBar, {
        counts: { on: 1500, maybes: 91, off: 0, unsavedWrites: 0, unsavedFinds: 0, unsavedRemovals: 0 },
        showMaybes: true,
        canReviewMaybes: true,
        canUndo: true,
        adding: false,
        locked: false,
        primaryLabel: 'Publish holds',
        primaryLoading: false,
        primaryBlocked: false,
        celebrating: false,
        bottomInset: 0,
        onUndo: vi.fn(),
        onAdd: vi.fn(),
        onKeepMaybes: vi.fn(),
        onToggleMaybes: vi.fn(),
        onStartOver: vi.fn(),
        onPrimary: vi.fn(),
      }),
    );
    const countRow = getByTestId('capsule').parentElement;
    expect(getByText(holds)).toBeTruthy();
    expect(getByText(maybes)).toBeTruthy();
    expect(countRow?.contains(getByText('Publish holds'))).toBe(false);
    expect(countRow?.querySelectorAll('button')).toHaveLength(2);
  });
});
