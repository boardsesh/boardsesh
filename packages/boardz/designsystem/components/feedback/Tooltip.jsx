import React from 'react';

export function Tooltip({ label, children, side = 'top', forceOpen, style }) {
  const [open, setOpen] = React.useState(false);
  const show = forceOpen || open;
  return (
    <span style={{ position: 'relative', display: 'inline-flex', ...style }} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
      {children}
      {show ? (
        <span role="tooltip" style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', [side === 'top' ? 'bottom' : 'top']: 'calc(100% + 6px)',
          padding: '6px 8px', background: 'var(--bg-inverse)', color: 'var(--fg-inverse)', fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', lineHeight: 1, borderRadius: 'var(--radius-sm)', whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 20, animation: 'bz-fade-in var(--dur-fast)' }}>
          {label}
        </span>
      ) : null}
    </span>
  );
}
