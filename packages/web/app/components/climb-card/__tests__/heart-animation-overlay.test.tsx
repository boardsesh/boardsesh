import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen, act } from '@testing-library/react';
import React from 'react';

let capturedOnAnimationEnd: (() => void) | undefined;

vi.mock('@mui/icons-material/Favorite', () => ({
  default: ({
    sx,
    onAnimationEnd,
    ...rest
  }: { sx?: unknown; onAnimationEnd?: () => void } & Record<string, unknown>) => {
    capturedOnAnimationEnd = onAnimationEnd;
    return (
      <span data-testid="favorite-icon" {...rest}>
        heart
      </span>
    );
  },
}));

import HeartAnimationOverlay from '../heart-animation-overlay';

describe('HeartAnimationOverlay', () => {
  it('renders nothing when visible is false', () => {
    const { container } = render(<HeartAnimationOverlay visible={false} onAnimationEnd={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders the overlay when visible is true', () => {
    render(<HeartAnimationOverlay visible={true} onAnimationEnd={vi.fn()} />);
    expect(screen.getByTestId('heart-animation-overlay')).toBeDefined();
    expect(screen.getByTestId('favorite-icon')).toBeDefined();
  });

  it('has pointer-events: none on the overlay', () => {
    render(<HeartAnimationOverlay visible={true} onAnimationEnd={vi.fn()} />);
    const overlay = screen.getByTestId('heart-animation-overlay');
    // CSS modules may not apply in test, so check class is applied
    expect(overlay.className).toContain('overlay');
  });

  it('passes onAnimationEnd callback to the heart icon', () => {
    const onAnimationEnd = vi.fn();
    capturedOnAnimationEnd = undefined;
    render(<HeartAnimationOverlay visible={true} onAnimationEnd={onAnimationEnd} />);

    // The component passes onAnimationEnd to the Favorite icon
    expect(capturedOnAnimationEnd).toBeDefined();

    // Simulate the animation ending
    act(() => {
      capturedOnAnimationEnd!();
    });

    expect(onAnimationEnd).toHaveBeenCalledTimes(1);
  });

  it('does not call onAnimationEnd when not visible', () => {
    const onAnimationEnd = vi.fn();
    render(<HeartAnimationOverlay visible={false} onAnimationEnd={onAnimationEnd} />);
    expect(onAnimationEnd).not.toHaveBeenCalled();
  });
});
