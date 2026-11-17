import React from 'react';
import styles from './docs-code-block.module.css';

/**
 * A copyable request or response. Server-safe and never translated: the text is
 * what a developer pastes. Scrolls sideways on a phone instead of wrapping,
 * because a wrapped URL cannot be copied back out.
 */
export default function DocsCodeBlock({ label, children }: { label: string; children: string }) {
  return (
    <pre className={styles.block} aria-label={label} tabIndex={0}>
      <code>{children}</code>
    </pre>
  );
}
