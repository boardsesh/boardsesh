import React from 'react';

const TOAST_LED = { success: 'var(--led-green)', danger: 'var(--led-red)', info: 'var(--led-blue)', accent: 'var(--hold-hand)', warning: 'var(--led-amber)' };

export function Toast({ title, message, tone = 'success', actionLabel, onAction, onClose, style }) {
  const c = TOAST_LED[tone] || TOAST_LED.success;
  return (
    <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 12px 12px 16px', minWidth: 280, maxWidth: 420,
      background: 'var(--bg-inverse)', color: 'var(--fg-inverse)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-3)', animation: 'bz-toast-in var(--dur-base) var(--ease-out)', ...style }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: c, boxShadow: '0 0 10px 2px color-mix(in srgb, ' + c + ' 60%, transparent)' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</div>
        {message ? <div style={{ fontSize: 13, opacity: 0.68 }}>{message}</div> : null}
      </div>
      {actionLabel ? <button type="button" onClick={onAction} style={{ border: 0, background: 'transparent', color: 'inherit', fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', cursor: 'pointer', padding: '8px 6px' }}>{actionLabel}</button> : null}
      {onClose ? <button type="button" aria-label="Dismiss" onClick={onClose} style={{ border: 0, background: 'transparent', color: 'inherit', opacity: 0.55, cursor: 'pointer', padding: 6, display: 'flex', fontSize: 0 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button> : null}
    </div>
  );
}
