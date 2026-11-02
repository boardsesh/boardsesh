// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MoreFormModel } from '../MoreForm.types';

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
vi.mock('@expo/ui/jetpack-compose', () => {
  const Container = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const WithSlots = Object.assign(Container, {
    Trigger: Container,
    Items: Container,
    LeadingIcon: Container,
    Text: Container,
  });
  return {
    LazyColumn: Container,
    Card: Container,
    Column: Container,
    Row: Container,
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
    DropdownMenuItem: WithSlots,
    BasicTextField: Container,
    Slider: Container,
    CircularProgressIndicator: Container,
    useNativeState: (initial: unknown) => ({ value: initial }),
  };
});
vi.mock('@expo/ui/jetpack-compose/modifiers', () => {
  const modifier = () => ({});
  return {
    fillMaxWidth: modifier,
    padding: modifier,
    alpha: modifier,
    weight: modifier,
    clickable: modifier,
    size: modifier,
    semantics: modifier,
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

afterEach(cleanup);

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
