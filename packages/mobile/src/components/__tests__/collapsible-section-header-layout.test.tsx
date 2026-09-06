// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Yoga doesn't run under the test renderer, so these assert the header's flex
// CONTRACT rather than measured pixels — the title's `flex: 1` (basis 0) let a
// long summary take all the shrink and wrap "Logbook" one letter per line.

type StyleProp = Record<string, unknown> | Array<Record<string, unknown> | undefined | false> | undefined;

function flattenStyle(style: StyleProp): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map((entry) => (entry ? flattenStyle(entry) : {})));
  return style;
}

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: () => onPress?.() }, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: (factory: () => Record<string, unknown>) => factory(),
  withTiming: (value: number) => value,
}));
// Forwards the resolved style so the assertions can read the flex contract off
// the rendered title/summary instead of reaching into module-private styles.
vi.mock('../Text', () => ({
  Text: ({ children, style }: { children?: ReactNode; style?: StyleProp }) =>
    createElement('span', { 'data-style': JSON.stringify(flattenStyle(style)) }, children),
}));
vi.mock('../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('../../lib/haptics', () => ({ hapticSelection: vi.fn() }));

const TITLE = 'Logbook';
const LONG_SUMMARY = '40° · not tried yet · sent at 3 angles · tried at 45°';

async function renderHeader() {
  const { CollapsibleSection } = await import('../CollapsibleSection');
  const { container } = render(
    <CollapsibleSection title={TITLE} summary={LONG_SUMMARY}>
      <div>SECTION_BODY</div>
    </CollapsibleSection>,
  );
  const spans = Array.from(container.querySelectorAll('span'));
  const styleOf = (text: string) => {
    const node = spans.find((span) => span.textContent === text);
    if (!node) throw new Error(`No <span> rendered for ${JSON.stringify(text)}`);
    return JSON.parse(node.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
  };
  return { title: styleOf(TITLE), summary: styleOf(LONG_SUMMARY) };
}

describe('CollapsibleSection collapsed header layout', () => {
  it('sizes the title by its own text so a long summary cannot shrink it to zero', async () => {
    const { title } = await renderHeader();

    // `flex` (any value) and an explicit `flexBasis` both take the base size
    // away from the text, which is what let the summary starve the title.
    // `flexGrow` unset keeps the spare width with the summary.
    expect(title.flex).toBeUndefined();
    expect(title.flexBasis).toBeUndefined();
    expect(title.flexGrow).toBeUndefined();
    expect(title.flexShrink).toBe(1);
  });

  it('gives the summary the spare width instead of its own text width', async () => {
    const { summary } = await renderHeader();

    // Base size 0 means the summary never contributes to the row's overflow —
    // it grows into what's left and ellipsizes there (numberOfLines={1}).
    expect(summary.flexBasis).toBe(0);
    expect(summary.flexGrow).toBe(1);
    expect(summary.flexShrink).toBe(1);
  });
});
