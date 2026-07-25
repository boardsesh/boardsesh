import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import PreviewChannelContent from '../preview-channel-content';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ i18nKey, ns, values }: { i18nKey: string; ns?: string; values?: Record<string, unknown> }) =>
    tFromCatalog(ns, i18nKey, values),
}));

describe('PreviewChannelContent', () => {
  it('points the primary button at the app scheme for this channel', () => {
    render(<PreviewChannelContent channel="pr-1234" pullNumber={1234} />);

    // The whole point of the page: an anchor an installed app can claim. GitHub
    // strips custom-scheme hrefs from comments, which is why this lives here and
    // not in the PR body.
    const openInApp = screen.getByRole('link', { name: 'Open in Boardsesh' });
    expect(openInApp.getAttribute('href')).toBe('com.boardsesh.app:///preview/pr-1234');
  });

  it('renders a QR and links back to the PR it describes', () => {
    const { container } = render(<PreviewChannelContent channel="pr-1234" pullNumber={1234} />);

    expect(container.querySelector('svg[height]')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Read pull request #1234 on GitHub' }).getAttribute('href')).toBe(
      'https://github.com/boardsesh/boardsesh/pull/1234',
    );
  });

  it('names the PR in the heading', () => {
    render(<PreviewChannelContent channel="pr-1234" pullNumber={1234} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Try PR #1234 in Boardsesh');
  });
});
