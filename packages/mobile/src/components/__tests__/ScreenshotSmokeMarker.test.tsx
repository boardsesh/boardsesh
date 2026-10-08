// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScreenshotSmokeMarker } from '../ScreenshotSmokeMarker';
import { reportScreenshotSmokeContent } from '../../lib/screenshot-smoke';

vi.mock('../../lib/screenshot-smoke', () => ({ reportScreenshotSmokeContent: vi.fn() }));

beforeEach(() => vi.mocked(reportScreenshotSmokeContent).mockClear());

describe('ScreenshotSmokeMarker', () => {
  it('reports only while mounted and renders no UI', () => {
    const { container, rerender, unmount } = render(<ScreenshotSmokeMarker route="/profile" count={9} />);
    expect(container.childElementCount).toBe(0);
    expect(reportScreenshotSmokeContent).toHaveBeenCalledWith('/profile', 9);
    rerender(<ScreenshotSmokeMarker route="/profile" count={9} />);
    expect(reportScreenshotSmokeContent).toHaveBeenCalledTimes(1);
    rerender(<ScreenshotSmokeMarker route="/profile" count={10} />);
    expect(reportScreenshotSmokeContent).toHaveBeenCalledWith('/profile', 10);
    unmount();
    expect(reportScreenshotSmokeContent).toHaveBeenCalledTimes(2);
  });
});
