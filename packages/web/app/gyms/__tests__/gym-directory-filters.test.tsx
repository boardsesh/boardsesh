import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen, within } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('server-only', () => ({}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import type { DirectoryFacet, DirectorySearchParams } from '../directory-facets';

const { default: GymDirectoryFilters } = await import('../gym-directory-filters');
const { parseDirectoryQuery } = await import('../directory-facets');

const t = ((key: string, options?: Record<string, unknown>) =>
  tFromCatalog('gyms', key, options)) as unknown as Parameters<typeof GymDirectoryFilters>[0]['t'];

function renderFilters(facet: DirectoryFacet, searchParams: DirectorySearchParams) {
  const query = parseDirectoryQuery(facet, searchParams);
  render(<GymDirectoryFilters facet={facet} query={query} t={t} />);
  return query;
}

/** Every checkbox the panel would submit, as `name=value` pairs. */
function submittedPairs(): string[] {
  return [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .filter((input) => input.defaultChecked)
    .map((input) => `${input.name}=${input.value}`);
}

describe('the board-type row', () => {
  it('offers every catalogue board, and never a spray wall', () => {
    renderFilters('all', {});
    for (const label of ['Kilter', 'Tension', 'MoonBoard', 'Decoy', 'Touchstone', 'Grasshopper', 'So iLL', 'Woods']) {
      expect(screen.getByRole('link', { name: label })).toBeTruthy();
    }
    expect(screen.queryByRole('link', { name: 'Spray wall' })).toBeNull();
  });

  it('marks the selected board as pressed and links it back off', () => {
    renderFilters('all', { boardType: 'kilter' });
    const kilter = screen.getByRole('link', { name: 'Kilter' });
    expect(kilter.getAttribute('aria-pressed')).toBe('true');
    // Toggling the only selected type off clears the filter rather than swapping it.
    expect(kilter.getAttribute('href')).toBe('/gyms');
  });
});

describe('the cascade, as rendered', () => {
  it('says what to pick first when nothing is narrowed', () => {
    renderFilters('all', {});
    expect(screen.getByText('Pick one board above and its layouts show up.')).toBeTruthy();
    expect(screen.getByText('Pick one layout and the sizes show up.')).toBeTruthy();
    expect(screen.getByText('Pick one board above and its angles show up.')).toBeTruthy();
  });

  it('opens the layout and angle tiers once one board is chosen', () => {
    renderFilters('all', { boardType: 'kilter' });
    expect(screen.queryByText('Pick one board above and its layouts show up.')).toBeNull();
    expect(screen.getByText('Kilter Board Homewall')).toBeTruthy();
    // Angles are board-scoped, so they open with the board — not with the layout.
    expect(screen.getByText('40°')).toBeTruthy();
    // Sizes still wait for a layout.
    expect(screen.getByText('Pick one layout and the sizes show up.')).toBeTruthy();
  });

  it('opens sizes once one layout is chosen', () => {
    renderFilters('all', { boardType: 'kilter', layout: '8' });
    expect(screen.queryByText('Pick one layout and the sizes show up.')).toBeNull();
    expect(submittedPairs()).toContain('layout=8');
  });

  it('opens the layout tier on a facet route with no ?boardType at all', () => {
    renderFilters('kilter', {});
    expect(screen.queryByText('Pick one board above and its layouts show up.')).toBeNull();
    expect(screen.getByText('Kilter Board Original')).toBeTruthy();
  });
});

describe('what each board really offers', () => {
  it('gives MoonBoard exactly its two angles, and no more', () => {
    renderFilters('all', { boardType: 'moonboard' });
    const angles = [...document.querySelectorAll<HTMLInputElement>('input[name="angle"]')].map((input) => input.value);
    expect(angles).toEqual(['25', '40']);
  });

  it("keeps Grasshopper's negative angle", () => {
    renderFilters('all', { boardType: 'grasshopper' });
    expect(screen.getByText('-5°')).toBeTruthy();
  });

  it('carries every Aurora id behind one size chip', () => {
    renderFilters('all', { boardType: 'kilter', layout: '8' });
    const sizeValues = [...document.querySelectorAll<HTMLInputElement>('input[name="size"]')].map(
      (input) => input.value,
    );
    // The Homewall ships LED-kit variants under shared dimensions, so there are
    // more submitted ids than visible chips.
    expect(sizeValues.length).toBeGreaterThan(0);
    expect(new Set(sizeValues).size).toBe(sizeValues.length);
  });
});

describe('a filtered panel states itself', () => {
  it('counts the narrow filters on the disclosure and lists them below', () => {
    renderFilters('all', { boardType: 'kilter', layout: '8', angle: ['40', '45'] });

    const summary = document.querySelector('summary');
    expect(summary?.textContent).toBe('Narrow it down · 3');

    const disclosure = document.querySelector('details');
    expect(disclosure?.hasAttribute('open')).toBe(true);

    expect(screen.getByText(/^Filtering by/)).toBeTruthy();
    expect(screen.getByText(/Kilter Board Homewall · 40° · 45°/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Clear all filters' }).getAttribute('href')).toBe('/gyms?boardType=kilter');
  });

  it('stays closed and quiet when nothing is narrowed', () => {
    renderFilters('all', { boardType: 'kilter' });
    expect(document.querySelector('summary')?.textContent).toBe('Narrow it down');
    expect(document.querySelector('details')?.hasAttribute('open')).toBe(false);
    expect(screen.queryByRole('link', { name: 'Clear all filters' })).toBeNull();
  });

  it('submits the gym-level toggle as its own enumerated value', () => {
    renderFilters('all', { boards: '2plus' });
    expect(submittedPairs()).toContain('boards=2plus');
  });
});

describe('crawl surface', () => {
  it('renders the narrow tiers as form controls, never as links', () => {
    renderFilters('all', { boardType: 'kilter', layout: '8' });
    const disclosure = document.querySelector('details');
    expect(disclosure).toBeTruthy();
    // Inside the disclosure there is exactly one link — "clear" is outside it —
    // because 51 (board, layout, size) triples rendered as anchors would be a
    // crawlable URL per combination, in every locale, all of them noindex.
    expect(within(disclosure as HTMLElement).queryAllByRole('link')).toHaveLength(0);
    expect(within(disclosure as HTMLElement).queryAllByRole('checkbox').length).toBeGreaterThan(0);
  });
});

/**
 * The panel and the search form share one `<form>`, and that is exactly where a
 * filter can go wrong in a way neither piece shows on its own.
 *
 * A hidden `<input name="layout">` next to a real checkbox of the same name is
 * submitted whatever the box says — so unticking a layout would leave it
 * applied, with no way to remove it short of "Clear all filters". The panel owns
 * the controls for every tier it renders; only the board-type row, which is
 * anchors and has no control in the form, gets a hidden input.
 */
describe('no control is submitted twice', () => {
  it('gives each narrow filter exactly one input', () => {
    renderFilters('all', { boardType: 'kilter', layout: '8', angle: '40' });

    for (const name of ['layout', 'size', 'angle', 'boards']) {
      const inputs = [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)];
      expect(inputs.every((input) => input.type === 'checkbox')).toBe(true);
      // One input per value — a hidden twin of a checked box is what makes a
      // filter unremovable.
      const values = inputs.map((input) => input.value);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it('leaves an unchecked box carrying nothing', () => {
    renderFilters('all', { boardType: 'kilter', layout: '8' });
    const unchecked = [...document.querySelectorAll<HTMLInputElement>('input[name="layout"]')].filter(
      (input) => !input.defaultChecked,
    );
    expect(unchecked.length).toBeGreaterThan(0);
    // Nothing hidden re-asserts the value the visitor just turned off.
    expect(document.querySelector('input[type="hidden"][name="layout"]')).toBeNull();
  });
});
