import React from 'react';

/**
 * A stand-in to pass as an interpolation value where a translated sentence
 * needs a React node (a link, a bold count) rather than text.
 *
 * Server components get a bare `t` from `getServerTranslation`, and `<Trans>`
 * reads its i18next instance from React context, which they cannot use. So the
 * sentence is translated with this marker in the node's place and
 * `fillNodeSlot` splits it back out. Word order stays the translator's: "set by
 * {{setter}}" and "由 {{setter}} 设定" both put the link where the catalog says.
 */
export function nodeSlot(name: string): string {
  return `\u0000${name}\u0000`;
}

/**
 * Put `node` where `nodeSlot(name)` landed in `translated`.
 *
 * A translation that dropped the placeholder still gets the node, after the
 * text, so a catalog slip can't silently delete a link. The catalog parity test
 * in `@boardsesh/i18n` fails such a translation first anyway.
 */
export function fillNodeSlot(translated: string, name: string, node: React.ReactNode): React.ReactNode {
  const slot = nodeSlot(name);
  const slotIndex = translated.indexOf(slot);
  if (slotIndex === -1) {
    return (
      <>
        {translated} {node}
      </>
    );
  }
  return (
    <>
      {translated.slice(0, slotIndex)}
      {node}
      {translated.slice(slotIndex + slot.length)}
    </>
  );
}
