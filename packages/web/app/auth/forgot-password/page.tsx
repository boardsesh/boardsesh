import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import ForgotPasswordContent from './forgot-password-content';

export const metadata = createNoIndexMetadata({
  title: 'Forgot Password',
  description: 'Request a password reset link for your Boardsesh account',
  path: '/auth/forgot-password',
});

export default function ForgotPasswordPage() {
  return <ForgotPasswordContent />;
}
