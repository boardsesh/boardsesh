import React from 'react';
import { describe, it, expect } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import {
  EmptyPanel,
  FieldGrid,
  KeyValueList,
  PageFrame,
  PageSection,
  PreviewGallery,
  PriceTag,
  SectionCard,
  SplitLayout,
  StatusChip,
  StepHeading,
  buildPlanStatusTone,
  type BuildPlanStatus,
} from '..';

/**
 * Render smoke plus the two things about this kit that are contracts rather
 * than styling: the page has exactly one `<h1>` (four pages share the frame, so
 * a second one here is a second one everywhere), and every order status draws a
 * chip — including the four free-preview states that are not in the GraphQL
 * enum yet.
 */

const ALL_STATUSES: readonly BuildPlanStatus[] = [
  'preview_queued',
  'preview_generating',
  'preview_ready',
  'preview_failed',
  'pending_payment',
  'queued',
  'generating',
  'ready',
  'failed',
  'cancelled',
  'refunded',
];

describe('PageFrame', () => {
  it('renders one h1 and puts the sections after the header', () => {
    const { container } = render(
      <PageFrame
        title="Build plans"
        intro="Cut-ready files."
        actions={<button type="button">Go</button>}
        note="Kilter first."
      >
        <PageSection title="How it works">
          <p>Three steps.</p>
        </PageSection>
      </PageFrame>,
    );

    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Build plans');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('How it works');
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByText('Kilter first.')).toBeTruthy();
  });
});

describe('SectionCard', () => {
  it('renders its heading at the level the caller asked for', () => {
    render(
      <SectionCard title="Personal" description="One wall." headingLevel="h2">
        <p>Body</p>
      </SectionCard>,
    );
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Personal');
    expect(screen.getByText('One wall.')).toBeTruthy();
  });

  it('renders without a head when it has no title, description or action', () => {
    const { container } = render(
      <SectionCard>
        <p>Just a body</p>
      </SectionCard>,
    );
    expect(container.querySelectorAll('h1, h2, h3, h4')).toHaveLength(0);
  });
});

describe('StepHeading', () => {
  it('shows the number and hides it from assistive tech', () => {
    // The numeral is a visual index of a sequence the heading already names —
    // read aloud it is just "3" before the title.
    const { container } = render(<StepHeading step={3} title="Engraving" description="Both off by default." />);
    expect(screen.getByText('3')).toBeTruthy();
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe('3');
  });
});

describe('KeyValueList', () => {
  it('renders a dt/dd pair per item', () => {
    const { container } = render(
      <KeyValueList
        items={[
          { key: 'panels', label: 'Panels', value: '3 panels' },
          { key: 'sheets', label: 'Sheets', value: '4 sheets', hint: 'At 2440 × 1220 mm' },
        ]}
      />,
    );
    expect(container.querySelectorAll('dt')).toHaveLength(2);
    expect(container.querySelectorAll('dd')).toHaveLength(2);
    expect(screen.getByText('At 2440 × 1220 mm')).toBeTruthy();
  });
});

describe('PriceTag', () => {
  it('renders the formatted amount and its note', () => {
    render(<PriceTag amount="A$149.00" note="per wall" size="lg" />);
    expect(screen.getByText('A$149.00')).toBeTruthy();
    expect(screen.getByText('per wall')).toBeTruthy();
  });
});

describe('StatusChip', () => {
  it('draws every status, preview states included', () => {
    for (const status of ALL_STATUSES) {
      const { unmount } = render(<StatusChip status={status} label={status} />);
      expect(screen.getByText(status)).toBeTruthy();
      unmount();
    }
  });

  it('reads a ready preview as the brand tone and a paid pack as success', () => {
    // The two "ready" states must not look alike: one wants finalising, the
    // other is already downloadable.
    expect(buildPlanStatusTone('preview_ready')).toBe('brand');
    expect(buildPlanStatusTone('ready')).toBe('success');
    expect(buildPlanStatusTone('preview_failed')).toBe('error');
    expect(buildPlanStatusTone('generating')).toBe('progress');
  });
});

describe('SplitLayout', () => {
  it('names the rail for screen readers', () => {
    render(
      <SplitLayout rail={<p>Summary</p>} railLabel="What gets cut">
        <p>Form</p>
      </SplitLayout>,
    );
    expect(screen.getByRole('complementary', { name: 'What gets cut' })).toBeTruthy();
  });
});

describe('FieldGrid', () => {
  it('renders its fields', () => {
    render(
      <FieldGrid>
        <label htmlFor="a">Sheet size</label>
      </FieldGrid>,
    );
    expect(screen.getByText('Sheet size')).toBeTruthy();
  });
});

describe('PreviewGallery', () => {
  it('renders one figure per sheet, with the label as alt text', () => {
    const { container } = render(
      <PreviewGallery
        aria-label="Preview sheets"
        note="Watermarked. Finalise to get the DXF."
        images={[
          { name: 'panel1.png', url: 'https://example.test/panel1.png', label: 'Panel 1' },
          { name: 'assembly.png', url: 'https://example.test/assembly.png', label: 'Assembly' },
        ]}
        actions={<button type="button">Download</button>}
      />,
    );
    expect(container.querySelectorAll('figure')).toHaveLength(2);
    expect(screen.getByAltText('Panel 1')).toBeTruthy();
    expect(screen.getByText('Watermarked. Finalise to get the DXF.')).toBeTruthy();
  });
});

describe('EmptyPanel', () => {
  it('always offers a way out', () => {
    render(
      <EmptyPanel title="Nothing here yet." body="Configure a wall." action={<button type="button">Start</button>} />,
    );
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy();
  });
});
