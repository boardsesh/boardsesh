// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { DuplicateBoardError } from '../../../lib/graphql/extract-error-message';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
type SheetMockProps = { children?: ReactNode; header?: ReactNode; enablePanDownToClose?: boolean };
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ children, header, enablePanDownToClose }: SheetMockProps) =>
    createElement('div', { 'data-pan-close': String(enablePanDownToClose) }, header, children),
}));
type TopBarMockProps = { title: string; leading?: { kind: string; onPress: () => void; accessibilityLabel?: string } };
vi.mock('../../SheetTopBar', () => ({
  SheetTopBar: ({ title, leading }: TopBarMockProps) =>
    createElement(
      'div',
      { 'data-top-bar': title },
      leading
        ? createElement('button', {
            'data-leading': leading.kind,
            'aria-label': leading.accessibilityLabel,
            onClick: leading.onPress,
          })
        : null,
    ),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { 'data-button': title, onClick: onPress }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 3: 12, 4: 16 } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#888' } }),
}));

import { BoardDuplicatePromptSheet } from '../BoardDuplicatePromptSheet';

const duplicate = { boardName: 'Garage', locationName: null } as unknown as DuplicateBoardError;

function renderPrompt(busy: boolean) {
  const handlers = { onUseExisting: vi.fn(), onAddAnother: vi.fn(), onDismiss: vi.fn() };
  const rendered = render(<BoardDuplicatePromptSheet duplicate={duplicate} busy={busy} {...handlers} />);
  return { ...rendered, ...handlers };
}

describe('BoardDuplicatePromptSheet', () => {
  it('closes from the top bar, spoken as "keep editing"', () => {
    const { container, onDismiss } = renderPrompt(false);
    expect(container.querySelector('[data-top-bar="mobile.create.duplicate.title"]')).not.toBeNull();
    const close = container.querySelector('[data-leading="close"]') as HTMLButtonElement;
    expect(close.getAttribute('aria-label')).toBe('mobile.create.duplicate.cancel');
    act(() => close.click());
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('keeps both choices in the body', () => {
    const { container, onUseExisting, onAddAnother } = renderPrompt(false);
    act(() => (container.querySelector('[data-button="mobile.create.duplicate.useExisting"]') as HTMLElement).click());
    act(() => (container.querySelector('[data-button="mobile.create.duplicate.addAnother"]') as HTMLElement).click());
    expect(onUseExisting).toHaveBeenCalledOnce();
    expect(onAddAnother).toHaveBeenCalledOnce();
  });

  // #4166: closing mid-switch released the lock while the board fetch ran on.
  it('cannot be closed while "use that board" is resolving', () => {
    const { container, onDismiss } = renderPrompt(true);
    act(() => (container.querySelector('[data-leading="close"]') as HTMLButtonElement).click());
    expect(onDismiss).not.toHaveBeenCalled();
    expect(container.querySelector('[data-pan-close="false"]')).not.toBeNull();
  });
});
