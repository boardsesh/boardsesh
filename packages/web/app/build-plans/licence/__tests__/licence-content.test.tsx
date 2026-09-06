import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import LicenceContent from '../licence-content';

// The licence puts four of its links inside `<Trans>` blocks, so the usual
// `children ?? null` stub would render a document with no anchors at all and
// the href assertions below would pass vacuously. This stub renders each slot
// element instead, labelled with the slot name, which is enough for the hrefs
// to be real and for the count to be meaningful.
vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ i18nKey, components }: { i18nKey?: string; components?: Record<string, React.ReactElement> }) => (
    <>
      {Object.entries(components ?? {}).map(([slot, element]) =>
        React.cloneElement(element, { key: slot }, `${i18nKey ?? ''}:${slot}`),
      )}
    </>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/build-plans/licence',
}));

function renderLicence() {
  return render(<LicenceContent />);
}

describe('LicenceContent', () => {
  it('leads with the DRAFT banner', () => {
    // First thing in the document flow on purpose: someone arriving from a
    // purchase flow has to see "not lawyer-reviewed" before they read terms.
    renderLicence();
    expect(screen.getByText('Draft licence')).toBeTruthy();
    expect(screen.getByText(/pending review by an Australian IP lawyer/)).toBeTruthy();
  });

  it('renders both licence tiers with their prices', () => {
    renderLicence();
    expect(screen.getByText('3. Personal licence (A$149)')).toBeTruthy();
    expect(screen.getByText('4. Commercial single-build licence (A$750)')).toBeTruthy();
  });

  it('links the licence contact and the volume enquiry at different addresses', () => {
    // Two distinct mailboxes, and the split is the point: legal@ answers
    // licence questions and reissues, support@ takes ten-build and OEM
    // enquiries. A single address here would route contract questions into the
    // support queue.
    const { container } = renderLicence();
    const hrefs = Array.from(container.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'));
    expect(hrefs).toContain('mailto:legal@boardsesh.com');
    expect(hrefs).toContain('mailto:support@boardsesh.com');
  });

  it('cross-links the legal and privacy policies', () => {
    // The compatibility and privacy sections both defer to a policy that lives
    // elsewhere, so these two hrefs are load-bearing: a broken one leaves the
    // licence making a claim it never substantiates.
    const { container } = renderLicence();
    const hrefs = Array.from(container.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'));
    expect(hrefs).toContain('/legal');
    expect(hrefs).toContain('/privacy');
  });

  it('renders exactly those four link targets and no others', () => {
    // In document order: volume enquiry (5), compatibility (7), privacy (10),
    // licence contact (12). Asserting the whole list catches a fifth link
    // arriving without a home for it in this file.
    const { container } = renderLicence();
    const hrefs = Array.from(container.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'));
    expect(hrefs).toEqual(['mailto:support@boardsesh.com', '/legal', '/privacy', 'mailto:legal@boardsesh.com']);
  });
});
