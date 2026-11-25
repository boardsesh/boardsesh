import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DocumentLocaleProvider } from '@/app/lib/i18n/document-locale-context';
import { LOCALE_LABELS, SUPPORTED_LOCALES } from '@/app/lib/i18n/config';

const route = vi.hoisted(() => ({ pathname: '/fr/gyms' }));
const menu = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock('../compact-language-menu-loader', () => ({ loadCompactLanguageMenu: menu.load }));

vi.mock('next/navigation', () => ({
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(),
}));
const { default: CompactLanguageSwitcher } = await import('../compact-language-switcher');

function renderSwitcher() {
  return render(
    <DocumentLocaleProvider locale="fr">
      <CompactLanguageSwitcher ariaLabel="Langue : Français" />
    </DocumentLocaleProvider>,
  );
}

beforeEach(() => {
  menu.load.mockReset().mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  route.pathname = '/fr/gyms';
});

describe('the language menu marks the current locale', () => {
  it('announces the current locale with aria-current and shows it with a hidden check', () => {
    renderSwitcher();
    expect(menu.load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button'));
    expect(menu.load).toHaveBeenCalledOnce();
    expect(screen.getAllByRole('menuitem')).toHaveLength(SUPPORTED_LOCALES.length);

    const current = screen.getByRole('menuitem', { name: LOCALE_LABELS.fr });
    expect(current.getAttribute('aria-current')).toBe('true');
    const check = current.querySelector('[data-selected-check]');
    expect(check).not.toBeNull();
    expect(check?.getAttribute('aria-hidden')).toBe('true');

    const other = screen.getByRole('menuitem', { name: LOCALE_LABELS['en-US'] });
    expect(other.hasAttribute('aria-current')).toBe(false);
    expect(other.querySelector('[data-selected-check]')).toBeNull();
  });

  it('offers immediate keyboard choices and restores focus while the menu chunk is pending', () => {
    renderSwitcher();
    const trigger = screen.getByRole('button');
    trigger.focus();
    fireEvent.click(trigger);
    const current = screen.getByRole('menuitem', { name: LOCALE_LABELS.fr });
    expect(document.activeElement).toBe(current);
    fireEvent.keyDown(current, { key: 'End' });
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem').at(-1));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps language choices working if the enhanced menu cannot download', async () => {
    menu.load.mockRejectedValue(new Error('offline'));
    renderSwitcher();
    const trigger = screen.getByRole('button');
    fireEvent.click(trigger);
    await act(async () => {});
    expect(screen.getAllByRole('menuitem')).toHaveLength(SUPPORTED_LOCALES.length);
    fireEvent.click(screen.getByRole('menuitem', { name: LOCALE_LABELS.fr }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it.each([24, 260])('keeps the cold menu inside a 320px viewport for trigger left=%s', (triggerLeft) => {
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')!;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    try {
      renderSwitcher();
      const trigger = screen.getByRole('button');
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(triggerLeft, 600, 65, 44));
      fireEvent.click(trigger);
      const computed = getComputedStyle(screen.getByRole('menu'));
      const left = Number.parseFloat(computed.left);
      const width = Number.parseFloat(computed.width);
      expect(computed.position).toBe('fixed');
      expect(left).toBeGreaterThanOrEqual(16);
      expect(left + width).toBeLessThanOrEqual(304);
    } finally {
      Object.defineProperty(window, 'innerWidth', originalWidth);
    }
  });

  it('keeps focus in the first opening and uses the downloaded menu on the next opening', async () => {
    let finishLoading!: (loaded: typeof import('../compact-language-menu')) => void;
    menu.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLoading = resolve;
        }),
    );
    renderSwitcher();
    const trigger = screen.getByRole('button');
    fireEvent.click(trigger);
    const current = screen.getByRole('menuitem', { name: LOCALE_LABELS.fr });
    await act(async () => {
      finishLoading(await import('../compact-language-menu'));
    });
    expect(document.activeElement).toBe(current);
    fireEvent.keyDown(current, { key: 'Escape' });
    fireEvent.click(trigger);
    expect(document.querySelector('.MuiMenu-root')).toBeTruthy();
    expect(screen.getAllByRole('menuitem')).toHaveLength(SUPPORTED_LOCALES.length);
    expect(menu.load).toHaveBeenCalledOnce();
  });

  it.each(['/apps', '/apps/kilter', '/compare/spray-wall-apps'])('hides the picker on %s', (pathname) => {
    route.pathname = pathname;
    renderSwitcher();
    expect(screen.queryByRole('button')).toBeNull();
    expect(menu.load).not.toHaveBeenCalled();
  });
});
