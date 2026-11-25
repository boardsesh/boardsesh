import type React from 'react';
import MarketingDocument from '@/app/components/marketing/marketing-document';
import { DEFAULT_LOCALE } from '@/app/lib/i18n/config';
import { getMarketingDocumentMetadata, marketingDocumentViewport } from '@/app/lib/seo/marketing-document-metadata';

export const viewport = marketingDocumentViewport;
export const dynamic = 'error';
export function generateMetadata() {
  return getMarketingDocumentMetadata(DEFAULT_LOCALE);
}
export default function MarketingRootLayout({ children }: { children: React.ReactNode }) {
  return <MarketingDocument locale={DEFAULT_LOCALE}>{children}</MarketingDocument>;
}
