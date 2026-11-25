import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async (namespace: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
    locale: 'en-US',
  }),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { default: DevelopersPage, generateMetadata } = await import('@/app/(site)/developers/page');

const originalMode = process.env.PARTNER_OAUTH_MODE;

function setMode(mode: string | undefined) {
  if (mode === undefined) delete process.env.PARTNER_OAUTH_MODE;
  else process.env.PARTNER_OAUTH_MODE = mode;
}

beforeEach(() => setMode(undefined));
afterEach(() => setMode(originalMode));

describe('developer docs page', () => {
  it.each([undefined, 'off', 'hold', 'typo'])('is a 404 with no title while PARTNER_OAUTH_MODE is %s', async (mode) => {
    setMode(mode);
    await expect(DevelopersPage()).rejects.toThrow('NOT_FOUND');
    const metadata = await generateMetadata();
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.title).toBeUndefined();
    expect(metadata.description).toBeUndefined();
  });

  it('says registration is by invitation in allowlist mode, and stays noindex', async () => {
    setMode('allowlist');
    const { container } = render(await DevelopersPage());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("Connect an app to a climber's logbook");
    expect(screen.getByRole('heading', { name: 'Registration is by invitation' })).toBeTruthy();
    expect(container.textContent).toContain('support@boardsesh.com');
    expect(container.textContent).toContain('25 climbers connected at once and 20 new ones');
    expect(screen.queryByRole('link', { name: 'Open the developer console' })).toBeNull();

    const metadata = await generateMetadata();
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe('/developers');
  });

  it('invites developers to the console in open mode, and is indexable', async () => {
    setMode('open');
    const { container } = render(await DevelopersPage());
    expect(screen.getByRole('heading', { name: 'Register your app' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the developer console' }).getAttribute('href')).toBe(
      '/developers/apps',
    );
    expect(screen.queryByRole('heading', { name: 'Registration is by invitation' })).toBeNull();
    expect(container.textContent).not.toContain('support@boardsesh.com');

    const metadata = await generateMetadata();
    expect(metadata.robots).not.toMatchObject({ index: false });
    expect(metadata.title).toBeTruthy();
    expect(metadata.description).toBeTruthy();
    expect(metadata.alternates?.canonical).toBe('/developers');
  });

  it.each(['allowlist', 'open'])('has one h1, every section and untranslated code samples in %s mode', async (mode) => {
    setMode(mode);
    const { container } = render(await DevelopersPage());
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    for (const heading of [
      'What an app can do',
      'How it works',
      'Scopes',
      'Rules that catch developers out',
      'A first connection',
      'Limits',
      'Errors',
      'Versions',
      'Keep reading',
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    }
    expect(container.querySelectorAll('pre')).toHaveLength(4);
    expect(container.textContent).toContain('https://api.boardsesh.com/api/auth/oauth2/authorize');
    expect(container.textContent).toContain('logbook:read');
    // Workouts and webhooks are not live, so no scope or endpoint for them.
    expect(container.textContent).not.toContain('workouts:write');
    expect(container.textContent).not.toContain('/v1/workouts');
    // The console's recent sign-in rule, with the minutes taken from the shared constant.
    expect(container.textContent).toContain('each need a sign-in within the last 5 minutes');
    expect(container.textContent).toContain('You get an email when redirect URIs change');
    // Every line resolved to catalog text: no key printed in its place.
    expect(container.textContent).not.toMatch(/docs\.[a-z]+\./);
    const internalLinks = [...container.querySelectorAll('a')].map((link) => link.getAttribute('href'));
    expect(internalLinks).toEqual(expect.arrayContaining(['/docs', '/privacy', '/legal', '/support']));
  });
});
