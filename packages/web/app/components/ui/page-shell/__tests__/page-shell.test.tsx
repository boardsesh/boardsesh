import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { InfoOutlined } from '@mui/icons-material';
import { PageShell, PageSection, PageCard, Prose, ProseList } from '..';

describe('PageShell', () => {
  it('renders the title as the page’s only h1, whatever the visual scale', () => {
    // titleVariant changes the type size, not the element: every page that uses
    // the shell owes a crawler exactly one h1, and five pages rely on this.
    for (const titleVariant of ['h1', 'h2'] as const) {
      const { container } = render(
        <PageShell title="Keep Boardsesh running" titleVariant={titleVariant}>
          <p>body</p>
        </PageShell>,
      );
      const h1s = container.querySelectorAll('h1');
      expect(h1s).toHaveLength(1);
      expect(h1s[0]?.textContent).toBe('Keep Boardsesh running');
      expect(container.querySelectorAll('h2')).toHaveLength(0);
    }
  });

  it('renders a <main> landmark exactly once', () => {
    const { container } = render(
      <PageShell title="About">
        <p>body</p>
      </PageShell>,
    );
    expect(container.querySelectorAll('main')).toHaveLength(1);
  });

  it('renders the optional lead, eyebrow and breadcrumb slots only when given', () => {
    const { container: bare } = render(<PageShell title="About">{null}</PageShell>);
    expect(bare.textContent).toBe('About');

    const { container: full } = render(
      <PageShell title="About" lead="What this is" eyebrow="Boardsesh" breadcrumb={<a href="/">Home</a>}>
        {null}
      </PageShell>,
    );
    expect(full.textContent).toContain('What this is');
    expect(full.textContent).toContain('Boardsesh');
    expect(full.querySelector('a[href="/"]')).toBeTruthy();
  });
});

describe('PageSection', () => {
  it('defaults to h2 and drops to h3 for a sub-section', () => {
    const { container } = render(
      <PageSection title="Why this page exists">
        <PageSection headingLevel={3} title="The small print">
          <p>body</p>
        </PageSection>
      </PageSection>,
    );
    expect(container.querySelector('h2')?.textContent).toBe('Why this page exists');
    expect(container.querySelector('h3')?.textContent).toBe('The small print');
  });

  it('renders as a <section> and carries an id for anchor links', () => {
    // /help#climb-counts is linked from docs/kilter-sync.md, so the id has to
    // survive on a real element the browser can scroll to.
    const { container } = render(
      <PageSection id="climb-counts" title="Climb counts">
        <p>body</p>
      </PageSection>,
    );
    const section = container.querySelector('section#climb-counts');
    expect(section).toBeTruthy();
    expect(section?.tagName).toBe('SECTION');
  });

  it('colours the icon from tone rather than the call site', () => {
    const { container } = render(
      <PageSection title="Heads up" icon={<InfoOutlined data-testid="icon" />} tone="accent">
        <p>body</p>
      </PageSection>,
    );
    const icon = container.querySelector('[data-testid="icon"]');
    expect(icon?.getAttribute('class')).toContain('toneAccent');
  });

  it('renders an untitled section without an empty heading', () => {
    const { container } = render(
      <PageSection>
        <p>body</p>
      </PageSection>,
    );
    expect(container.querySelectorAll('h2, h3')).toHaveLength(0);
    expect(container.querySelector('section')).toBeTruthy();
  });
});

describe('PageCard', () => {
  it('passes extra props through, so a test id survives', () => {
    // The Stripe donation rail is found by data-testid in the support tests.
    const { container } = render(
      <PageCard variant="elevated" data-testid="support-one-time-rail">
        <p>body</p>
      </PageCard>,
    );
    expect(container.querySelector('[data-testid="support-one-time-rail"]')).toBeTruthy();
  });

  it('keeps a caller className alongside its own', () => {
    const { container } = render(<PageCard className="rail">body</PageCard>);
    const card = container.firstElementChild;
    expect(card?.getAttribute('class')).toContain('rail');
    expect(card?.getAttribute('class')).toContain('card');
  });
});

describe('Prose', () => {
  it('renders paragraphs and both list flavours', () => {
    const { container } = render(
      <>
        <Prose>First</Prose>
        <ProseList>
          <li>bullet</li>
        </ProseList>
        <ProseList ordered>
          <li>step</li>
        </ProseList>
      </>,
    );
    expect(container.querySelector('p')?.textContent).toBe('First');
    expect(container.querySelector('ul')?.textContent).toBe('bullet');
    expect(container.querySelector('ol')?.textContent).toBe('step');
  });
});
