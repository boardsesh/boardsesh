import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import NativeStartClient from './native-start-client';

export const metadata = createNoIndexMetadata({
  title: 'Sign In',
  description: 'Redirecting to sign-in provider',
  path: '/auth/native-start',
});

export default function NativeStartPage() {
  return <NativeStartClient />;
}
