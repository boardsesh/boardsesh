import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, RefreshControl, StyleSheet, View } from 'react-native';
import { Stack, useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { randomUUID } from 'expo-crypto';
import { useTranslation } from 'react-i18next';
import type { AppBugReport, AppBugReportMessage } from '@boardsesh/shared-schema';
import { useAuth } from '../../providers/auth-provider';
import { useStoredUserId } from '../../hooks/use-current-user-id';
import { useStackScreenOptions } from '../../hooks/use-stack-screen-options';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import {
  useAppBugReport,
  useAppBugReportMessages,
  useSendAppBugReportMessage,
  useMarkAppBugReportRead,
  useRetryAppBugReportMessage,
} from '../../lib/feedback/use-bug-reports';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { openExternalUrl } from '../../lib/open-url';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { AccessibleTextInput } from '../AccessibleTextInput';
import { ActivityIndicator } from '../ActivityIndicator';
import { Button } from '../Button';
import { Text } from '../Text';
import { OfflineState } from '../OfflineState';
import { bugReportStatusLabel } from './bug-report-status';

const EMPTY_MESSAGES: AppBugReportMessage[] = [];
const messageKey = (message: AppBugReportMessage) => message.id;
const MAX_REPLY_LENGTH = 2_000;

const BugReportMessageRow = memo(function BugReportMessageRow({
  message,
  onRetry,
  retrying,
}: {
  message: AppBugReportMessage;
  onRetry: (messageId: string) => void;
  retrying: boolean;
}) {
  const { t } = useTranslation('settings');
  const { systemColors } = useTheme();
  const fromStaff = message.authorRole === 'staff';
  const retry = useCallback(() => onRetry(message.id), [onRetry, message.id]);
  return (
    <View
      style={[
        styles.message,
        fromStaff ? styles.staffMessage : styles.reporterMessage,
        { backgroundColor: systemColors.secondaryBackground },
      ]}
    >
      <Text variant="footnote" emphasized>
        {fromStaff ? t('bugReports.staff') : t('bugReports.you')}
      </Text>
      <Text selectable>{message.body}</Text>
      <Text variant="caption1" tone="secondary">
        {formatRelativeTime(message.createdAt)}
      </Text>
      {message.deliveryStatus === 'pending' ? (
        <Text variant="footnote" tone="secondary">
          {t('bugReports.pending')}
        </Text>
      ) : null}
      {message.deliveryStatus === 'failed' ? (
        <>
          <Text variant="footnote" color={systemColors.error}>
            {t('bugReports.failed')}
          </Text>
          <Button title={t('bugReports.retrySend')} variant="text" size="small" loading={retrying} onPress={retry} />
        </>
      ) : null}
    </View>
  );
});

function BugReportSummary({ report }: { report: AppBugReport }) {
  const { t } = useTranslation('settings');
  return (
    <View style={styles.summary}>
      <Text variant="footnote" tone="secondary">
        {bugReportStatusLabel(report.status, t)} · {formatRelativeTime(report.createdAt)}
      </Text>
      <Text selectable>{report.comment}</Text>
      {report.screenshotUrls.map((uri) => (
        <Image key={uri} source={{ uri }} contentFit="contain" style={styles.screenshot} />
      ))}
    </View>
  );
}

/** Kept under an account/report key so a draft cannot cross an account switch. */
export function BugReportConversation({
  accountId,
  report,
  onRefreshReport,
}: {
  accountId: string;
  report: AppBugReport;
  onRefreshReport?: () => void;
}) {
  const { t } = useTranslation('settings');
  const { systemColors } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  const headerHeight = useHeaderHeight();
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState(false);
  const retryRef = useRef<{ body: string; clientMutationId: string } | null>(null);
  const focused = useIsFocused();
  const issueUrl = report.githubIssueUrl;
  const openIssue = useCallback(() => {
    if (issueUrl) void openExternalUrl(issueUrl, 'bug-report-issue');
  }, [issueUrl]);
  const messagesQuery = useAppBugReportMessages(accountId, report.id, focused);
  const { data, refetch, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage, isRefetching } = messagesQuery;
  const { mutateAsync: sendMessage, isPending: sending } = useSendAppBugReportMessage(accountId, report.id);
  const { mutate: markRead } = useMarkAppBugReportRead(report.id);
  const {
    mutate: retryMessage,
    variables: retryingId,
    isPending: retrying,
  } = useRetryAppBugReportMessage(accountId, report.id);
  const offline = useOfflineQueryState(messagesQuery);
  // Every server page is newest-first. Reverse a fresh flattened array once,
  // then let FlashList maintain the viewport when earlier messages are added.
  const messages = useMemo(() => data?.pages.flatMap((page) => page.messages).reverse() ?? EMPTY_MESSAGES, [data]);
  const readStaffMessageIds = useRef<Set<string> | null>(null);
  const messagesLoaded = !!data;
  useEffect(() => {
    if (!focused) {
      readStaffMessageIds.current = null;
      return;
    }
    if (!messagesLoaded) return;
    // Only the newest page can bring a new reply. Older pagination, our own
    // replies and delivery updates cannot make the staff notification unread.
    const staffMessageIds =
      data.pages[0]?.messages.filter((message) => message.authorRole === 'staff').map((message) => message.id) ?? [];
    const previousStaffMessageIds = readStaffMessageIds.current;
    const hasNewStaffMessage =
      previousStaffMessageIds === null || staffMessageIds.some((id) => !previousStaffMessageIds.has(id));
    const seenStaffMessageIds = previousStaffMessageIds ?? new Set<string>();
    for (const id of staffMessageIds) seenStaffMessageIds.add(id);
    readStaffMessageIds.current = seenStaffMessageIds;
    if (hasNewStaffMessage) markRead();
  }, [data, messagesLoaded, focused, markRead]);
  useFocusEffect(
    useCallback(() => {
      void refetch({ cancelRefetch: false });
    }, [refetch]),
  );
  const handleRefresh = useCallback(() => {
    void refetch({ cancelRefetch: false });
    onRefreshReport?.();
  }, [refetch, onRefreshReport]);
  const loadEarlier = useCallback(() => {
    if (focused && hasNextPage && !isFetching) void fetchNextPage({ cancelRefetch: false });
  }, [focused, hasNextPage, isFetching, fetchNextPage]);
  const changeDraft = useCallback((next: string) => {
    setDraft(next);
    setSendError(false);
  }, []);
  const submit = useCallback(async () => {
    const body = draft.trim();
    if (!body || body.length > MAX_REPLY_LENGTH || sending || !report.canReply) return;
    // A failed/ambiguous response keeps its UUID. Retrying the same text cannot
    // create a second message if the first request committed before disconnect.
    if (retryRef.current?.body !== body) retryRef.current = { body, clientMutationId: randomUUID() };
    setSendError(false);
    try {
      await sendMessage({ reportId: report.id, ...retryRef.current });
      retryRef.current = null;
      setDraft('');
    } catch {
      setSendError(true);
    }
  }, [draft, sending, report.id, report.canReply, sendMessage]);
  const handleSend = useCallback(() => {
    void submit();
  }, [submit]);
  const renderMessage = useCallback(
    ({ item }: { item: AppBugReportMessage }) => (
      <BugReportMessageRow message={item} onRetry={retryMessage} retrying={retrying && retryingId === item.id} />
    ),
    [retryMessage, retrying, retryingId],
  );

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={headerHeight}
    >
      <FlashList
        data={messages}
        keyExtractor={messageKey}
        renderItem={renderMessage}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.messages}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        maintainVisibleContentPosition={{ startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.2 }}
        refreshControl={<RefreshControl refreshing={isRefetching && !isFetchingNextPage} onRefresh={handleRefresh} />}
        ListHeaderComponent={
          <>
            <BugReportSummary report={report} />
            {hasNextPage ? (
              <Button
                title={t('bugReports.loadOlder')}
                variant="text"
                loading={isFetchingNextPage}
                onPress={loadEarlier}
              />
            ) : null}
          </>
        }
        ListEmptyComponent={
          offline.isBlocked && offline.reason ? (
            <OfflineState reason={offline.reason} onRetry={handleRefresh} />
          ) : messagesQuery.isPending ? (
            <View style={styles.state}>
              <ActivityIndicator />
            </View>
          ) : messagesQuery.isError ? (
            <View style={styles.state}>
              <Text>{t('bugReports.threadError')}</Text>
              <Button title={t('bugReports.retry')} variant="text" onPress={handleRefresh} />
            </View>
          ) : (
            <View style={styles.state}>
              <Text tone="secondary">{t('bugReports.noMessages')}</Text>
            </View>
          )
        }
      />
      <View
        style={[
          styles.composer,
          { backgroundColor: systemColors.background, paddingBottom: bottomChrome.scrollBottomPadding + spacing[3] },
        ]}
      >
        <Text variant="footnote" tone="secondary">
          {t('bugReports.publicNotice')}
        </Text>
        {issueUrl ? <Button title={t('bugReports.github')} variant="text" size="small" onPress={openIssue} /> : null}
        {sendError ? (
          <Text accessibilityRole="alert" color={systemColors.error}>
            {t('bugReports.sendError')}
          </Text>
        ) : null}
        {report.canReply ? (
          <>
            <AccessibleTextInput
              accessibilityLabel={t('bugReports.replyPlaceholder')}
              placeholder={t('bugReports.replyPlaceholder')}
              value={draft}
              onChangeText={changeDraft}
              multiline
              maxLength={MAX_REPLY_LENGTH}
              editable={!sending}
              style={[styles.input, { color: systemColors.label, backgroundColor: systemColors.secondaryBackground }]}
            />
            <Button
              title={t('bugReports.send')}
              onPress={handleSend}
              loading={sending}
              disabled={sending || !draft.trim()}
            />
          </>
        ) : (
          <>
            <Text tone="secondary">{t('bugReports.readOnly')}</Text>
            <Button title={t('bugReports.retry')} variant="text" onPress={handleRefresh} />
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

export default function BugReportScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation('settings');
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { userId, isLoading: accountLoading } = useStoredUserId(isAuthenticated);
  const { systemColors } = useTheme();
  const screenOptions = useStackScreenOptions();
  const focused = useIsFocused();
  const router = useRouter();
  const reportId = typeof id === 'string' ? id : '';
  const query = useAppBugReport(isAuthenticated ? userId : undefined, reportId, focused);
  const { data: report, refetch } = query;
  const offline = useOfflineQueryState(query);
  const handleRetry = useCallback(() => {
    void refetch({ cancelRefetch: false });
  }, [refetch]);
  const signIn = useCallback(() => router.push('/auth/login'), [router]);
  useFocusEffect(
    useCallback(() => {
      if (isAuthenticated && userId && /^\d+$/.test(reportId)) void refetch({ cancelRefetch: false });
    }, [isAuthenticated, userId, reportId, refetch]),
  );
  const loading = authLoading || accountLoading || (isAuthenticated && userId && query.isPending);
  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
      <Stack.Screen options={{ ...screenOptions, title: t('bugReports.detailTitle'), headerShown: true }} />
      {!isAuthenticated && !authLoading ? (
        <View style={styles.state}>
          <Button title={t('bugReports.signIn')} onPress={signIn} />
        </View>
      ) : report && userId ? (
        <BugReportConversation
          key={`${userId}:${report.id}`}
          accountId={userId}
          report={report}
          onRefreshReport={handleRetry}
        />
      ) : offline.isBlocked && offline.reason ? (
        <OfflineState reason={offline.reason} onRetry={handleRetry} />
      ) : loading && /^\d+$/.test(reportId) ? (
        <View style={styles.state}>
          <ActivityIndicator size="large" />
        </View>
      ) : query.isError ? (
        <View style={styles.state}>
          <Text>{t('bugReports.threadError')}</Text>
          <Button title={t('bugReports.retry')} variant="text" onPress={handleRetry} />
        </View>
      ) : (
        <View style={styles.state}>
          <Text>{t('bugReports.notFound')}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  state: { padding: spacing[6], gap: spacing[4], alignItems: 'center' },
  summary: { padding: spacing[4], gap: spacing[3] },
  screenshot: { height: 200, width: '100%', borderRadius: borderRadius.md },
  messages: { paddingBottom: spacing[3] },
  message: {
    maxWidth: '90%',
    marginHorizontal: spacing[4],
    marginVertical: spacing[2],
    padding: spacing[3],
    gap: spacing[2],
    borderRadius: borderRadius.lg,
  },
  staffMessage: { alignSelf: 'flex-start' },
  reporterMessage: { alignSelf: 'flex-end' },
  composer: { paddingHorizontal: spacing[4], paddingTop: spacing[3], gap: spacing[3] },
  input: {
    padding: spacing[3],
    borderRadius: borderRadius.md,
    minHeight: 60,
    maxHeight: 160,
    textAlignVertical: 'top',
  },
});
