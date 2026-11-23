import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LOCALE_LABELS } from '@/app/lib/i18n/config';

vi.mock('next/navigation', () => ({
  usePathname: () => '/gyms',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'fr' },
    t: (key: string, options?: { language?: string }) => `${key}:${options?.language ?? ''}`,
  }),
}));

const { default: CompactLanguageSwitcher } = await import('../compact-language-switcher');

afterEach(cleanup);

describe('the language menu marks the current locale', () => {
  it('announces the current locale with aria-current and shows it with a hidden check', () => {
    render(<CompactLanguageSwitcher />);
    fireEvent.click(screen.getByRole('button'));

    const current = screen.getByRole('menuitem', { name: LOCALE_LABELS.fr });
    expect(current.getAttribute('aria-current')).toBe('true');
    const check = current.querySelector('[data-selected-check]');
    expect(check).not.toBeNull();
    expect(check?.getAttribute('aria-hidden')).toBe('true');

    const other = screen.getByRole('menuitem', { name: LOCALE_LABELS['en-US'] });
    expect(other.hasAttribute('aria-current')).toBe(false);
    expect(other.querySelector('[data-selected-check]')).toBeNull();
  });
});
