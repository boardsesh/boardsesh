import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { BoardDetails } from '@/app/lib/types';
import GeneratorOptionsForm, { getDefaultOptions } from '../generator-options-form';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const boardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 1,
  set_ids: [1],
  size_name: '10 x 10',
} as unknown as BoardDetails;

describe('GeneratorOptionsForm quality filters', () => {
  it('uses a whole-star default minimum rating', () => {
    expect(getDefaultOptions('volume', 18).minRating).toBe(2);
  });

  it('Min Ascents preset emits the selected threshold', () => {
    const onChange = vi.fn();
    render(
      <GeneratorOptionsForm
        workoutType="volume"
        options={getDefaultOptions('volume', 18)}
        onChange={onChange}
        onReset={vi.fn()}
        boardDetails={boardDetails}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '1k+' }));

    expect(onChange.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ minAscents: 1000 }));
  });

  it('Min Rating star picker emits whole-star thresholds', () => {
    const onChange = vi.fn();
    render(
      <GeneratorOptionsForm
        workoutType="volume"
        options={getDefaultOptions('volume', 18)}
        onChange={onChange}
        onReset={vi.fn()}
        boardDetails={boardDetails}
      />,
    );

    fireEvent.click(screen.getByRole('option', { name: '4 stars and up' }));

    expect(onChange.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ minRating: 4 }));
  });
});
