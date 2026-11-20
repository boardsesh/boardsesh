'use client';

import { Suspense, lazy, useState } from 'react';
import Box from '@mui/material/Box';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import CircularProgress from '@mui/material/CircularProgress';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import type { DeveloperDocsState } from '@/app/lib/developer-apps/docs-access';
import { PageShell, PageSection, Prose } from '@/app/components/ui/page-shell';
import { TabPanel } from '@/app/components/ui/tab-panel';
import styles from './docs.module.css';

const SwaggerUI = lazy(() => import('./swagger-ui'));
const GraphQLSchemaViewer = lazy(() => import('./graphql-schema'));

function LoadingSpinner() {
  const { t } = useTranslation('marketing');
  return (
    <Box className={styles.loadingContainer} role="status">
      <CircularProgress size={40} />
      <Box className={styles.loadingText}>{t('docs.loading')}</Box>
    </Box>
  );
}

export default function DocsClientPage({
  developerDocsState = 'unavailable',
}: {
  developerDocsState?: DeveloperDocsState;
}) {
  const { t } = useTranslation('marketing');
  const [activeTab, setActiveTab] = useState('overview');

  return (
    <PageShell title={t('docs.headerTitle')} lead={t('docs.headerSubtitle')} width="wide">
      <Box className={styles.docsContainer}>
        <Tabs
          value={activeTab}
          onChange={(_, nextTab: string) => setActiveTab(nextTab)}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          aria-label={t('docs.headerTitle')}
        >
          <Tab label={t('docs.tabs.overview')} value="overview" />
          <Tab label={t('docs.tabs.rest')} value="rest" />
          <Tab label={t('docs.tabs.graphql')} value="graphql" />
        </Tabs>

        <TabPanel value={activeTab} index="overview">
          <PageSection title={t('docs.public.title')}>
            <Prose>{t('docs.public.body')}</Prose>
          </PageSection>
          <PageSection title={t('docs.partners.title')}>
            <Prose>{t('docs.partners.body')}</Prose>
            <Prose>
              {developerDocsState === 'unavailable' ? (
                <MuiLink href="mailto:support@boardsesh.com">{t('docs.partners.contact')}</MuiLink>
              ) : (
                <MuiLink component={LocaleLink} href="/developers">
                  {t('docs.partners.link')}
                </MuiLink>
              )}
            </Prose>
          </PageSection>
          <PageSection title={t('docs.internal.title')}>
            <Prose>{t('docs.internal.body')}</Prose>
            <Prose>
              <MuiLink
                href="https://github.com/boardsesh/boardsesh/blob/main/docs/backend/websocket-implementation.md"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('docs.internal.link')}
              </MuiLink>
            </Prose>
            <Prose>
              <MuiLink component={LocaleLink} href="/legal">
                {t('docs.policyLink')}
              </MuiLink>
            </Prose>
          </PageSection>
        </TabPanel>

        <TabPanel value={activeTab} index="rest">
          <Suspense fallback={<LoadingSpinner />}>
            <SwaggerUI />
          </Suspense>
        </TabPanel>

        <TabPanel value={activeTab} index="graphql">
          <PageSection title={t('docs.internal.title')}>
            <Prose>{t('docs.internal.body')}</Prose>
          </PageSection>
          <Suspense fallback={<LoadingSpinner />}>
            <GraphQLSchemaViewer />
          </Suspense>
        </TabPanel>
      </Box>
    </PageShell>
  );
}
