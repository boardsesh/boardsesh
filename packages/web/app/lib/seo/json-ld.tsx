import React from 'react';

/**
 * The one inline JSON-LD `<script>`.
 *
 * `JSON.stringify` escapes quotes but leaves `<` alone, so a string ending in
 * `</script>` would close the block and turn user content into markup. Escaping
 * `<` closes that, and having exactly one implementation is the only reason to
 * extract this at all — two copies drift, and the copy that drifts is the one
 * rendering a setter username.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // JSON.stringify escapes quotes; guard the one XSS vector for inline JSON-LD.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}

export default JsonLd;
