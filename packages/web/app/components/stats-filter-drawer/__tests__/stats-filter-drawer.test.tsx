import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen } from '@testing-library/react';
import StatsFilterDrawer from '../stats-filter-drawer';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/app/components/swipeable-drawer/swipeable-drawer', () => ({
  default: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

function renderDrawer() {
  const onFromDateChange = vi.fn();
  const onToDateChange = vi.fn();
  const result = render(
    <StatsFilterDrawer
      open
      onClose={vi.fn()}
      selectedBoard="all"
      onBoardChange={vi.fn()}
      timeframe="custom"
      onTimeframeChange={vi.fn()}
      fromDate="2026-07-16"
      onFromDateChange={onFromDateChange}
      toDate="2026-07-20"
      onToDateChange={onToDateChange}
    />,
  );
  return { ...result, onFromDateChange, onToDateChange };
}

describe('StatsFilterDrawer date controls', () => {
  it('renders custom dates with its own adapter outside the root theme provider', () => {
    const { container } = renderDrawer();
    const dates = Array.from(container.querySelectorAll('input')).map((input) => input.value);
    expect(dates).toContain('07/16/2026');
    expect(dates).toContain('07/20/2026');
  });

  it('passes a selected calendar day back as an ISO date', async () => {
    const { onFromDateChange } = renderDrawer();
    fireEvent.click(screen.getAllByRole('button', { name: /Choose date/ })[0]);
    fireEvent.click(await screen.findByRole('gridcell', { name: '17' }));
    expect(onFromDateChange).toHaveBeenCalledWith('2026-07-17');
  });
});
