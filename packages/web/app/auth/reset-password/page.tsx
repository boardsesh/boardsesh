import { Suspense } from 'react';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import ResetPasswordContent from './reset-password-content';

export const metadata = createNoIndexMetadata({
  title: 'Create New Password',
  description: 'Set a new password for your Boardsesh account',
  path: '/auth/reset-password',
});

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordContent />
    </Suspense>
  );
}
