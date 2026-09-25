// @vitest-environment node
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

/**
 * The homepage's ask, rendered server-side: every link a real anchor, and copy
 * that promises nothing back for money.
 *
 * The perks case here is the rendered-output half of the guard. The catalog
 * half — every locale, not just en-US — is
 * `donation-disclosure.test.ts` in `@boardsesh/i18n`.
 */

function resolveMarketingKey(dottedKey: string): string {
  return tFromCatalog('marketing', dottedKey);
}

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({
    t: (key: string) => resolveMarketingKey(key),
    locale: 'en-US',
  })),
}));

// `LocaleLink` is a client component wrapping `next/link`; a plain anchor keeps
// the assertion about the href the block emits rather than about Next routing.
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { default: HomeSupportBlock } = await import('../home-support-block');

const NON_MONETARY_LINKS = [
  'https://github.com/boardsesh/boardsesh/issues',
  'https://github.com/boardsesh/boardsesh/tree/main/packages/shared/i18n/locales',
  'https://github.com/boardsesh/boardsesh',
  'https://discord.gg/YXA8GsXfQK',
];

async function renderBlock(): Promise<string> {
  return renderToStaticMarkup(await HomeSupportBlock());
}

describe('HomeSupportBlock', () => {
  it('sends the money ask to /support as a real anchor', async () => {
    const html = await renderBlock();

    expect(html).toContain('href="/support"');
    expect(html).toContain(resolveMarketingKey('home.support.chipIn'));
    expect(html).toContain(resolveMarketingKey('home.support.title'));
  });

  it('offers all four non-monetary ways to help, each a real anchor', async () => {
    const html = await renderBlock();

    for (const href of NON_MONETARY_LINKS) {
      expect(html, `missing anchor for ${href}`).toContain(`href="${href}"`);
    }
    expect(html).toContain(resolveMarketingKey('support.otherWays.bug.title'));
    expect(html).toContain(resolveMarketingKey('support.otherWays.translate.title'));
    expect(html).toContain(resolveMarketingKey('support.otherWays.patch.title'));
    expect(html).toContain(resolveMarketingKey('support.otherWays.discord.title'));
    expect(html).toContain(resolveMarketingKey('home.support.otherWays'));
  });

  it('promises nothing in return and names no figure', async () => {
    const html = await renderBlock();

    // Donations buy nothing: no unlocks, no early access, no priority anything.
    expect(html).not.toMatch(/unlock|early access|priority support|perk|reward|exclusive/i);
    // And the block never states an amount — no hosting cost, no revenue, no
    // climber count. Boardsesh is not a charity and cannot imply either.
    expect(html).not.toMatch(/[$€£]\s?\d|\d+\s?(usd|eur|gbp|aud)\b/i);
  });
});
