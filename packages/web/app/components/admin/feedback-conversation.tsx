'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { AppBugReportMessage, AppFeedbackReport } from '@boardsesh/shared-schema';
import {
  APP_BUG_REPORT_MESSAGES,
  type AppBugReportMessagesQueryResponse,
  type AppBugReportMessagesQueryVariables,
} from '@boardsesh/graphql/operations';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';

const PAGE_SIZE = 20;

function mergeMessages(existing: AppBugReportMessage[], incoming: AppBugReportMessage[]): AppBugReportMessage[] {
  // Pages arrive newest first in canonical GitHub order. Local cache IDs can
  // reflect webhook delivery order, so the client must preserve server order.
  const incomingIds = new Set(incoming.map((message) => message.id));
  const newestFirst = [...existing].reverse().filter((message) => !incomingIds.has(message.id));
  newestFirst.push(...incoming);
  return [...new Map(newestFirst.map((message) => [message.id, message])).values()].reverse();
}

/** Mounted with a report/account key so requests and drafts cannot cross accounts. */
export default function FeedbackConversation({
  report,
  token,
  onClose,
}: {
  report: AppFeedbackReport;
  token: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('admin');
  const [messages, setMessages] = useState<AppBugReportMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const alive = useRef(true);
  const loadingRef = useRef(false);
  const loadedPageCount = useRef(1);

  const load = useCallback(
    async (before?: string, quiet = false) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      if (!quiet) setLoading(true);
      try {
        const client = createGraphQLHttpClient(token);
        const pageCount = before ? 1 : loadedPageCount.current;
        let cursor = before;
        let latestPage: AppBugReportMessagesQueryResponse['appBugReportMessages'] | undefined;
        const refreshedMessages: AppBugReportMessage[] = [];
        let fetchedPages = 0;
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
          const response = await client.request<AppBugReportMessagesQueryResponse, AppBugReportMessagesQueryVariables>(
            APP_BUG_REPORT_MESSAGES,
            { input: { reportId: report.id, limit: PAGE_SIZE, before: cursor } },
          );
          if (!alive.current) return;
          latestPage = response.appBugReportMessages;
          refreshedMessages.push(...latestPage.messages);
          fetchedPages++;
          if (!latestPage.hasMore || !latestPage.endCursor) break;
          cursor = latestPage.endCursor;
        }
        if (!alive.current) return;
        // GitHub comments can be edited or withdrawn. Refresh the loaded window
        // authoritatively so a removed comment cannot survive in this dialog.
        setMessages((current) => mergeMessages(before ? current : [], refreshedMessages));
        setOlderCursor(latestPage?.endCursor ?? null);
        setHasMore(latestPage?.hasMore ?? false);
        loadedPageCount.current = before ? loadedPageCount.current + 1 : fetchedPages;
        setLoadError(false);
      } catch {
        if (alive.current && !quiet) setLoadError(true);
      } finally {
        loadingRef.current = false;
        if (alive.current) setLoading(false);
      }
    },
    [report.id, token],
  );

  useEffect(() => {
    alive.current = true;
    void load();
    const refresh = () => {
      if (document.visibilityState === 'visible') void load(undefined, true);
    };
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [load]);

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('feedback.conversation.title')}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {report.comment}
          </Typography>
          <Alert severity="info">{t('feedback.conversation.publicNotice')}</Alert>
          <Typography variant="body2">{t('feedback.conversation.githubHint')}</Typography>
          {hasMore && olderCursor && (
            <Button disabled={loading} onClick={() => void load(olderCursor)}>
              {t('feedback.conversation.loadOlder')}
            </Button>
          )}
          {loading && <CircularProgress size={24} />}
          {loadError && (
            <Alert
              severity="error"
              action={<Button onClick={() => void load()}>{t('feedback.conversation.retry')}</Button>}
            >
              {t('feedback.conversation.loadError')}
            </Alert>
          )}
          {!loading && !loadError && messages.length === 0 && (
            <Typography color="text.secondary">{t('feedback.conversation.empty')}</Typography>
          )}
          {messages.map((message) => (
            <Box key={message.id} sx={{ p: 2, bgcolor: 'var(--semantic-fill-subtle)', borderRadius: 1 }}>
              <Typography variant="caption" color="text.secondary">
                {message.authorRole === 'staff'
                  ? t('feedback.conversation.staff')
                  : t('feedback.conversation.reporter')}
                {' · '}
                {new Date(message.createdAt).toLocaleString()}
              </Typography>
              <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message.body}</Typography>
            </Box>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions>
        {report.githubIssueUrl && (
          <Button href={report.githubIssueUrl} target="_blank" rel="noopener noreferrer">
            {t('feedback.conversation.openGithub')}
          </Button>
        )}
        <Button onClick={onClose}>{t('feedback.conversation.close')}</Button>
      </DialogActions>
    </Dialog>
  );
}
