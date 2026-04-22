import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import { useZoomPan } from '../use-zoom-pan';

// Mock @use-gesture/react since jsdom doesn't support pointer/touch events well
const mockBind = vi.fn();
vi.mock('@use-gesture/react', () => ({
  useGesture: (handlers: Record<string, Function>) => {
    // Store handlers so tests can invoke them
    mockBind.mockImplementation(() => handlers);
    return mockBind;
  },
}));

function createMockElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = vi.fn(() => ({
    width: 400,
    height: 600,
    top: 0,
    left: 0,
    right: 400,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: vi.fn(),
  }));
  return el;
}

describe('useZoomPan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns expected interface', () => {
    const { result } = renderHook(() => useZoomPan());

    expect(typeof result.current.containerRef).toBe('function');
    expect(result.current.contentRef).toBeDefined();
    expect(result.current.isZoomed).toBe(false);
    expect(typeof result.current.resetZoom).toBe('function');
  });

  it('starts with isZoomed = false', () => {
    const { result } = renderHook(() => useZoomPan());
    expect(result.current.isZoomed).toBe(false);
  });

  it('containerRef sets up the container element', () => {
    const { result } = renderHook(() => useZoomPan());
    const el = createMockElement();

    act(() => {
      result.current.containerRef(el);
    });

    // Should not throw - container is set up
    expect(result.current.isZoomed).toBe(false);
  });

  it('containerRef handles null (cleanup)', () => {
    const { result } = renderHook(() => useZoomPan());
    const el = createMockElement();

    act(() => {
      result.current.containerRef(el);
    });

    // Should not throw when passing null
    expect(() => {
      act(() => {
        result.current.containerRef(null);
      });
    }).not.toThrow();
  });

  it('resetZoom sets isZoomed to false', () => {
    const { result } = renderHook(() => useZoomPan());

    // Set up content ref with a real element so applyTransform works
    const contentEl = document.createElement('div');
    Object.defineProperty(result.current.contentRef, 'current', {
      writable: true,
      value: contentEl,
    });

    act(() => {
      result.current.resetZoom();
    });

    expect(result.current.isZoomed).toBe(false);
  });

  it('resetZoom applies animated transform to content element', () => {
    const { result } = renderHook(() => useZoomPan());

    const contentEl = document.createElement('div');
    // Simulate a zoomed state so the transform actually changes on reset
    contentEl.style.transform = 'scale(2) translate(10px, 10px)';
    const addEventSpy = vi.spyOn(contentEl, 'addEventListener');
    Object.defineProperty(result.current.contentRef, 'current', {
      writable: true,
      value: contentEl,
    });

    act(() => {
      result.current.resetZoom();
    });

    // Should apply transition for animation
    expect(contentEl.style.transition).toBe('transform 0.25s ease-out');
    // Should clear transform (scale=1 means empty string)
    expect(contentEl.style.transform).toBe('');
    // Should register transitionend listener for cleanup
    expect(addEventSpy).toHaveBeenCalledWith('transitionend', expect.any(Function), { once: true });
  });

  it('resetZoom transition cleanup removes transition style', () => {
    const { result } = renderHook(() => useZoomPan());

    const contentEl = document.createElement('div');
    // Simulate a zoomed state so the animated reset path executes
    contentEl.style.transform = 'scale(2) translate(10px, 10px)';
    Object.defineProperty(result.current.contentRef, 'current', {
      writable: true,
      value: contentEl,
    });

    act(() => {
      result.current.resetZoom();
    });

    // Simulate transitionend
    const transitionEndEvent = new Event('transitionend');
    act(() => {
      contentEl.dispatchEvent(transitionEndEvent);
    });

    expect(contentEl.style.transition).toBe('');
  });

  it('enabled=false resets zoom state', () => {
    const { result, rerender } = renderHook(({ enabled }) => useZoomPan({ enabled }), {
      initialProps: { enabled: true },
    });

    const contentEl = document.createElement('div');
    Object.defineProperty(result.current.contentRef, 'current', {
      writable: true,
      value: contentEl,
    });

    // Disable the hook
    rerender({ enabled: false });

    expect(result.current.isZoomed).toBe(false);
  });

  it('defaults enabled to true', () => {
    const { result } = renderHook(() => useZoomPan());

    // Should work without any options
    expect(result.current.isZoomed).toBe(false);
    expect(typeof result.current.resetZoom).toBe('function');
  });

  it('contentRef starts as null', () => {
    const { result } = renderHook(() => useZoomPan());
    expect(result.current.contentRef.current).toBeNull();
  });

  it('resetZoom is stable across re-renders', () => {
    const { result, rerender } = renderHook(() => useZoomPan());

    const firstResetZoom = result.current.resetZoom;
    rerender();
    const secondResetZoom = result.current.resetZoom;

    expect(firstResetZoom).toBe(secondResetZoom);
  });

  it('containerRef is stable across re-renders', () => {
    const { result, rerender } = renderHook(() => useZoomPan());

    const firstRef = result.current.containerRef;
    rerender();
    const secondRef = result.current.containerRef;

    expect(firstRef).toBe(secondRef);
  });

  it('resetZoom is safe to call without content element', () => {
    const { result } = renderHook(() => useZoomPan());

    // contentRef.current is null, resetZoom should not throw
    expect(() => {
      act(() => {
        result.current.resetZoom();
      });
    }).not.toThrow();

    expect(result.current.isZoomed).toBe(false);
  });
});
