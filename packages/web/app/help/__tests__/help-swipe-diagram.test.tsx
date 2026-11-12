import { afterEach, describe, expect, it } from 'vite-plus/test';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';
import HelpSwipeDiagram, { type HelpSwipeDiagramLabels } from '../help-swipe-diagram';

afterEach(cleanup);

const labels: HelpSwipeDiagramLabels = {
  description: 'Where a swipe goes in the player.',
  listCaption: 'Tap a climb in a list: swipes walk that list. Nothing lights.',
  listCurrent: 'Search results · 4 of 23',
  listPrevious: 'Climb 3',
  listNext: 'Climb 5',
  wallCaption: 'From the climb on the wall: Up next first, then the list it came from.',
  preview: 'Preview · not on the wall',
  putOnBoard: 'Put on board',
  onWall: 'On the wall',
  upNext: 'Up next',
  thenFrom: 'Then from Search results',
  endCard: 'End of the list',
};

describe('HelpSwipeDiagram', () => {
  it('is one image named by the description and draws every label', () => {
    render(<HelpSwipeDiagram labels={labels} />);

    const figure = screen.getByRole('img', { name: labels.description });
    expect(figure.tagName).toBe('FIGURE');
    for (const [key, text] of Object.entries(labels)) {
      if (key === 'description') continue;
      expect(within(figure).getByText(text)).toBeTruthy();
    }
  });
});
