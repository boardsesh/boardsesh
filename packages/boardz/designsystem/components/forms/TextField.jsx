import React from 'react';
import { Icon } from '../core/Icon.jsx';

const FIELD_LABEL = { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', color: 'var(--fg-3)' };

export function TextField({ label, value, onChange, placeholder, icon, clearable, hint, error, size = 'md', type = 'text', multiline, rows = 3, style, inputStyle }) {
  const [focus, setFocus] = React.useState(false);
  const h = size === 'lg' ? 48 : size === 'sm' ? 36 : 44;
  const Tag = multiline ? 'textarea' : 'input';
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 8, ...style }}>
      {label ? <span style={FIELD_LABEL}>{label}</span> : null}
      <span style={{
        display: 'flex', alignItems: multiline ? 'flex-start' : 'center', gap: 10, minHeight: h, padding: multiline ? '11px 14px' : '0 14px',
        background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)',
        boxShadow: 'inset 0 0 0 1px ' + (error ? 'var(--danger)' : focus ? 'var(--fg-1)' : 'var(--border-2)'),
        transition: 'box-shadow var(--dur-fast)',
      }}>
        {icon ? <Icon name={icon} size={18} color="var(--fg-3)" /> : null}
        <Tag type={multiline ? undefined : type} rows={multiline ? rows : undefined} value={value} placeholder={placeholder}
          onChange={e => onChange && onChange(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          style={{ flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent', fontSize: 15, color: 'var(--fg-1)', resize: 'vertical', padding: 0, ...inputStyle }} />
        {clearable && value ? (
          <button type="button" aria-label="Clear" onClick={() => onChange && onChange('')}
            style={{ border: 0, background: 'var(--bg-surface-3)', width: 22, height: 22, borderRadius: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--fg-2)', padding: 0 }}>
            <Icon name="x" size={12} strokeWidth={2.25} />
          </button>
        ) : null}
      </span>
      {error || hint ? <span style={{ fontSize: 12, color: error ? 'var(--danger)' : 'var(--fg-3)' }}>{error || hint}</span> : null}
    </label>
  );
}
