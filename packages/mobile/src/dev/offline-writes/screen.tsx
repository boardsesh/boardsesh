import { useEffect, useState } from 'react';
import { ScrollView, Text, View, Platform, DevSettings } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { openDatabaseAsync } from 'expo-sqlite';
import * as Application from 'expo-application';
import * as Updates from 'expo-updates';
import { randomUUID } from 'expo-crypto';
import {
  writeTickLocal,
  addFavoriteLocal,
  favoriteAddKey,
  writeAuthorFollowLocal,
} from '../../hooks/use-offline-mutations';
import { parseQaRequest, runQaPhase, type QaReceipt } from './cases';
import { createQaRuntimeReload, startQaCommandPolling, type QaHostCommand } from './control';

const runtimeId = randomUUID();
const runs = new Map<string, Promise<void>>();
const requestRuntimeReload = createQaRuntimeReload(runtimeId, () => DevSettings.reload('Offline write QA'));

/** Test transport is explicitly loopback; synthetic writes never reach the backend. */
export default function OfflineWriteScreen() {
  const params = useLocalSearchParams<{ runId?: string; phase?: string; rows?: string; receiptPort?: string }>();
  const [result, setResult] = useState('Waiting for an offline-write QA command');
  const [hostCommand, setHostCommand] = useState<QaHostCommand>();
  useEffect(() => {
    const port = process.env.EXPO_PUBLIC_OFFLINE_WRITE_QA_CONTROL_PORT;
    if (port === undefined) return;
    return startQaCommandPolling(Number(port), setHostCommand);
  }, []);
  const { runId, phase, rows, receiptPort } = hostCommand ?? params;
  useEffect(() => {
    if (runId === undefined && phase === undefined) return;
    const emit = async (receipt: QaReceipt) => {
      const complete = {
        ...receipt,
        platform: Platform.OS,
        nativeVersion: Application.nativeApplicationVersion,
        nativeBuild: Application.nativeBuildVersion,
        runtimeVersion: Updates.runtimeVersion ?? null,
        updateId: Updates.updateId ?? null,
        isEmbeddedLaunch: Updates.isEnabled ? Updates.isEmbeddedLaunch : null,
      };
      const encoded = JSON.stringify(complete);
      console.log(`[offline-write-qa] ${encoded}`);
      setResult(encoded);
      if (receiptPort !== undefined) {
        // parseQaRequest validates the port before this reporter can run.
        const response = await fetch(`http://127.0.0.1:${Number(receiptPort)}/receipt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: encoded,
        });
        if (!response.ok) throw new Error(`QA receipt transport returned ${response.status}`);
      }
    };
    try {
      const request = parseQaRequest({ runId, phase, rows, receiptPort });
      const key = `${request.runId}:${request.phase}`;
      let running = runs.get(key);
      if (!running) {
        running = runQaPhase(request, {
          open: (name) => openDatabaseAsync(name, { useNewConnection: true }),
          writeTick: writeTickLocal,
          addFavorite: addFavoriteLocal,
          favoriteKey: favoriteAddKey,
          follow: writeAuthorFollowLocal,
          runtimeId,
          emit,
        });
        runs.set(key, running);
      }
      void running.catch((error: unknown) => {
        setResult(`Receipt transport failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } catch (error) {
      setResult(`Invalid QA command: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [runId, phase, rows, receiptPort]);
  useEffect(() => requestRuntimeReload(hostCommand), [hostCommand]);

  return (
    <ScrollView contentContainerStyle={{ padding: 24 }}>
      <View accessibilityLabel="Offline write QA">
        <Text selectable testID="offline-write-qa-result">
          {result}
        </Text>
      </View>
    </ScrollView>
  );
}
