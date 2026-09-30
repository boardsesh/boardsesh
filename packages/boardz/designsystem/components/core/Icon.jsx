import React from 'react';

// Renders a Lucide icon by kebab-case name. Requires the Lucide UMD script on the page:
// <script src="https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js"></script>
export function Icon({ name, size = 20, strokeWidth = 1.75, color = 'currentColor', fill = 'none', style, ...rest }) {
  const lib = typeof window !== 'undefined' && window.lucide && window.lucide.icons;
  const key = (name || '').split('-').map(s => s ? s[0].toUpperCase() + s.slice(1) : '').join('');
  let node = lib ? lib[key] : null;
  if (node && node[0] === 'svg') node = node[2];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={color} strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ flexShrink: 0, display: 'block', ...style }} {...rest}>
      {Array.isArray(node) ? node.map((n, i) => React.createElement(n[0], { ...n[1], key: i })) : null}
    </svg>
  );
}
