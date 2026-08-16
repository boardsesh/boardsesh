import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import GymPosterPrintBar from '../gym-poster-print-bar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('GymPosterPrintBar', () => {
  it('opens the browser print dialog', () => {
    // jsdom has no print implementation, so it is stubbed rather than spied on.
    const print = vi.fn();
    vi.stubGlobal('print', print);

    render(<GymPosterPrintBar gymHref="/gym/test-gym" printLabel="Print this poster" backLabel="Back to the gym" />);
    fireEvent.click(screen.getByRole('button', { name: 'Print this poster' }));

    expect(print).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('links back to the gym page with the href it was handed', () => {
    render(<GymPosterPrintBar gymHref="/gym/test-gym" printLabel="Print this poster" backLabel="Back to the gym" />);
    // A real anchor, not a click handler: the way back has to survive a page
    // printed from a browser with JS blocked, and be middle-clickable.
    expect(screen.getByRole('link', { name: 'Back to the gym' }).getAttribute('href')).toBe('/gym/test-gym');
  });

  it('carries a percent-encoded slug through untouched', () => {
    render(<GymPosterPrintBar gymHref="/gym/boulder%231" printLabel="Print" backLabel="Back" />);
    expect(screen.getByRole('link', { name: 'Back' }).getAttribute('href')).toBe('/gym/boulder%231');
  });

  it('renders the labels the server passed rather than translating in the island', () => {
    // The i18n mock echoes keys, so a label rendered from a key would show the
    // key. Seeing the passed strings proves the island stays off client i18n.
    render(<GymPosterPrintBar gymHref="/gym/test-gym" printLabel="Imprimer" backLabel="Retour" />);
    expect(screen.getByRole('button', { name: 'Imprimer' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Retour' })).toBeTruthy();
  });
});
