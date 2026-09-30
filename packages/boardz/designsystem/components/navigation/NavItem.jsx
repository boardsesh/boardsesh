import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function NavItem({ icon, label, active, count, collapsed, onClick, style }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button type="button" onClick={onClick} title={collapsed ? label : undefined} aria-current={active ? 'page' : undefined}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', flexDirection: collapsed ? 'column' : 'row', alignItems: 'center', gap: collapsed ? 5 : 12, width: '100%',
        height: collapsed ? 58 : 40, padding: collapsed ? 0 : '0 12px', justifyContent: collapsed ? 'center' : 'flex-start', border: 0, borderRadius: 'var(--radius-md)', cursor: 'pointer',
        background: active ? 'var(--bg-surface-3)' : hover ? 'var(--bg-surface-2)' : 'transparent', color: active ? 'var(--fg-1)' : 'var(--fg-3)',
        fontFamily: 'var(--font-sans)', fontSize: collapsed ? 10 : 14, fontWeight: active ? 600 : 500, textAlign: 'left', transition: 'background var(--dur-fast)', ...style }}>
      <Icon name={icon} size={20} />
      <span style={{ flex: collapsed ? undefined : 1 }}>{label}</span>
      {count != null && !collapsed ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>{count}</span> : null}
    </button>
  );
}
