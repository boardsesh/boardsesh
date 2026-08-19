'use client';

/**
 * API Documentation Page
 *
 * Provides comprehensive documentation for both the REST API and WebSocket GraphQL API.
 *
 * Features:
 * - REST API: Interactive Swagger UI generated from Zod schemas
 * - GraphQL API: Schema viewer with search and syntax highlighting
 * - WebSocket connection guide
 */

import { Suspense, lazy, useState } from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import MuiAlert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import CircularProgress from '@mui/material/CircularProgress';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import MuiDivider from '@mui/material/Divider';
import { ApiOutlined, CloudOutlined, ElectricBoltOutlined, MenuBookOutlined } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import { TabPanel } from '@/app/components/ui/tab-panel';
import styles from './docs.module.css';

// Typography destructuring removed - using MUI Typography directly
import MuiLink from '@mui/material/Link';

// Lazy load heavy components
const SwaggerUI = lazy(() => import('./swagger-ui'));
const GraphQLSchemaViewer = lazy(() => import('./graphql-schema'));

function LoadingSpinner() {
  const { t } = useTranslation('marketing');
  return (
    <div className={styles.loadingContainer}>
      <CircularProgress size={40} />
      <div className={styles.loadingText}>{t('docs.loading')}</div>
    </div>
  );
}

function OverviewTab() {
  const { t } = useTranslation('marketing');
  return (
    <div className={styles.contentSection}>
      <Typography variant="h4" component="h2">
        {t('docs.overview.title')}
      </Typography>

      <Typography variant="body1" component="p" sx={{ mb: 2 }}>
        {t('docs.overview.intro')}
      </Typography>

      <Stack spacing={3} className={styles.fullWidth}>
        <MuiCard>
          <CardContent>
            <Typography variant="h6" component="h4">
              <ApiOutlined /> {t('docs.overview.rest.title')}
            </Typography>
            <Typography variant="body1" component="p" sx={{ mb: 1 }}>
              {t('docs.overview.rest.intro')}
            </Typography>
            <ul>
              <li>{t('docs.overview.rest.feature1')}</li>
              <li>{t('docs.overview.rest.feature2')}</li>
              <li>{t('docs.overview.rest.feature3')}</li>
              <li>{t('docs.overview.rest.feature4')}</li>
            </ul>
            <Typography variant="body2" component="span" color="text.secondary">
              {t('docs.overview.rest.baseUrlLabel')} <code>/api/v1/</code>
            </Typography>
          </CardContent>
        </MuiCard>

        <MuiCard>
          <CardContent>
            <Typography variant="h6" component="h4">
              <ElectricBoltOutlined /> {t('docs.overview.ws.title')}
            </Typography>
            <Typography variant="body1" component="p" sx={{ mb: 1 }}>
              {t('docs.overview.ws.intro')}
            </Typography>
            <ul>
              <li>{t('docs.overview.ws.feature1')}</li>
              <li>{t('docs.overview.ws.feature2')}</li>
              <li>{t('docs.overview.ws.feature3')}</li>
              <li>{t('docs.overview.ws.feature4')}</li>
            </ul>
            <Typography variant="body2" component="span" color="text.secondary">
              {t('docs.overview.ws.endpointLabel')} <code>wss://your-domain/api/graphql</code>{' '}
              {t('docs.overview.ws.endpointSuffix')}
            </Typography>
          </CardContent>
        </MuiCard>

        <MuiCard>
          <CardContent>
            <Typography variant="h6" component="h4">
              <CloudOutlined /> {t('docs.overview.auth.title')}
            </Typography>
            <Typography variant="body1" component="p" sx={{ mb: 1 }}>
              <strong>{t('docs.overview.auth.restLabel')}</strong> {t('docs.overview.auth.restBody')}{' '}
              <code>/api/auth/...</code> {t('docs.overview.auth.restBodyEnd')}
            </Typography>
            <Typography variant="body1" component="p" sx={{ mb: 1 }}>
              <strong>{t('docs.overview.auth.wsLabel')}</strong> {t('docs.overview.auth.wsBody')}{' '}
              <code>GET /api/internal/ws-auth</code> {t('docs.overview.auth.wsBodyEnd')}
            </Typography>
            <pre className={styles.codeBlockLight}>
              {`import { createClient } from 'graphql-ws';

const client = createClient({
  url: 'wss://boardsesh.com/api/graphql',
  connectionParams: {
    authToken: 'your-jwt-token',
  },
});`}
            </pre>
          </CardContent>
        </MuiCard>

        <MuiAlert severity="info">
          <AlertTitle>{t('docs.overview.rateLimit.title')}</AlertTitle>
          {t('docs.overview.rateLimit.body')}
        </MuiAlert>
      </Stack>
    </div>
  );
}

