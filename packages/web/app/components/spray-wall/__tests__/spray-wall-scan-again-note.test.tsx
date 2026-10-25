import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { __resetBoardQrLandingForTests } from '@/app/lib/board-qr-landing';
import SprayWallScanAgainNote from '../spray-wall-scan-again-note';

const TEXT = 'Just installed? Scan again to open this Spraywall.';

beforeEach(() => {
  __resetBoardQrLandingForTests();
  window.history.replaceState(null, '', '/');
});

describe('SprayWallScanAgainNote', () => {
  it('tells someone who scanned the code to scan again after installing', async () => {
    window.history.replaceState(null, '', '/b/garage-wall/40/list?src=qr&medium=board');

    render(<SprayWallScanAgainNote text={TEXT} />);

    expect(await screen.findByText(TEXT)).toBeTruthy();
  });

  it('says nothing to someone who followed a shared link', () => {
    window.history.replaceState(null, '', '/b/garage-wall/40/list?wall=ab12cd34');

    const { container } = render(<SprayWallScanAgainNote text={TEXT} />);

    expect(container.innerHTML).toBe('');
  });

  it('is not in the server HTML, which is the same for a scan and a shared link', () => {
    window.history.replaceState(null, '', '/b/garage-wall/40/list?src=qr&medium=board');

    expect(renderToString(<SprayWallScanAgainNote text={TEXT} />)).toBe('');
  });
});
