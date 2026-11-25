import { describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { DocumentLocaleProvider } from '@/app/lib/i18n/document-locale-context';
import common from '@boardsesh/i18n/locales/fr/common.json';
import consent from '@boardsesh/i18n/locales/fr/consent.json';
import MarketingSiteFooter from '../marketing-site-footer';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ usePathname: () => '/fr' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => {
    throw new Error('The marketing footer must render without a browser translation provider');
  },
}));
const openChoices = vi.hoisted(() => vi.fn());
vi.mock('@/app/components/consent/consent-state-provider', () => ({ useConsent: () => ({ openChoices }) }));

describe('MarketingSiteFooter', () => {
  it('renders French labels and localized links in the first HTML', async () => {
    const footer = await MarketingSiteFooter({ locale: 'fr', developerHref: '/docs' });
    const html = renderToString(<DocumentLocaleProvider locale="fr">{footer}</DocumentLocaleProvider>);
    const page = new DOMParser().parseFromString(html, 'text/html');
    expect(page.querySelector('nav')?.getAttribute('aria-label')).toBe(common.footer.navLabel);
    expect(page.querySelector('a[href="/fr/docs"]')?.textContent).toBe(common.footer.journeys.developers);
    expect(page.querySelector('a[href="/apps"]')?.textContent).toBe(common.footer.journeys.appGuides);
    expect(page.querySelector('button[aria-haspopup="menu"]')?.getAttribute('aria-label')).toBe(
      common.languageSwitcher.ariaLabelWithCurrent.replace('{{language}}', 'Français'),
    );
  });

  it('reopens privacy choices using the server-translated consent label', async () => {
    const footer = await MarketingSiteFooter({ locale: 'fr', developerHref: '/developers' });
    render(<DocumentLocaleProvider locale="fr">{footer}</DocumentLocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: consent.privacyChoices }));
    expect(openChoices).toHaveBeenCalledOnce();
  });
});
