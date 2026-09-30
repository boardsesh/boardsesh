import React from 'react';
import { Icon } from './Icon.jsx';

const CHIP_H = { sm: 32, md: 36, lg: 44 };

export function Chip({ label, selected, icon, count, onClick, onRemove, size = 'md', style }) {
  const [hover, setHover] = React.useState(false);
  const h = CHIP_H[size] || CHIP_H.md;
  return (
    <button type="button" onClick={onClick} aria-pressed={!!selected}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, height: h, padding: onRemove ? '0 6px 0 12px' : '0 12px',
        borderRadius: 'var(--radius-tag)', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0, border: 0,
        fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500,
        background: selected ? 'var(--accent)' : hover ? 'var(--bg-surface-3)' : 'transparent',
        color: selected ? 'var(--fg-on-accent)' : 'var(--fg-2)',
        boxShadow: selected ? 'none' : 'inset 0 0 0 1px var(--border-2)',
        transition: 'background var(--dur-fast) var(--ease-out)', ...style,
      }}>
      {icon ? <Icon name={icon} size={15} /> : null}
      <span>{label}</span>
      {count != null ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, opacity: 0.65 }}>{count}</span> : null}
      {onRemove ? (
        <span role="button" aria-label={'Remove ' + label} onClick={e => { e.stopPropagation(); onRemove(); }}
          style={{ display: 'inline-flex', width: 22, height: 22, alignItems: 'center', justifyContent: 'center', borderRadius: 6, opacity: 0.8 }}>
          <Icon name="x" size={14} />
        </span>
      ) : null}
    </button>
  );
}
