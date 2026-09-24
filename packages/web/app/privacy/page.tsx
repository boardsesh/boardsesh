import Link from '@mui/material/Link';
import { buildAppHandoffUrl } from '@/app/lib/app-handoff';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { PageShell, PageSection, Prose } from '@/app/components/ui/page-shell';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.privacy.title'),
    description: t('metadata.privacy.description'),
    path: '/privacy',
    locale,
  });
}

export default async function PrivacyPolicyPage() {
  const { t } = await getServerTranslation('marketing');
  return (
    <PageShell title={t('privacy.title')} lead={t('privacy.lastUpdatedProductAnalytics')}>
      <PageSection>
        <Prose>{t('privacy.intro1')}</Prose>
        <Prose>{t('privacy.intro2ProductAnalytics')}</Prose>
      </PageSection>

      <PageSection title={t('privacy.collect.title')}>
        <Prose>
          <strong>{t('privacy.collect.accountLabel')}</strong> {t('privacy.collect.accountBody')}
        </Prose>
        <Prose>
          <strong>{t('privacy.collect.activityLabel')}</strong> {t('privacy.collect.activityBody')}
        </Prose>
        <Prose>
          <strong>{t('privacy.collect.locationLabel')}</strong> {t('privacy.collect.locationBody')}
        </Prose>
        <Prose>
          <strong>{t('privacy.collect.productAnalyticsLabel')}</strong> {t('privacy.collect.productAnalyticsBody')}
        </Prose>
      </PageSection>

      <PageSection title={t('privacy.bluetooth.title')}>
        <Prose>{t('privacy.bluetooth.body')}</Prose>
      </PageSection>

      <PageSection title={t('privacy.location.title')}>
        <Prose>{t('privacy.location.body1')}</Prose>
        <Prose>{t('privacy.location.body2')}</Prose>
      </PageSection>

      <PageSection title={t('privacy.thirdParty.title')}>
        <Prose>
          <strong>{t('privacy.thirdParty.vercelLabel')}</strong> {t('privacy.thirdParty.vercelBody')}
          <Link href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener">
            {t('privacy.thirdParty.vercelLink')}
          </Link>
          .
        </Prose>
        <Prose>
          <strong>{t('privacy.thirdParty.posthogLabel')}</strong> {t('privacy.thirdParty.posthogBody')}
          <Link href="https://posthog.com/privacy" target="_blank" rel="noopener">
            {t('privacy.thirdParty.posthogLink')}
          </Link>
          .
        </Prose>
        <Prose>
          <strong>{t('privacy.thirdParty.auroraLabel')}</strong> {t('privacy.thirdParty.auroraBody')}
          <Link href="https://auroraclimbing.com" target="_blank" rel="noopener">
            {t('privacy.thirdParty.auroraLink')}
          </Link>
          {t('privacy.thirdParty.auroraBodyEnd')}
        </Prose>
        <Prose>
          <strong>{t('privacy.thirdParty.stripeLabel')}</strong> {t('privacy.thirdParty.stripeBody')}
          <Link href="https://stripe.com/privacy" target="_blank" rel="noopener">
            {t('privacy.thirdParty.stripeLink')}
          </Link>
          .
        </Prose>
      </PageSection>

      <PageSection title={t('privacy.sharing.title')}>
        <Prose>{t('privacy.sharing.body1ProductAnalytics')}</Prose>
        <Prose>{t('privacy.sharing.body2')}</Prose>
        <Prose>{t('privacy.sharing.stripe')}</Prose>
      </PageSection>

      <PageSection title={t('privacy.retention.title')}>
        <Prose>{t('privacy.retention.body')}</Prose>
        <Prose>{t('privacy.retention.stripe')}</Prose>
      </PageSection>

      <PageSection title={t('privacy.deletion.title')}>
        <Prose>{t('privacy.deletion.intro')}</Prose>
        <Prose>
          <strong>{t('privacy.deletion.inApp')}</strong>
          {t('privacy.deletion.inAppBody')}
        </Prose>
        <Prose>
          <strong>{t('privacy.deletion.onWeb')}</strong>
          {t('privacy.deletion.onWebBody')}
          {/* W-21 (#4440) moved account deletion off www's /settings and into the
              app's More screen, so the policy's stated web route points at the
              app origin now. Legally load-bearing copy — keep it matching the
              button that actually exists. */}
          <Link href={buildAppHandoffUrl('/profile/more')} target="_blank" rel="noopener">
            {t('privacy.deletion.onWebLink')}
          </Link>
          {t('privacy.deletion.onWebBodyEnd')}
        </Prose>
        <Prose>{t('privacy.deletion.permanent')}</Prose>
        <Prose>{t('privacy.deletion.stripe')}</Prose>
      </PageSection>

      <PageSection title={t('privacy.children.title')}>
        <Prose>{t('privacy.children.body')}</Prose>
      </PageSection>

      <PageSection title={t('privacy.changes.title')}>
        <Prose>{t('privacy.changes.body')}</Prose>
      </PageSection>

      <PageSection title={t('privacy.contact.title')}>
        <Prose>
          {t('privacy.contact.body1Start')}
          <Link href="mailto:support@boardsesh.com">{t('privacy.contact.body1Email')}</Link>
          {t('privacy.contact.body1End')}
        </Prose>
        <Prose>
          {t('privacy.contact.body2Start')}
          <Link href="https://github.com/boardsesh/boardsesh" target="_blank" rel="noopener">
            {t('privacy.contact.body2Link')}
          </Link>
          {t('privacy.contact.body2End')}
        </Prose>
      </PageSection>
    </PageShell>
  );
}
