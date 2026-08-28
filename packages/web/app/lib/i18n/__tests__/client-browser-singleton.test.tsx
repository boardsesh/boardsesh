// @vitest-environment jsdom
import React, { useContext } from 'react';
import { render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { I18nContext, useTranslation } from 'react-i18next';
import { I18nProvider } from '../client';

// The other half of issue #4519. Giving the server a per-render instance must
// not cost the browser its single instance per tab: one i18next object,
// accumulating bundles across mounts, is what keeps a client-side navigation
// from re-bootstrapping i18next and re-rendering every translated subtree from
// scratch (PR #1778).
//
// jsdom on purpose — the provider branches on `typeof window`, so the node run
// (ssr-locale-isolation.test.tsx) covers the server half.

// Read the instance off the context rather than off `useTranslation`, which
// hands back a per-language wrapper object with its own identity.
const mountedInstances: unknown[] = [];

function Probe() {
  const context = useContext(I18nContext) as { i18n: unknown } | undefined;
  mountedInstances.push(context?.i18n);
  const { t } = useTranslation('common');
  return <span>{t('hello')}</span>;
}

afterEach(() => {
  cleanup();
  // Module scope, so it would otherwise carry entries into a watch-mode re-run
  // or into a second `it` in this describe.
  mountedInstances.length = 0;
});

describe('I18nProvider in the browser', () => {
  it('reuses one instance and keeps the bundles earlier mounts added', async () => {
    const german = render(
      <I18nProvider locale="de" resources={{ common: { hello: 'Hallo' } }}>
        <Probe />
      </I18nProvider>,
    );
    expect(german.container.textContent).toBe('Hallo');
    german.unmount();

    const french = render(
      <I18nProvider locale="fr" resources={{ common: { hello: 'Bonjour' } }}>
        <Probe />
      </I18nProvider>,
    );
    await french.findByText('Bonjour');
    french.unmount();

    // Third mount ships NO resources at all, and `hello` is not a real catalog
    // key — `Hallo` can only come back if the same instance is still holding
    // the bundle the first mount registered.
    const germanAgain = render(
      <I18nProvider locale="de" resources={{}}>
        <Probe />
      </I18nProvider>,
    );
    await germanAgain.findByText('Hallo');

    expect(mountedInstances).toHaveLength(3);
    expect(new Set(mountedInstances).size).toBe(1);
  });
});
