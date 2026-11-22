import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { acquireSprayHoldEditorLease } from '../../lib/spray/spray-hold-editor-lease';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { Text } from '../Text';
import { Button } from '../Button';
import type { SprayHoldPersistence } from './use-spray-hold-autosave';

/** Mount the editor (and its fresh server read) only after exclusive ownership. */
export function SprayHoldEditorLeaseBoundary({
  storageKey,
  onPersistenceReady,
  children,
}: {
  storageKey: string | null;
  onPersistenceReady?: (persistence: SprayHoldPersistence | null) => void;
  children: (onReady: (persistence: SprayHoldPersistence | null) => void) => ReactNode;
}) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const [lease, setLease] = useState<object | null>(null);
  const [failed, setFailed] = useState(false);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const persistenceRef = useRef<SprayHoldPersistence | null>(null);
  const reportRef = useRef(onPersistenceReady);
  reportRef.current = onPersistenceReady;
  const onReady = useCallback((persistence: SprayHoldPersistence | null) => {
    // Retain the retiring editor's drain even after its report is withdrawn.
    if (persistence) persistenceRef.current = persistence;
    reportRef.current?.(persistence);
  }, []);
  useEffect(() => {
    if (!storageKey) return;
    const abort = new AbortController();
    let release: (() => void) | null = null;
    setLease(null);
    setFailed(false);
    persistenceRef.current = null;
    reportRef.current?.({ flush: async () => undefined, recoveryPending: true });
    void acquireSprayHoldEditorLease(storageKey, abort.signal)
      .then((unlock) => {
        if (abort.signal.aborted) {
          unlock();
          return;
        }
        release = unlock;
        setLease({});
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      });
    return () => {
      abort.abort();
      const persistence = persistenceRef.current;
      // Involuntary dismissal cannot await storage, but the next editor can.
      void (async () => {
        try {
          await persistence?.retire?.();
        } catch {
          /* The next session reports any surviving recovery record. */
        } finally {
          release?.();
        }
      })();
    };
  }, [storageKey, retryEpoch]);
  if (!storageKey || lease) return children(onReady);
  return (
    <View style={[styles.waiting, { backgroundColor: systemColors.background }]}>
      <Text>{failed ? t('sprayEditor.draft.lockUnavailable') : t('sprayEditor.draft.openElsewhere')}</Text>
      {failed ? (
        <Button title={t('sprayEditor.draft.retry')} onPress={() => setRetryEpoch((epoch) => epoch + 1)} />
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  waiting: { flex: 1, justifyContent: 'center', padding: spacing[6], gap: spacing[4] },
});
