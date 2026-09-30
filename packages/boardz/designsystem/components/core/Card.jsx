import React from 'react';

export function Card({ children, padding = 16, interactive, selected, flat, onClick, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        background: flat ? 'transparent' : 'var(--bg-surface)', borderRadius: 'var(--radius-lg)', padding,
        boxShadow: 'inset 0 0 0 ' + (selected ? '1.5px var(--fg-1)' : '1px ' + (hover && interactive ? 'var(--border-strong)' : 'var(--border-1)')),
        cursor: interactive ? 'pointer' : 'default', transition: 'box-shadow var(--dur-fast) var(--ease-out)', ...style,
      }} {...rest}>
      {children}
    </div>
  );
}
