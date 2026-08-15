import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { Gym } from '@boardsesh/shared-schema';
import GymCard from '../gym-card';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

function makeGym(overrides: Partial<Gym> = {}): Gym {
  return {
    uuid: 'gym-uuid-1',
    slug: 'garage-gym',
    name: 'Garage Gym',
    address: '123 Boulder St',
    boardCount: 3,
    memberCount: 12,
    followerCount: 5,
    ...overrides,
  } as unknown as Gym;
}

describe('GymCard', () => {
  it('renders the gym name as a crawlable link to the public gym page', () => {
    render(<GymCard gym={makeGym()} onClick={vi.fn()} />);
    const link = screen.getByRole('link', { name: 'Garage Gym' });
    expect(link.getAttribute('href')).toBe('/gym/garage-gym');
  });

  it('does not open the preview sheet when the name link is tapped, but does for the rest of the card', () => {
    const onClick = vi.fn();
    render(<GymCard gym={makeGym()} onClick={onClick} />);

    // The name link goes to the full page; stopPropagation keeps the sheet closed.
    fireEvent.click(screen.getByRole('link', { name: 'Garage Gym' }));
    expect(onClick).not.toHaveBeenCalled();

    // Tapping elsewhere on the card keeps the open-the-sheet behaviour.
    fireEvent.click(screen.getByText('123 Boulder St'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('falls back to plain text when the gym has no slug (no public page to link to)', () => {
    render(<GymCard gym={makeGym({ slug: null })} onClick={vi.fn()} />);
    expect(screen.queryByRole('link', { name: 'Garage Gym' })).toBeNull();
    expect(screen.getByText('Garage Gym')).toBeTruthy();
  });

  // The card is rendered as a div so the gym-name <a> can nest inside it, which
  // costs it the native button's keyboard handling. ButtonBase puts that back —
  // these lock it in, since losing it strands keyboard users on the card.
  describe('keyboard activation', () => {
    it('exposes the card as a button to assistive tech', () => {
      render(<GymCard gym={makeGym()} onClick={vi.fn()} />);
      const card = screen.getByRole('button');
      expect(card.tagName).toBe('DIV');
      expect(card.getAttribute('tabindex')).toBe('0');
    });

    it('opens the preview sheet on Enter', () => {
      const onClick = vi.fn();
      render(<GymCard gym={makeGym()} onClick={onClick} />);

      fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });

      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('opens the preview sheet on Space, which activates on key up', () => {
      const onClick = vi.fn();
      render(<GymCard gym={makeGym()} onClick={onClick} />);
      const card = screen.getByRole('button');

      fireEvent.keyDown(card, { key: ' ' });
      expect(onClick).not.toHaveBeenCalled();

      fireEvent.keyUp(card, { key: ' ' });
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('is not keyboard-reachable when there is no sheet to open', () => {
      render(<GymCard gym={makeGym()} />);
      const card = screen.getByRole('button');

      expect(card.getAttribute('tabindex')).toBe('-1');
      fireEvent.keyDown(card, { key: 'Enter' });
      // Nothing to assert a call against — the point is that it doesn't throw
      // and the card never advertises an action it can't perform.
      expect(card.className).toContain('Mui-disabled');
    });
  });
});
