import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { SITE_URL } from '@/app/lib/seo/base-url';
import GymPosterQr from '../gym-poster-qr';

// Capture the QRCodeSVG props so the encoded target and the print-critical
// colour/quiet-zone settings are assertable without decoding the matrix — the
// same trick the kiosk's install-QR test uses.
vi.mock('qrcode.react', () => ({
  QRCodeSVG: (props: { value: string; fgColor?: string; bgColor?: string; marginSize?: number; level?: string }) => (
    <svg
      data-testid="qr"
      data-value={props.value}
      data-fg={props.fgColor}
      data-bg={props.bgColor}
      data-margin={String(props.marginSize)}
      data-level={props.level}
    />
  ),
}));

describe('GymPosterQr', () => {
  it('encodes the canonical gym URL with the poster attribution params', () => {
    render(<GymPosterQr gymSlug="boulderwelt-ost" />);
    // Spelled out rather than round-tripped through gymQrUrl: this string is
    // printed and laminated, so the test states the exact bytes a phone will
    // resolve. Derived from SITE_URL so it tracks the base URL, not the host.
    expect(screen.getByTestId('qr').getAttribute('data-value')).toBe(
      `${SITE_URL}/gym/boulderwelt-ost?src=qr&medium=poster`,
    );
  });

  it('percent-encodes a slug so a printed URL is never malformed', () => {
    render(<GymPosterQr gymSlug="boulder#1" />);
    expect(screen.getByTestId('qr').getAttribute('data-value')).toBe(
      `${SITE_URL}/gym/boulder%231?src=qr&medium=poster`,
    );
  });

  it('sets black-on-white as SVG props, not CSS', () => {
    // Browsers drop background graphics when printing by default, so a CSS
    // quiet zone prints away and a dark-mode page yields a dark-on-dark code.
    // As props they are page content and always print.
    render(<GymPosterQr gymSlug="boulderwelt-ost" />);
    const qr = screen.getByTestId('qr');
    expect(qr.getAttribute('data-fg')).toBe('#000000');
    expect(qr.getAttribute('data-bg')).toBe('#ffffff');
  });

  it('uses the spec 4-module quiet zone, not the kiosk margin', () => {
    render(<GymPosterQr gymSlug="boulderwelt-ost" />);
    expect(screen.getByTestId('qr').getAttribute('data-margin')).toBe('4');
  });
});
