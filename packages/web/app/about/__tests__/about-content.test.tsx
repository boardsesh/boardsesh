// @vitest-environment jsdom

import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import AboutContent from '../about-content';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/app/components/marketing/marketing-screenshot', () => ({
  MarketingScreenshot: () => <div data-testid="marketing-screenshot" />,
  MarketingPreviewSwitch: () => <div data-testid="preview-switch" />,
}));

const acknowledgements = vi.hoisted(() => ({
  sponsors: [
    {
      login: 'sponsor-login',
      name: 'Sponsor Name',
      avatarUrl: 'https://avatars.example/s.png',
      url: 'https://github.com/sponsor-login',
    },
  ],
}));
vi.mock('@boardsesh/acknowledgements', () => acknowledgements);

const SUPPORTERS = [
  { userId: 'user/1', displayName: 'First Climber', avatarUrl: 'https://avatars.example/1.png' },
  { userId: 'user-2', displayName: 'Second Climber', avatarUrl: null },
];

function hrefs(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'));
}

describe('AboutContent supporters', () => {
  it('names each public supporter and links to their profile', () => {
    const { container } = render(<AboutContent publicSupporters={SUPPORTERS} />);

    const list = screen.getByTestId('about-public-supporters');
    expect(list.textContent).toContain('First Climber');
    expect(list.textContent).toContain('Second Climber');
    expect(hrefs(container)).toContain('/profile/user%2F1');
    expect(hrefs(container)).toContain('/profile/user-2');
  });

  it('lists GitHub Sponsors from the generated acknowledgements', () => {
    const { container } = render(<AboutContent publicSupporters={[]} />);

    expect(screen.getByText('Sponsor Name')).toBeTruthy();
    expect(hrefs(container)).toContain('https://github.com/sponsor-login');
  });

  // The backend being down, or nobody opting in yet, must not break /about.
  it('keeps the section and its ask without any public supporter', () => {
    const { container } = render(<AboutContent publicSupporters={[]} />);

    expect(screen.queryByTestId('about-public-supporters')).toBeNull();
    expect(screen.getByText(tFromCatalog('marketing', 'about.supporters.title'))).toBeTruthy();
    expect(hrefs(container)).toContain('/support');
  });

  it('shows no amounts and promises nothing', () => {
    const { container } = render(<AboutContent publicSupporters={SUPPORTERS} />);

    expect(container.textContent).not.toMatch(/[$€£]\s?\d|unlock|early access|priority|premium|perk/i);
  });
});
