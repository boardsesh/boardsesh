import React from 'react';

export function Switch({ checked, onChange, label, description, disabled, style }) {
  const track = (
    <button type="button" role="switch" aria-checked={!!checked} aria-label={typeof label === 'string' ? label : undefined} disabled={disabled} onClick={() => onChange && onChange(!checked)}
      style={{ width: 44, height: 26, borderRadius: 13, border: 0, padding: 3, flexShrink: 0, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1,
        background: checked ? 'var(--accent)' : 'var(--border-2)', transition: 'background var(--dur-base) var(--ease-out)', display: 'flex' }}>
      <span style={{ width: 20, height: 20, borderRadius: 10, background: checked ? 'var(--fg-on-accent)' : 'var(--switch-thumb)', boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
        transform: checked ? 'translateX(18px)' : 'none', transition: 'transform var(--dur-base) var(--ease-out)' }} />
    </button>
  );
  if (!label) return track;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between', minHeight: 44, ...style }}>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 15, color: 'var(--fg-1)' }}>{label}</span>
        {description ? <span style={{ fontSize: 13, color: 'var(--fg-3)' }}>{description}</span> : null}
      </span>
      {track}
    </div>
  );
}
