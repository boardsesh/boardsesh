import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function Checkbox({ checked, onChange, label, description, disabled, style }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1, minHeight: 24, ...style }}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={e => onChange && onChange(e.target.checked)} style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
      <span style={{
        width: 20, height: 20, marginTop: 1, borderRadius: 5, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: checked ? 'var(--accent)' : 'transparent', boxShadow: checked ? 'none' : 'inset 0 0 0 1.5px var(--border-strong)',
        color: 'var(--fg-on-accent)', transition: 'background var(--dur-fast)',
      }}>{checked ? <Icon name="check" size={14} strokeWidth={2.75} /> : null}</span>
      {label || description ? (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {label ? <span style={{ fontSize: 15, color: 'var(--fg-1)', lineHeight: '22px' }}>{label}</span> : null}
          {description ? <span style={{ fontSize: 13, color: 'var(--fg-3)' }}>{description}</span> : null}
        </span>
      ) : null}
    </label>
  );
}
