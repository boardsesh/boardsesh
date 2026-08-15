// @vitest-environment node
import { describe, expect, it } from 'vite-plus/test';
import { PassThrough } from 'node:stream';
import React, { Suspense } from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { useTranslation } from 'react-i18next';
import { I18nProvider } from '../client';

// `'use client'` components are rendered to HTML on the server on every
// request, and one Node process interleaves many requests. Issue #4519: the
// provider used to hand every one of them the same module-scoped i18next
// instance, so a `/fr` request starting mid-render flipped the language under
// a half-rendered `/de` page and shipped it French markup.
//
// This file runs in the `node` environment on purpose — `typeof window` is what
// the provider branches on, so a jsdom run would exercise the browser
// singleton instead (see client-browser-singleton.test.tsx for that half).

const flushMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// A component that suspends until released, so a render can be parked halfway
// the way Next.js streaming SSR parks one on an await.
function createSuspenseGate() {
  let isOpen = false;
  let openGate = () => {};
  const pending = new Promise<void>((resolve) => {
    openGate = () => {
      isOpen = true;
      resolve();
    };
  });

  function Gate({ children }: { children: React.ReactNode }) {
    if (!isOpen) throw pending;
    return <>{children}</>;
  }

  return {
    Gate,
    release: () => {
      openGate();
    },
  };
}

function renderRequest(element: React.ReactElement): Promise<string> {
  const sink = new PassThrough();
  let body = '';
  sink.on('data', (chunk: Buffer) => {
    body += chunk.toString('utf8');
  });

  const finished = new Promise<string>((resolve, reject) => {
    sink.on('end', () => resolve(body));
    sink.on('error', reject);
  });

  const { pipe } = renderToPipeableStream(element, {
    onShellReady() {
      pipe(sink);
    },
  });

  return finished;
}

function LocaleProbe() {
  const { t, i18n } = useTranslation('common');
  return <span>{`${i18n.language}|${t('hello')}`}</span>;
}

function NestedProbe() {
  const { t } = useTranslation('marketing');
  // Key from the OUTER provider's namespace, which this provider never loaded.
  return <span>{t('common:hello')}</span>;
}

describe('I18nProvider server rendering', () => {
  it('keeps two concurrent renders on their own locale', async () => {
    const gateDe = createSuspenseGate();
    const gateFr = createSuspenseGate();

    // Request A (`/de/...`) starts and parks inside its Suspense boundary.
    const germanHtml = renderRequest(
      <I18nProvider locale="de" resources={{ common: { hello: 'Hallo' } }}>
        <Suspense fallback={<span>pending</span>}>
          <gateDe.Gate>
            <LocaleProbe />
          </gateDe.Gate>
        </Suspense>
      </I18nProvider>,
    );
    await flushMacrotask();

    // Request B (`/fr/...`) arrives while A is still parked. On the old shared
    // instance this is the `changeLanguage('fr')` that poisoned A.
    const frenchHtml = renderRequest(
      <I18nProvider locale="fr" resources={{ common: { hello: 'Bonjour' } }}>
        <Suspense fallback={<span>pending</span>}>
          <gateFr.Gate>
            <LocaleProbe />
          </gateFr.Gate>
        </Suspense>
      </I18nProvider>,
    );
    await flushMacrotask();

    gateDe.release();
    await flushMacrotask();
    gateFr.release();

    const [german, french] = await Promise.all([germanHtml, frenchHtml]);

    expect(german).toContain('de|Hallo');
    expect(german).not.toContain('Bonjour');
    expect(french).toContain('fr|Bonjour');
    expect(french).not.toContain('Hallo');
  });

  it('lets a nested provider resolve its parent namespaces', async () => {
    // The root layout and the page each mount their own provider with disjoint
    // namespace sets. Per-render instances would strand the inner subtree on
    // raw keys unless it inherits the outer provider's bundles.
    const html = await renderRequest(
      <I18nProvider locale="de" resources={{ common: { hello: 'Hallo' } }}>
        <I18nProvider locale="de" resources={{ marketing: { tagline: 'Los' } }}>
          <NestedProbe />
        </I18nProvider>
      </I18nProvider>,
    );

    expect(html).toContain('Hallo');
    expect(html).not.toContain('>hello<');
  });

  it('ignores a parent parked on another locale', async () => {
    const html = await renderRequest(
      <I18nProvider locale="fr" resources={{ common: { hello: 'Bonjour' } }}>
        <I18nProvider locale="de" resources={{ common: { hello: 'Hallo' }, marketing: { tagline: 'Los' } }}>
          <NestedProbe />
        </I18nProvider>
      </I18nProvider>,
    );

    expect(html).toContain('Hallo');
    expect(html).not.toContain('Bonjour');
  });
});
