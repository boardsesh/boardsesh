import { describe, expect, it } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import HoldIndicator from '../hold-indicator';

describe('HoldIndicator', () => {
  it('renders count without max', () => {
    render(<HoldIndicator count={3} color="#ff0000" label="Total" />);
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('renders count/max when max is provided', () => {
    render(<HoldIndicator count={1} max={2} color="#00ff00" label="Starting" />);
    expect(screen.getByText('1/2')).toBeTruthy();
  });

  it('renders 0/max when count is zero', () => {
    render(<HoldIndicator count={0} max={2} color="#00ff00" label="Starting" />);
    expect(screen.getByText('0/2')).toBeTruthy();
  });

  it('associates the label via aria-label for accessibility', () => {
    render(<HoldIndicator count={2} max={2} color="#ec4899" label="Finish" />);
    expect(screen.getByRole('generic', { name: 'Finish' })).toBeTruthy();
  });

  it('renders string count when max is undefined', () => {
    render(<HoldIndicator count={0} color="#6366f1" label="Total" />);
    expect(screen.getByText('0')).toBeTruthy();
  });
});
