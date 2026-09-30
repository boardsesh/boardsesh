import React from 'react';
import { Icon } from '../core/Icon.jsx';

// Bottom sheet on phones, centered dialog on tablet/desktop, or right side panel.
export function Sheet({ open, onClose, title, children, footer, variant = 'bottom', contained, width = 440, style }) {
  if (!open) return null;
  const pos = contained ? 'absolute' : 'fixed';
  const panel = variant === 'bottom'
    ? { left: 0, right: 0, bottom: 0, maxHeight: '88%', borderRadius: 'var(--radius-xl) var(--radius-xl) 0 0', animation: 'bz-sheet-up var(--dur-slow) var(--ease-out)' }
    : variant === 'side'
    ? { top: 0, right: 0, bottom: 0, width, maxWidth: '100%', borderRadius: 0, boxShadow: 'inset 1px 0 0 var(--border-2), var(--shadow-3)', animation: 'bz-fade-in var(--dur-base)' }
    : { left: '50%', top: '50%', width, maxWidth: 'calc(100% - 32px)', maxHeight: 'calc(100% - 64px)', transform: 'translate(-50%, -50%)', borderRadius: 'var(--radius-xl)' };
  return (
    <div style={{ position: pos, inset: 0, zIndex: 50 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'var(--overlay)', animation: 'bz-fade-in var(--dur-base)' }} />
      <div role="dialog" aria-modal="true" style={{ position: 'absolute', display: 'flex', flexDirection: 'column', background: 'var(--bg-app)', boxShadow: 'var(--shadow-3)', overflow: 'hidden', ...panel, ...style }}>
        {variant === 'bottom' ? <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border-strong)', margin: '8px auto 0', flexShrink: 0 }} /> : null}
        {title ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: variant === 'bottom' ? '10px 12px 10px 20px' : '16px 12px 10px 24px', flexShrink: 0 }}>
            <div style={{ flex: 1, fontSize: 20, fontWeight: 600, letterSpacing: '-0.03em' }}>{title}</div>
            <button type="button" aria-label="Close" onClick={onClose} style={{ width: 40, height: 40, border: 0, borderRadius: 'var(--radius-md)', background: 'transparent', color: 'var(--fg-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><Icon name="x" size={20} /></button>
          </div>
        ) : null}
        <div style={{ flex: 1, overflowY: 'auto', padding: variant === 'bottom' ? '6px 20px 16px' : '6px 24px 20px' }}>{children}</div>
        {footer ? <div style={{ padding: variant === 'bottom' ? '12px 16px 20px' : '14px 24px 20px', borderTop: '1px solid var(--border-2)', display: 'flex', gap: 8, flexShrink: 0 }}>{footer}</div> : null}
      </div>
    </div>
  );
}
