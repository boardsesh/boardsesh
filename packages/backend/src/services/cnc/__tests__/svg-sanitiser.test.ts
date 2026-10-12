import { describe, it, expect } from 'vite-plus/test';
import { MAX_SVG_BYTES, looksLikeSvg, sanitiseSvg } from '../svg-sanitiser';

/**
 * The audit is the only thing standing between a buyer's file and the
 * generator's XML parser, so each test names one construct that must never
 * reach it — and the last one names the file that must.
 */

const CLEAN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 L90 90 Z"/></svg>';

/** What Inkscape actually writes: a declaration, a namedview, an RDF metadata block. */
const INKSCAPE_SVG = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape -->
<svg
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
   xmlns:svg="http://www.w3.org/2000/svg"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   width="210mm"
   height="297mm"
   viewBox="0 0 210 297"
   version="1.1"
   id="svg5">
  <sodipodi:namedview id="namedview7" pagecolor="#ffffff" inkscape:zoom="0.7" />
  <metadata id="metadata1">
    <rdf:RDF><dc:title>a logo on somebody's disk</dc:title></rdf:RDF>
  </metadata>
  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1">
    <title>Crux</title>
    <path id="path1" d="M 20,20 H 190 V 277 H 20 Z" />
  </g>
</svg>`;

function expectRejected(svg: string) {
  const result = sanitiseSvg(svg);
  if (result.ok) throw new Error('expected the sanitiser to refuse this file');
  return result;
}

describe('sanitiseSvg', () => {
  it('refuses a <script> element', () => {
    expect(
      expectRejected('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>')
        .reason,
    ).toBe('disallowed_element');
  });

  it('refuses an on* handler even on an allowed element', () => {
    expect(
      expectRejected('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="fetch(1)"></svg>').reason,
    ).toBe('event_handler');
  });

  it('refuses an on* handler hidden behind a namespace prefix', () => {
    // The prefix is DECLARED, so the file parses cleanly and the attribute
    // keeps its qualified name — which is how it used to get past a check that
    // only looked at the start of the whole string.
    expect(
      expectRejected(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:evil="urn:evil" viewBox="0 0 10 10" evil:onclick="fetch(1)"></svg>',
      ).reason,
    ).toBe('event_handler');
  });

  it('refuses an on* handler in the xlink namespace', () => {
    expect(
      expectRejected(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" xlink:onload="fetch(1)"></svg>',
      ).reason,
    ).toBe('event_handler');
  });

  it('refuses an <image> that fetches, and any off-document href', () => {
    expect(
      expectRejected(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="https://example.com/a.png"/></svg>',
      ).reason,
    ).toBe('disallowed_element');

    expect(
      expectRejected(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">' +
          '<path d="M0 0" xlink:href="https://example.com/x"/></svg>',
      ).reason,
    ).toBe('external_reference');
  });

  it('refuses a DOCTYPE, so no entity is ever expanded', () => {
    expect(
      expectRejected(
        '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0"/></svg>',
      ).reason,
    ).toBe('doctype');
  });

  it('refuses <foreignObject>', () => {
    expect(
      expectRejected(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><foreignObject><b>hi</b></foreignObject></svg>',
      ).reason,
    ).toBe('disallowed_element');
  });

  it('refuses url() in a style attribute, and an @import in one', () => {
    expect(
      expectRejected(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
          '<path d="M0 0" style="fill:url(https://example.com/g.svg#a)"/></svg>',
      ).reason,
    ).toBe('external_reference');

    expect(
      expectRejected(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
          '<path d="M0 0" style="@import &quot;evil.css&quot;"/></svg>',
      ).reason,
    ).toBe('disallowed_style');
  });

  it('refuses a <?xml-stylesheet?> instruction the generator also refuses by name', () => {
    expect(
      expectRejected(
        '<?xml version="1.0"?><?xml-stylesheet href="a.css"?>' +
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0"/></svg>',
      ).reason,
    ).toBe('processing_instruction');
  });

  it('refuses a file over the 2 MB ceiling before parsing it', () => {
    const padding = ' '.repeat(MAX_SVG_BYTES);
    expect(expectRejected(`<svg viewBox="0 0 10 10">${padding}</svg>`).reason).toBe('too_large');
  });

  it('refuses a drawing with no viewBox to scale against', () => {
    expect(expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>').reason).toBe(
      'missing_view_box',
    );

    expect(
      expectRejected('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 100"><path d="M0 0"/></svg>').reason,
    ).toBe('missing_view_box');
  });

  it('refuses a root element that is not <svg>', () => {
    expect(expectRejected('<html><body>no</body></html>').reason).toBe('not_svg');
  });

  it('refuses malformed XML rather than auditing whatever parsed', () => {
    expect(expectRejected('<svg viewBox="0 0 1 1"><path d="M0 0"></svg>').reason).toBe('not_xml');
  });

  it('accepts a clean drawing and returns its viewBox', () => {
    const result = sanitiseSvg(CLEAN_SVG);
    if (!result.ok) throw new Error(`expected acceptance, got ${result.reason}`);
    expect(result.viewBox).toBe('0 0 100 100');
    expect(result.svg).toContain('<path d="M10 10 L90 90 Z"/>');
  });

  it('accepts an Inkscape export, with the metadata and namedview stripped out', () => {
    const result = sanitiseSvg(INKSCAPE_SVG);
    if (!result.ok) throw new Error(`expected acceptance, got ${result.reason}: ${result.message}`);

    expect(result.viewBox).toBe('0 0 210 297');
    // The RDF block names the author and the file's original path. Neither is
    // geometry, and neither goes into a bucket we hand to a generator.
    expect(result.svg).not.toContain('metadata');
    expect(result.svg).not.toContain("somebody's disk");
    expect(result.svg).not.toContain('namedview');
    expect(result.svg).not.toContain('Created with Inkscape');
    // What the buyer actually drew survives, in its own coordinate space.
    expect(result.svg).toContain('d="M 20,20 H 190 V 277 H 20 Z"');
    expect(result.svg).toContain('<title>Crux</title>');
  });
});

describe('looksLikeSvg', () => {
  it('recognises a plain root, a declaration and a BOM', () => {
    expect(looksLikeSvg(Buffer.from(CLEAN_SVG, 'utf8'))).toBe(true);
    expect(looksLikeSvg(Buffer.from(INKSCAPE_SVG, 'utf8'))).toBe(true);
    expect(looksLikeSvg(Buffer.from(`﻿${CLEAN_SVG}`, 'utf8'))).toBe(true);
  });

  it('routes a DOCTYPE file to the sanitiser, so the buyer is told what is wrong', () => {
    const withDoctype = `<!DOCTYPE svg><svg viewBox="0 0 1 1"></svg>`;
    expect(looksLikeSvg(Buffer.from(withDoctype, 'utf8'))).toBe(true);
    expect(expectRejected(withDoctype).reason).toBe('doctype');
  });

  it('routes a DOCTYPE with an internal subset too, entity declarations and all', () => {
    // The classic billion-laughs shape. Each `<!ENTITY>` carries its own `>`,
    // so a preamble strip that stopped at the first one left `"bar">]>` in
    // front of the root and answered "unsupported type" — hiding the one thing
    // the buyer needed to be told.
    const withSubset = `<!DOCTYPE svg [<!ENTITY foo "bar">]><svg viewBox="0 0 1 1"></svg>`;
    expect(looksLikeSvg(Buffer.from(withSubset, 'utf8'))).toBe(true);
    expect(expectRejected(withSubset).reason).toBe('doctype');
  });

  it('says no to bytes that are not a drawing', () => {
    expect(looksLikeSvg(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(looksLikeSvg(Buffer.from('<html><svg/></html>', 'utf8'))).toBe(false);
  });
});
