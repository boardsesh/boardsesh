// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ platform: 'ios', announce: vi.fn() }));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return native.platform;
    },
  },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: { error: 'systemRed' } }) }));
vi.mock('../../lib/announce-queued', () => ({ announceQueued: native.announce }));
vi.mock('../Text', () => ({
  Text: (props: {
    children?: ReactNode;
    maxFontSizeMultiplier?: number;
    numberOfLines?: number;
    accessibilityLiveRegion?: string;
  }) =>
    createElement(
      'span',
      {
        'data-max-font': props.maxFontSizeMultiplier,
        'data-lines': props.numberOfLines,
        'data-live': props.accessibilityLiveRegion,
      },
      props.children,
    ),
}));
import { InlineSheetError } from '../InlineSheetError';
beforeEach(() => {
  native.platform = 'ios';
  native.announce.mockReset();
});
describe('visible inline sheet errors', () => {
  it('wraps the complete error at unrestricted Dynamic Type and announces once', () => {
    const message = 'A long actionable failure explaining that your report and attachments remain ready to retry.';
    const screen = render(<InlineSheetError message={message} visible scope="report" />);
    const error = screen.getByText(message);
    expect(error.getAttribute('data-max-font')).toBe('0');
    expect(error.getAttribute('data-lines')).toBeNull();
    expect(native.announce).toHaveBeenCalledExactlyOnceWith(message);
    screen.rerender(<InlineSheetError message={message} visible scope="report" />);
    expect(native.announce).toHaveBeenCalledTimes(1);
    screen.rerender(<InlineSheetError message={null} visible scope="report" />);
    screen.rerender(<InlineSheetError message={message} visible scope="report" />);
    expect(native.announce).toHaveBeenCalledTimes(2);
  });
  it('does not announce hidden errors or double-announce Android live regions', () => {
    const screen = render(<InlineSheetError message="Retry" visible={false} scope="report" />);
    expect(screen.queryByText('Retry')).toBeNull();
    expect(native.announce).not.toHaveBeenCalled();
    native.platform = 'android';
    screen.rerender(<InlineSheetError message="Retry" visible scope="report" />);
    expect(screen.getByText('Retry').getAttribute('data-live')).toBe('polite');
    expect(native.announce).not.toHaveBeenCalled();
  });
});
