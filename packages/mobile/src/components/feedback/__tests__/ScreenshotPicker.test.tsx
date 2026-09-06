// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { FEEDBACK_SCREENSHOT_MAX_COUNT } from '@boardsesh/shared-schema';

type ViewMockProps = { children?: ReactNode; accessibilityLabel?: string };
type ImageMockProps = { source?: { uri?: string } };
vi.mock('react-native', () => ({
  View: ({ children, accessibilityLabel }: ViewMockProps) =>
    createElement('div', { 'aria-label': accessibilityLabel }, children),
  Image: ({ source }: ImageMockProps) => createElement('img', { 'data-uri': source?.uri }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

type TextMockProps = { children?: ReactNode };
vi.mock('../../Text', () => ({
  Text: ({ children }: TextMockProps) => createElement('span', {}, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span', { 'data-icon': 'true' }) }));

type PressableMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
};
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, accessibilityLabel, disabled }: PressableMockProps) =>
    createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8 },
  borderRadius: { md: 8, full: 9999 },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      label: '#000',
      secondaryLabel: '#888',
      fill: '#eee',
      separator: '#ccc',
      secondaryBackground: '#f5f5f5',
    },
  }),
}));

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));

const reportError = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/error-reporting', () => ({ reportError }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const picker = vi.hoisted(() => ({
  requestMediaLibraryPermissionsAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
}));
vi.mock('expo-image-picker', () => picker);

const compressPickedImage = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/image-compression', () => ({ compressPickedImage }));

import { ScreenshotPicker } from '../ScreenshotPicker';

const addTile = (root: HTMLElement) => root.querySelector('[aria-label="screenshots.addAria"]') as HTMLButtonElement;
const removeButtons = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('[aria-label="screenshots.removeAria"]')) as HTMLButtonElement[];
const thumbnails = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('img')).map((image) => image.getAttribute('data-uri'));

beforeEach(() => {
  showToast.mockClear();
  reportError.mockClear();
  picker.requestMediaLibraryPermissionsAsync.mockReset().mockResolvedValue({ granted: true });
  picker.launchImageLibraryAsync.mockReset();
  compressPickedImage.mockReset().mockImplementation((uri: string) => Promise.resolve(`${uri}.compressed`));
});

describe('ScreenshotPicker picking', () => {
  it('adds every picked shot, compressed, on top of what is already staged', async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: 'file:///b.png', width: 1179, height: 2556 },
        { uri: 'file:///c.png', width: 1179, height: 2556 },
      ],
    });
    const onChange = vi.fn();
    const { container } = render(<ScreenshotPicker uris={['file:///a.jpg']} onChange={onChange} />);

    fireEvent.click(addTile(container));

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith(['file:///a.jpg', 'file:///b.png.compressed', 'file:///c.png.compressed']);
    // Screenshots carry small UI text; 1600px keeps it readable in the issue.
    expect(compressPickedImage).toHaveBeenCalledWith('file:///b.png', 1179, 2556, {
      maxDimension: 1600,
      quality: 0.8,
    });
  });

  it('asks the picker for only the slots that are left', async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });
    const { container } = render(<ScreenshotPicker uris={['file:///a.jpg']} onChange={vi.fn()} />);

    fireEvent.click(addTile(container));

    await vi.waitFor(() => expect(picker.launchImageLibraryAsync).toHaveBeenCalledTimes(1));
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({ allowsMultipleSelection: true, selectionLimit: FEEDBACK_SCREENSHOT_MAX_COUNT - 1 }),
    );
  });

  it('changes nothing when the picker is cancelled', async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });
    const onChange = vi.fn();
    const { container } = render(<ScreenshotPicker uris={[]} onChange={onChange} />);

    fireEvent.click(addTile(container));

    await vi.waitFor(() => expect(picker.launchImageLibraryAsync).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('ScreenshotPicker removing', () => {
  it('drops just the shot whose ✕ was tapped', () => {
    const onChange = vi.fn();
    const { container } = render(<ScreenshotPicker uris={['file:///a.jpg', 'file:///b.jpg']} onChange={onChange} />);
    expect(thumbnails(container)).toEqual(['file:///a.jpg', 'file:///b.jpg']);

    fireEvent.click(removeButtons(container)[0]);

    expect(onChange).toHaveBeenCalledWith(['file:///b.jpg']);
  });
});

describe('ScreenshotPicker at the cap', () => {
  it('hides the add tile once the backend limit is staged', () => {
    const uris = Array.from({ length: FEEDBACK_SCREENSHOT_MAX_COUNT }, (_, index) => `file:///${index}.jpg`);
    const { container } = render(<ScreenshotPicker uris={uris} onChange={vi.fn()} />);

    expect(addTile(container)).toBeNull();
    expect(removeButtons(container)).toHaveLength(FEEDBACK_SCREENSHOT_MAX_COUNT);
  });

  it('still shows the tile one slot below the limit', () => {
    const uris = Array.from({ length: FEEDBACK_SCREENSHOT_MAX_COUNT - 1 }, (_, index) => `file:///${index}.jpg`);
    const { container } = render(<ScreenshotPicker uris={uris} onChange={vi.fn()} />);

    expect(addTile(container)).not.toBeNull();
  });
});

describe('ScreenshotPicker without photo permission', () => {
  it('says so and never opens the library', async () => {
    picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: false });
    const onChange = vi.fn();
    const { container } = render(<ScreenshotPicker uris={[]} onChange={onChange} />);

    fireEvent.click(addTile(container));

    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('screenshots.permissionDenied', 'warning'));
    expect(picker.launchImageLibraryAsync).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('ScreenshotPicker when compression fails', () => {
  it('reports it and keeps the staged shots untouched', async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///broken.heic', width: 100, height: 100 }],
    });
    compressPickedImage.mockRejectedValue(new Error('unsupported'));
    const onChange = vi.fn();
    const { container } = render(<ScreenshotPicker uris={[]} onChange={onChange} />);

    fireEvent.click(addTile(container));

    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('screenshots.pickFailed', 'error'));
    expect(reportError).toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('ScreenshotPicker warnings', () => {
  it('warns that attached shots go public on GitHub', () => {
    const { container } = render(<ScreenshotPicker uris={['file:///a.jpg']} onChange={vi.fn()} />);
    expect(container.textContent).toContain('screenshots.publicWarning');
  });

  it('disables both affordances while a submit is in flight', () => {
    const { container } = render(<ScreenshotPicker uris={['file:///a.jpg']} onChange={vi.fn()} disabled />);
    expect(addTile(container).disabled).toBe(true);
    expect(removeButtons(container)[0].disabled).toBe(true);
  });
});
