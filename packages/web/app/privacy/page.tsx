import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Container from '@mui/material/Container';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import LocaleLink from '@/app/components/i18n/locale-link';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.privacy.title'),
    description: t('metadata.privacy.description'),
    path: '/privacy',
    locale,
  });
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mb: 4 }}>
      <Typography variant="h5" component="h2" sx={{ mb: 1.5, fontWeight: 600 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

function Paragraph({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="body1" sx={{ mb: 1.5, lineHeight: 1.7 }}>
      {children}
    </Typography>
  );
}

export default async function PrivacyPolicyPage() {
  const { t } = await getServerTranslation('marketing');
  return (
    <Container maxWidth="md" sx={{ py: 6 }}>
      <Typography variant="h3" component="h1" sx={{ mb: 1, fontWeight: 700 }}>
        {t('privacy.title')}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 4 }}>
        {t('privacy.lastUpdatedProductAnalytics')}
      </Typography>
      <Divider sx={{ mb: 4 }} />

      <Paragraph>{t('privacy.intro1')}</Paragraph>
      <Paragraph>{t('privacy.intro2ProductAnalytics')}</Paragraph>

      <Section title={t('privacy.consent.title')}>
        <Paragraph>{t('privacy.consent.body1')}</Paragraph>
        <Paragraph>
          {t('privacy.consent.body2Start')}
          <Link component={LocaleLink} href="/settings">
            {t('privacy.consent.settingsLink')}
          </Link>
          {t('privacy.consent.body2End')}
        </Paragraph>
      </Section>

      <Section title={t('privacy.collect.title')}>
        <Paragraph>
          <strong>{t('privacy.collect.accountLabel')}</strong> {t('privacy.collect.accountBody')}
        </Paragraph>
        <Paragraph>
          <strong>{t('privacy.collect.activityLabel')}</strong> {t('privacy.collect.activityBody')}
        </Paragraph>
        <Paragraph>
          <strong>{t('privacy.collect.locationLabel')}</strong> {t('privacy.collect.locationBody')}
        </Paragraph>
        <Paragraph>
          <strong>{t('privacy.collect.productAnalyticsLabel')}</strong> {t('privacy.collect.productAnalyticsBody')}
        </Paragraph>
      </Section>

      <Section title={t('privacy.errorMonitoring.title')}>
        <Paragraph>{t('privacy.errorMonitoring.body')}</Paragraph>
      </Section>

      <Section title={t('privacy.bluetooth.title')}>
        <Paragraph>{t('privacy.bluetooth.body')}</Paragraph>
      </Section>

      <Section title={t('privacy.location.title')}>
        <Paragraph>{t('privacy.location.body1')}</Paragraph>
        <Paragraph>{t('privacy.location.body2')}</Paragraph>
      </Section>

      <Section title={t('privacy.thirdParty.title')}>
        <Paragraph>
          <strong>{t('privacy.thirdParty.vercelLabel')}</strong> {t('privacy.thirdParty.vercelBody')}
          <Link href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener">
            {t('privacy.thirdParty.vercelLink')}
          </Link>
          .
        </Paragraph>
        <Paragraph>
          <strong>{t('privacy.thirdParty.posthogLabel')}</strong> {t('privacy.thirdParty.posthogBody')}
          <Link href="https://posthog.com/privacy" target="_blank" rel="noopener">
            {t('privacy.thirdParty.posthogLink')}
          </Link>
          .
        </Paragraph>
        <Paragraph>
          <strong>{t('privacy.thirdParty.sentryLabel')}</strong> {t('privacy.thirdParty.sentryBody')}
          <Link href="https://sentry.io/privacy/" target="_blank" rel="noopener">
            {t('privacy.thirdParty.sentryLink')}
          </Link>
          .
        </Paragraph>
        <Paragraph>
          <strong>{t('privacy.thirdParty.auroraLabel')}</strong> {t('privacy.thirdParty.auroraBody')}
          <Link href="https://auroraclimbing.com" target="_blank" rel="noopener">
            {t('privacy.thirdParty.auroraLink')}
          </Link>
          {t('privacy.thirdParty.auroraBodyEnd')}
        </Paragraph>
      </Section>

      <Section title={t('privacy.sharing.title')}>
        <Paragraph>{t('privacy.sharing.body1ProductAnalytics')}</Paragraph>
        <Paragraph>{t('privacy.sharing.body2')}</Paragraph>
      </Section>

      <Section title={t('privacy.retention.title')}>
        <Paragraph>{t('privacy.retention.body')}</Paragraph>
      </Section>

      <Section title={t('privacy.deletion.title')}>
        <Paragraph>{t('privacy.deletion.intro')}</Paragraph>
        <Paragraph>
          <strong>{t('privacy.deletion.inApp')}</strong>
          {t('privacy.deletion.inAppBody')}
        </Paragraph>
        <Paragraph>
          <strong>{t('privacy.deletion.onWeb')}</strong>
          {t('privacy.deletion.onWebBody')}
          <Link href="https://boardsesh.com/settings" target="_blank" rel="noopener">
            {t('privacy.deletion.onWebLink')}
          </Link>
          {t('privacy.deletion.onWebBodyEnd')}
        </Paragraph>
        <Paragraph>{t('privacy.deletion.permanent')}</Paragraph>
      </Section>

      <Section title={t('privacy.children.title')}>
        <Paragraph>{t('privacy.children.body')}</Paragraph>
      </Section>

      <Section title={t('privacy.changes.title')}>
        <Paragraph>{t('privacy.changes.body')}</Paragraph>
      </Section>

      <Section title={t('privacy.contact.title')}>
        <Paragraph>
          {t('privacy.contact.body1Start')}
          <Link href="mailto:support@boardsesh.com">{t('privacy.contact.body1Email')}</Link>
          {t('privacy.contact.body1End')}
        </Paragraph>
        <Paragraph>
          {t('privacy.contact.body2Start')}
          <Link href="https://github.com/boardsesh/boardsesh" target="_blank" rel="noopener">
            {t('privacy.contact.body2Link')}
          </Link>
          {t('privacy.contact.body2End')}
        </Paragraph>
      </Section>
    </Container>
  );
}
