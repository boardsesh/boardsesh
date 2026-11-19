import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  RESOLVE_PARTNER_SESSION_HISTORY,
  type ResolvePartnerSessionHistoryResponse,
} from '@boardsesh/graphql/operations/partner-session-history';
import { useAuth } from '../../../src/providers/auth-provider';
import { useConsentSettled } from '../../../src/lib/consent-hooks';
import { getHttpClient } from '../../../src/lib/graphql/client';
import { getCredentialGeneration } from '../../../src/lib/privacy/privacy-cache';
import {
  isSessionExportId,
  PENDING_SESSION_HISTORY_KEY,
  serializePendingSessionHistory,
} from '../../../src/lib/partner-session-history-link';
import { reportHandledError } from '../../../src/lib/error-reporting';
import { Text } from '../../../src/components/Text';
import { Button } from '../../../src/components/Button';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { spacing } from '../../../src/theme/tokens';

export default function PartnerSessionHistoryRoute() {
  const { exportId } = useLocalSearchParams<{ exportId: string }>();
  const { t } = useTranslation('session');
  const { isAuthenticated } = useAuth();
  const consentSettled = useConsentSettled();
  const generation = getCredentialGeneration();
  const router = useRouter();
  const query = useQuery({
    queryKey: ['partnerSessionHistory', generation, exportId],
    enabled: isAuthenticated && consentSettled && isSessionExportId(exportId),
    queryFn: async () =>
      (
        await getHttpClient().request<ResolvePartnerSessionHistoryResponse>(RESOLVE_PARTNER_SESSION_HISTORY, {
          exportId,
        })
      ).resolvePartnerSessionHistory,
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  useEffect(() => {
    if (isAuthenticated || !isSessionExportId(exportId)) return;
    let cancelled = false;
    void AsyncStorage.setItem(PENDING_SESSION_HISTORY_KEY, serializePendingSessionHistory(exportId))
      .then(() => {
        if (!cancelled && generation === getCredentialGeneration()) router.replace('/auth/login');
      })
      .catch((error: unknown) => {
        reportHandledError(error, { tags: { source: 'partner-session-history', op: 'stash-link' } });
      });
    return () => {
      cancelled = true;
    };
  }, [exportId, generation, isAuthenticated, router]);

  useEffect(() => {
    if (
      !query.data ||
      query.isFetching ||
      query.isError ||
      !isAuthenticated ||
      !consentSettled ||
      generation !== getCredentialGeneration()
    )
      return;
    router.replace({ pathname: '/(tabs)/home/session/[sessionId]', params: { sessionId: query.data } });
  }, [query.data, query.isFetching, query.isError, isAuthenticated, consentSettled, generation, router]);

  return (
    <View style={styles.body}>
      <Stack.Screen options={{ title: t('partnerHistory.title') }} />
      {!isSessionExportId(exportId) || query.data === null ? (
        <Text>{t('partnerHistory.unavailable')}</Text>
      ) : query.isError ? (
        <>
          <Text>{t('partnerHistory.loadError')}</Text>
          <Button title={t('partnerHistory.retry')} onPress={() => void query.refetch()} />
        </>
      ) : (
        <ActivityIndicator />
      )}
    </View>
  );
}

const styles = StyleSheet.create({ body: { flex: 1, padding: spacing[4], gap: spacing[4], justifyContent: 'center' } });
