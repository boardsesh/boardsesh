import React, { Suspense } from 'react';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import VerifyRequestContent from './verify-request-content';

export const metadata = createNoIndexMetadata({
  title: 'Verify Email',
  description: 'Verify your email address',
  path: '/auth/verify-request',
});

export default function VerifyRequestPage() {
  return (
    <Suspense fallback={null}>
      <VerifyRequestContent />
    </Suspense>
  );
}