function WebSocketGuideTab() {
  const { t } = useTranslation('marketing');
  return (
    <div className={styles.contentSection}>
      <Typography variant="h4" component="h2">
        {t('docs.ws.title')}
      </Typography>

      <Typography variant="body1" component="p" sx={{ mb: 2 }}>
        {t('docs.ws.introStart')}{' '}
        <MuiLink href="https://github.com/enisdenjo/graphql-ws" target="_blank">
          {/* i18n-ignore-next-line -- technical reference, English only */}
          graphql-ws
        </MuiLink>{' '}
        {t('docs.ws.introEnd')}
      </Typography>

      <MuiDivider />

      <Typography variant="h6" component="h4">
        {t('docs.ws.connection.title')}
      </Typography>

      <pre className={styles.codeBlockDark}>
        {`import { createClient } from 'graphql-ws';

// 1. Get auth token (requires session cookie)
const tokenResponse = await fetch('/api/internal/ws-auth');
const { token } = await tokenResponse.json();

// 2. Create WebSocket client
const client = createClient({
  url: 'wss://boardsesh.com/api/graphql',
  connectionParams: {
    authToken: token,
  },
  // Optional: reconnection settings
  retryAttempts: 5,
  shouldRetry: () => true,
});

// 3. Subscribe to queue updates
const unsubscribe = client.subscribe(
  {
    query: \`
      subscription QueueUpdates($sessionId: ID!) {
        queueUpdates(sessionId: $sessionId) {
          ... on QueueItemAdded {
            sequence
            stateHash
            addedItem: item { uuid climb { name difficulty } }
          }
          ... on QueueItemRemoved {
            sequence
            stateHash
            uuid
          }
          ... on CurrentClimbChanged {
            sequence
            stateHash
            currentItem: item { climb { name } }
          }
        }
      }
    \`,
    variables: { sessionId: 'your-session-id' },
  },
  {
    next: (data) => console.log('Queue update:', data),
    error: (err) => console.error('Subscription error:', err),
    complete: () => console.log('Subscription complete'),
  }
);`}
      </pre>

      <MuiDivider />

      <Typography variant="h6" component="h4">
        {t('docs.ws.session.title')}
      </Typography>

      <Typography variant="body1" component="p" sx={{ mb: 2 }}>
        {t('docs.ws.session.body')}
      </Typography>

      <pre className={styles.codeBlockDark}>
        {`// Join or create a session
const result = await client.query({
  query: \`
    mutation JoinSession($sessionId: ID!, $boardPath: String!, $username: String) {
      joinSession(sessionId: $sessionId, boardPath: $boardPath, username: $username) {
        id
        isLeader
        queueState {
          sequence
          queue { uuid climb { name difficulty } }
          currentClimbQueueItem { climb { name } }
        }
      }
    }
  \`,
  variables: {
    sessionId: 'my-session',
    boardPath: 'kilter/1/1/1,2/40',
    username: 'ClimberJoe',
  },
});`}
      </pre>

      <MuiDivider />

      <Typography variant="h6" component="h4">
        {t('docs.ws.delta.title')}
      </Typography>

      <Typography variant="body1" component="p" sx={{ mb: 2 }}>
        {t('docs.ws.delta.body')}
      </Typography>

      <pre className={styles.codeBlockDark}>
        {`// Store the last known sequence number
let lastSequence = 0;

// On reconnect, request missed events
const { eventsReplay } = await client.query({
  query: \`
    query EventsReplay($sessionId: ID!, $sinceSequence: Int!) {
      eventsReplay(sessionId: $sessionId, sinceSequence: $sinceSequence) {
        currentSequence
        events {
          __typename
          ... on QueueItemAdded {
            sequence
            stateHash
            addedItem: item { uuid climb { name difficulty } }
          }
          ... on CurrentClimbChanged {
            sequence
            stateHash
            currentItem: item { uuid climb { name difficulty } }
          }
        }
      }
    }
  \`,
  variables: {
    sessionId: 'my-session',
    sinceSequence: lastSequence,
  },
});

// Apply missed events to local state
for (const event of eventsReplay.events) {
  applyEvent(event);
}
lastSequence = eventsReplay.currentSequence;`}
      </pre>

      <MuiAlert severity="warning" className={styles.alertWithMargin}>
        <AlertTitle>{t('docs.ws.connectionHandling.title')}</AlertTitle>
        {t('docs.ws.connectionHandling.body')}
      </MuiAlert>
    </div>
  );
}

export default function DocsClientPage() {
  const { t } = useTranslation('marketing');
  const [activeTab, setActiveTab] = useState('overview');

  return (
    <div className={styles.docsContainer}>
      <div className={styles.docsHeader}>
        <Typography variant="h3" component="h1">
          <MenuBookOutlined /> {t('docs.headerTitle')}
        </Typography>
        <Typography variant="body2" component="span" color="text.secondary">
          {t('docs.headerSubtitle')}
        </Typography>
      </div>

      <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)}>
        <Tab
          label={
            <span>
              <MenuBookOutlined /> {t('docs.tabs.overview')}
            </span>
          }
          value="overview"
        />
        <Tab
          label={
            <span>
              <ApiOutlined /> {t('docs.tabs.rest')}
            </span>
          }
          value="rest"
        />
        <Tab
          label={
            <span>
              <ElectricBoltOutlined /> {t('docs.tabs.graphql')}
            </span>
          }
          value="graphql"
        />
        <Tab
          label={
            <span>
              <CloudOutlined /> {t('docs.tabs.websocket')}
            </span>
          }
          value="websocket"
        />
      </Tabs>

      <TabPanel value={activeTab} index="overview">
        <OverviewTab />
      </TabPanel>

      <TabPanel value={activeTab} index="rest">
        <Suspense fallback={<LoadingSpinner />}>
          <SwaggerUI />
        </Suspense>
      </TabPanel>

      <TabPanel value={activeTab} index="graphql">
        <Suspense fallback={<LoadingSpinner />}>
          <GraphQLSchemaViewer />
        </Suspense>
      </TabPanel>

      <TabPanel value={activeTab} index="websocket">
        <WebSocketGuideTab />
      </TabPanel>
    </div>
  );
}
