import React from 'react';
import { describe, expect, it } from 'vite-plus/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { fillNodeSlot, nodeSlot } from '../node-slot';

const LINK = <a href="/setter/someone">someone</a>;

function fill(translated: string): string {
  return renderToStaticMarkup(<>{fillNodeSlot(translated, 'setter', LINK)}</>);
}

describe('fillNodeSlot', () => {
  it('puts the node where the translation put the placeholder', () => {
    expect(fill(`set by ${nodeSlot('setter')}`)).toBe('set by <a href="/setter/someone">someone</a>');
    expect(fill(`由 ${nodeSlot('setter')} 设定`)).toBe('由 <a href="/setter/someone">someone</a> 设定');
  });

  it('fills every occurrence when a translation names the placeholder twice', () => {
    expect(fill(`${nodeSlot('setter')} set it; ask ${nodeSlot('setter')}.`)).toBe(
      '<a href="/setter/someone">someone</a> set it; ask <a href="/setter/someone">someone</a>.',
    );
  });

  it('keeps the node, after the text, when a translation dropped the placeholder', () => {
    expect(fill('set by')).toBe('set by <a href="/setter/someone">someone</a>');
  });

  it("leaves another slot's marker alone", () => {
    expect(fill(`${nodeSlot('count')} start`)).toBe(`${nodeSlot('count')} start <a href="/setter/someone">someone</a>`);
  });
});
