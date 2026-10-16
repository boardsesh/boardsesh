// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

function serializeStyle(style: unknown): string {
  return JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean)));
}

type ContainerProps = { children?: ReactNode; style?: unknown };
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: ({ light }: { light: string }) => light,
  View: ({ children, style }: ContainerProps) =>
    createElement('div', { 'data-style': serializeStyle(style) }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {} }),
}));
vi.mock('../../../hooks/use-unsaved-sheet-guard', () => ({
  useUnsavedSheetGuard: () => ({ requestClose: vi.fn(), enablePanDownToClose: true }),
}));
vi.mock('../../privacy/use-publication-audience', () => ({
  usePublicationAudience: () => ({ enabled: false }),
}));
vi.mock('../../privacy/PublicationAudiencePicker', () => ({ PublicationAudiencePicker: () => null }));
vi.mock('../../privacy/ContentAudienceControl', () => ({ ContentAudienceControl: () => null }));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ children }: ContainerProps) => createElement('div', null, children),
}));
vi.mock('../../SheetTopBar', () => ({ SheetTopBar: () => null }));
vi.mock('../../SwitchRow', () => ({ SwitchRow: () => null }));
vi.mock('../PlaylistPreviewSquare', () => ({ PlaylistPreviewSquare: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Text', () => ({
  Text: ({ children, style }: ContainerProps) =>
    createElement('span', { 'data-style': serializeStyle(style) }, children),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, style, onPress }: ContainerProps & { onPress?: () => void }) =>
    createElement('button', { onClick: onPress, 'data-style': serializeStyle(style) }, children),
}));
vi.mock('../../AccessibleBottomSheetTextInput', () => ({
  AccessibleBottomSheetTextInput: ({
    value,
    style,
    accessibilityLabel,
    onChangeText,
  }: {
    value?: string;
    style?: unknown;
    accessibilityLabel?: string;
    onChangeText?: (text: string) => void;
  }) =>
    createElement('input', {
      value,
      'aria-label': accessibilityLabel,
      'data-style': serializeStyle(style),
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
    }),
}));

import { PlaylistFormSheet } from '../PlaylistFormSheet';

describe('PlaylistFormSheet enlarged text', () => {
  it('lets the emoji field and translated remove action grow and wrap', () => {
    const { getByLabelText, getByText } = render(
      <PlaylistFormSheet mode="create" visible onClose={vi.fn()} onSubmit={vi.fn()} />,
    );
    const emojiField = getByLabelText('edit.fields.icon');
    const emojiStyle = JSON.parse(emojiField.getAttribute('data-style') ?? '{}');
    expect(emojiStyle).toMatchObject({ minWidth: 56, minHeight: 56, maxWidth: '100%' });
    expect(emojiStyle).not.toHaveProperty('width');
    expect(emojiStyle).not.toHaveProperty('height');
    expect(JSON.parse(emojiField.parentElement?.getAttribute('data-style') ?? '{}')).toMatchObject({
      flexWrap: 'wrap',
    });

    fireEvent.change(emojiField, { target: { value: '🔥' } });
    const removeLabel = getByText('edit.fields.removeIcon');
    expect(JSON.parse(removeLabel.getAttribute('data-style') ?? '{}')).toMatchObject({ flexShrink: 1 });
    const removeStyle = JSON.parse(removeLabel.parentElement?.getAttribute('data-style') ?? '{}');
    expect(removeStyle).toMatchObject({ minHeight: 40, maxWidth: '100%' });
    expect(removeStyle.paddingVertical).toBeGreaterThan(0);
    expect(removeStyle).not.toHaveProperty('height');
    fireEvent.click(removeLabel);
    expect((emojiField as HTMLInputElement).value).toBe('');
  });
});
