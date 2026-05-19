import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import ClimbViewActions from '../climb-view-actions';
import type { BoardDetails, Climb } from '@/app/lib/types';

let mockPathname = '/kilter/original/12x12-home/bolt-on/40/view/some-climb';

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

// Mock BackButton so we can inspect the fallbackUrl prop.
vi.mock('../../back-button', () => ({
  default: ({ fallbackUrl, className }: { fallbackUrl?: string; className?: string }) => (
    <button data-testid="back-button" data-fallback-url={fallbackUrl} className={className}>
      back
    </button>
  ),
}));

// ClimbActions has a deep tree we don't care about here.
vi.mock('../../climb-actions', () => ({
  ClimbActions: () => null,
}));

vi.mock('../climb-view-actions.module.css', () => ({
  default: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

const boardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 2],
  layout_name: 'Original',
  size_name: '12x12',
  size_description: 'Home',
  set_names: ['Bolt-On'],
} as unknown as BoardDetails;

const climb = {
  uuid: 'some-climb',
  name: 'Test Climb',
} as unknown as Climb;

describe('ClimbViewActions getBackToListUrl', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('preserves live URL query string in the BackButton fallback URL', () => {
    // QueueContext writes filter state to the URL via history.replaceState,
    // which Next.js's useSearchParams() does not observe. The view page's
    // back button fallback must read window.location.search so filters
    // aren't dropped when there's no in-app history to pop.
    window.history.replaceState(
      {},
      '',
      '/kilter/original/12x12-home/bolt-on/40/view/some-climb?minGrade=10&onlyClassics=true',
    );

    render(<ClimbViewActions climb={climb} boardDetails={boardDetails} angle={40} />);

    const buttons = screen.getAllByTestId('back-button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      const fallback = button.getAttribute('data-fallback-url') ?? '';
      expect(fallback).toContain('minGrade=10');
      expect(fallback).toContain('onlyClassics=true');
    }
  });

  it('does not append a trailing ? when no filters are set', () => {
    window.history.replaceState({}, '', '/kilter/original/12x12-home/bolt-on/40/view/some-climb');

    render(<ClimbViewActions climb={climb} boardDetails={boardDetails} angle={40} />);

    const buttons = screen.getAllByTestId('back-button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      const fallback = button.getAttribute('data-fallback-url') ?? '';
      expect(fallback).not.toContain('?');
    }
  });
});
