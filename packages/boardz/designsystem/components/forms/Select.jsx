import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function Select({ label, value, onChange, options = [], size = 'md', style }) {
  const h = size === 'lg' ? 48 : size === 'sm' ? 36 : 44;
  const opts = options.map(o => typeof o === 'string' ? { value: o, label: o } : o);
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 8, ...style }}>
      {label ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', color: 'var(--fg-3)' }}>{label}</span> : null}
      <span style={{ position: 'relative', display: 'flex' }}>
        <select value={value} onChange={e => onChange && onChange(e.target.value)}
          style={{ appearance: 'none', WebkitAppearance: 'none', width: '100%', height: h, padding: '0 36px 0 14px', fontSize: size === 'sm' ? 14 : 15, color: 'var(--fg-1)', background: 'var(--bg-surface)', border: 0, boxShadow: 'inset 0 0 0 1px var(--border-2)', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>
          {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <Icon name="chevron-down" size={16} color="var(--fg-3)" style={{ position: 'absolute', right: 12, top: '50%', marginTop: -8, pointerEvents: 'none' }} />
      </span>
    </label>
  );
}
