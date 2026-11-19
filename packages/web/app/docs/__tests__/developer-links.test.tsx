import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { getDeveloperDocsState } from '@/app/lib/developer-apps/docs-access';
import DocsClientPage from '@/app/docs/docs-client';
import HelpContent from '@/app/help/help-content';

vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({
    t: (key: string) => tFromCatalog(namespace, key),
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@/app/help/help-install-section', () => ({ default: () => null }));

describe.each([
  ['Docs', DocsClientPage],
  ['Help', HelpContent],
] as const)('%s developer links', (_label, Content) => {
  it.each(['off', 'hold'])('offers contact instead of a dead developer route in %s mode', (mode) => {
    const { container } = render(<Content developerDocsState={getDeveloperDocsState(mode)} />);
    expect(container.querySelector('a[href="/developers"]')).toBeNull();
    expect(screen.getByRole('link', { name: 'Ask about developer access' }).getAttribute('href')).toBe(
      'mailto:support@boardsesh.com',
    );
  });

  it.each(['allowlist', 'open'])('links to the available developer guide in %s mode', (mode) => {
    const { container } = render(<Content developerDocsState={getDeveloperDocsState(mode)} />);
    expect(container.querySelector('a[href="/developers"]')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Ask about developer access' })).toBeNull();
  });
});
