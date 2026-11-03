import { afterEach, describe, expect, it } from 'vite-plus/test';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';
import HelpCallout from '../help-callout';
import HelpSteps from '../help-steps';
import HelpTopicsNav from '../help-topics-nav';

afterEach(cleanup);

describe('HelpSteps', () => {
  it('renders a real ordered list whose drawn numerals stay out of the accessible text', () => {
    render(<HelpSteps steps={['Tap Share.', 'Pick Boardsesh.', 'Tap the climb.']} />);

    const list = screen.getByRole('list');
    expect(list.tagName).toBe('OL');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['1Tap Share.', '2Pick Boardsesh.', '3Tap the climb.']);
    for (const item of items) {
      expect(item.querySelector('[aria-hidden="true"]')?.textContent).toMatch(/^\d$/);
    }
  });
});

describe('HelpCallout', () => {
  it('is a note with an optional title', () => {
    render(<HelpCallout title="Before you start">iOS asks for Bluetooth.</HelpCallout>);

    const note = screen.getByRole('note');
    expect(note.textContent).toBe('Before you startiOS asks for Bluetooth.');
  });
});

describe('HelpTopicsNav', () => {
  it('marks the first topic as the current location before any scrolling', () => {
    render(
      <HelpTopicsNav
        label="Help topics"
        topics={[
          { id: 'guides', label: 'Guides' },
          { id: 'get-help', label: 'Get help' },
        ]}
      />,
    );

    const nav = screen.getByRole('navigation', { name: 'Help topics' });
    expect(within(nav).getByRole('link', { name: 'Guides' }).getAttribute('aria-current')).toBe('location');
    expect(within(nav).getByRole('link', { name: 'Get help' }).hasAttribute('aria-current')).toBe(false);
  });
});
