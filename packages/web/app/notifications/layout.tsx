import React from 'react';

export default function NotificationsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div style={{ minHeight: '100dvh', paddingTop: 'var(--global-header-height)', paddingBottom: 'calc(120px + env(safe-area-inset-bottom, 0px))' }}>
      {children}
    </div>
  );
}
