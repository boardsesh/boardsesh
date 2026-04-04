import React, { Suspense } from 'react';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import AuthErrorContent from './auth-error-content';

export const metadata = createNoIndexMetadata({
  title: 'Authentication Error',
  description: 'An error occurred during authentication',
  path: '/auth/error',
});

export default function AuthErrorPage() {
  return (
    <Suspense fallback={null}>
      <AuthErrorContent />
    </Suspense>
  );
}
