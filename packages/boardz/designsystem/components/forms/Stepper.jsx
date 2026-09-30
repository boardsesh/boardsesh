import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function Stepper({ value = 0, onChange, min = 0, max = 99, label, size = 'md', style }) {
  const d = size === 'lg' ? 48 : 44;
  const btn = (dir, dis) => (
    <button type="button" aria-label={dir > 0 ? 'Increase' : 'Decrease'} disabled={dis} onClick={() => onChange && onChange(Math.min(max, Math.max(min, value + dir)))}
      style={{ width: d, height: d, borderRadius: 'var(--radius-md)', border: 0, boxShadow: 'inset 0 0 0 1px var(--border-2)', background: 'transparent', color: 'var(--fg-1)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: dis ? 'not-allowed' : 'pointer', opacity: dis ? 0.35 : 1, padding: 0 }}>
      <Icon name={dir > 0 ? 'plus' : 'minus'} size={18} />
    </button>
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, ...style }}>
      {label ? <span style={{ fontSize: 15, color: 'var(--fg-1)' }}>{label}</span> : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {btn(-1, value <= min)}
        <span style={{ minWidth: 52, textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: size === 'lg' ? 26 : 22, fontWeight: 300, letterSpacing: '-0.04em', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        {btn(1, value >= max)}
      </div>
    </div>
  );
}
