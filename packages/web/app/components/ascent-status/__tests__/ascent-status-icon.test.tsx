// @vitest-environment jsdom
import { describe, expect, it } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { AscentStatusIcon } from '../ascent-status-icon';

describe('AscentStatusIcon', () => {
  it('renders the flash icon variant with explicit status metadata', () => {
    render(<AscentStatusIcon status="flash" variant="icon" fontSize={18} testId="flash-status-icon" />);

    const icon = screen.getByTestId('flash-status-icon');
    expect(icon.getAttribute('data-status')).toBe('flash');
    expect(icon.style.color).toBe('rgb(251, 191, 36)');
    expect(icon.getAttribute('style')).toContain('font-size: 18px');
  });

  it('normalizes legacy successful ascents to send when tries are greater than 1', () => {
    render(<AscentStatusIcon isAscent tries={3} variant="icon" testId="legacy-send-status" />);

    expect(screen.getByTestId('legacy-send-status').getAttribute('data-status')).toBe('send');
  });

  it('renders badge styling and mirrored transform for attempt badges', () => {
    render(
      <AscentStatusIcon
        status="attempt"
        variant="badge"
        fontSize={12}
        badgeSize={20}
        mirrored
        testId="attempt-badge"
      />,
    );

    const badge = screen.getByTestId('attempt-badge');
    expect(badge.getAttribute('data-status')).toBe('attempt');
    // Velvet: the attempt badge fill is now the scheme-aware error token.
    expect(badge.style.backgroundColor).toBe('var(--color-error)');
    expect(badge.getAttribute('style')).toContain('width: 20px');
    expect(badge.firstElementChild?.getAttribute('style')).toContain('transform: scaleX(-1)');
  });
});
