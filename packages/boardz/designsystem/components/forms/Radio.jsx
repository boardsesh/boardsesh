import React from 'react';

export function Radio({ checked, onChange, label, name, value, disabled, style }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1, minHeight: 24, ...style }}>
      <input type="radio" name={name} value={value} checked={!!checked} disabled={disabled} onChange={() => onChange && onChange(value)} style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
      <span style={{ width: 20, height: 20, borderRadius: 10, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0 0 0 1.5px ' + (checked ? 'var(--fg-1)' : 'var(--border-strong)') }}>
        {checked ? <span style={{ width: 10, height: 10, borderRadius: 5, background: 'var(--fg-1)' }} /> : null}
      </span>
      {label ? <span style={{ fontSize: 15, color: 'var(--fg-1)' }}>{label}</span> : null}
    </label>
  );
}
