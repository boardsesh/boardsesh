import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import EndpointCopy from '../endpoint-copy';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCopy() {
  render(<EndpointCopy label="Server URL" copy="Copy URL" copied="Copied" failed="Select and copy the URL" />);
}

describe('copying the hosted endpoint', () => {
  it('copies exactly the documented URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderCopy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    expect(await screen.findByText('Copied')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('https://api.boardsesh.com/mcp/gyms');
  });

  it('leaves the URL selectable when the browser refuses clipboard access', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    renderCopy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    expect(await screen.findByText('Select and copy the URL')).toBeTruthy();
    expect((screen.getByLabelText('Server URL') as HTMLInputElement).readOnly).toBe(true);
  });
});
