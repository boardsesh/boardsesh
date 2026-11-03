import { afterEach, describe, expect, it } from 'vite-plus/test';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';
import HelpWallButtonStates, {
  WALL_BUTTON_CROP_BOX,
  WALL_BUTTON_CROP_OFFSETS,
  wallButtonCrop,
} from '../help-wall-button';
import { helpScreenshot } from '@/app/lib/help-screenshots';

afterEach(cleanup);

describe('wall button crop', () => {
  it.each(Object.keys(WALL_BUTTON_CROP_OFFSETS) as Array<keyof typeof WALL_BUTTON_CROP_OFFSETS>)(
    'keeps the %s crop box inside its capture',
    (shot) => {
      const { x, y } = WALL_BUTTON_CROP_OFFSETS[shot];
      const capture = helpScreenshot(shot);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + WALL_BUTTON_CROP_BOX.width).toBeLessThanOrEqual(capture.width);
      expect(y + WALL_BUTTON_CROP_BOX.height).toBeLessThanOrEqual(capture.height);
    },
  );

  it('turns capture pixels into box percentages', () => {
    // 736 / 697 wide, 20 / 697 in from the left, 1387 / 92 down from the top.
    expect(wallButtonCrop('preview')).toEqual({ width: '105.595%', left: '-2.869%', top: '-1507.609%' });
  });
});

describe('HelpWallButtonStates', () => {
  it('renders one list item per state with its heading and the cropped capture', () => {
    render(
      <HelpWallButtonStates
        states={[
          {
            shot: 'preview',
            driving: false,
            label: 'Looking',
            title: 'Put on board',
            body: 'Nothing lights.',
            alt: 'A',
          },
          {
            shot: 'drive-open',
            driving: true,
            label: 'Swipe',
            title: 'No clock',
            body: 'Lights until you tap.',
            alt: 'B',
          },
        ]}
      />,
    );
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'No clock' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'A' })).toBeTruthy();
  });
});
