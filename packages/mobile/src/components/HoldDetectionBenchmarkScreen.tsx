import { useCallback, useMemo, useState } from 'react';
import { Redirect } from 'expo-router';
import { ActivityIndicator, Alert, Platform, StyleSheet, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import * as Device from 'expo-device';
import { type BenchmarkReport, formatBenchmarkJson, runBenchmark } from '../lib/hold-detection/benchmark';
import { decodePhotoToRgba } from '../lib/hold-detection/decode-image';
import { letterboxFitFor } from '../lib/hold-detection/manifest';
import { DEFAULT_MODEL_VERSION, type ModelHandle, ensureModel } from '../lib/hold-detection/model-store';
import { createHoldDetectionRuntime, isInferenceRuntimeAvailable } from '../lib/hold-detection/onnx-runtime';
import { hapticError, hapticLight } from '../lib/haptics';
import { useProfile } from '../lib/graphql/hooks';
import { useTheme } from '../providers/theme-provider';
import { SwitcherForm } from './SwitcherForm';
import type { SwitcherFormModel, SwitcherRow } from './SwitcherForm.types';

/**
 * Dev/tester-only screen that measures the hold detector on THIS device
 * (epic #5346, SW-02; the input to the on-device-vs-server call in #5451).
 *
 * All copy is hardcoded English with `// i18n-ignore-next-line`, the convention
 * every other row under Development follows: it never reaches a climber, and a
 * catalogue key per line would be four locales of dead weight.
 *
 * What it deliberately does NOT do: interpret the numbers. It prints latency,
 * detection counts and the JS heap delta and hands you a JSON blob. Peak RSS —
 * the number that actually decides — is not JS-visible on either platform, so
 * the footer says so and points at the platform profilers instead of inventing
 * a figure.
 */
export function HoldDetectionBenchmarkScreen() {
  const { systemColors } = useTheme();
  const { data: profile, isLoading: profileLoading } = useProfile();

  const [version, setVersion] = useState(DEFAULT_MODEL_VERSION);
  const [modelHandle, setModelHandle] = useState<ModelHandle | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<BenchmarkReport | null>(null);

  const runtimeAvailable = useMemo(() => isInferenceRuntimeAvailable(), []);

  const loadModel = useCallback(async () => {
    hapticLight();
    setBusy(true);
    setReport(null);
    setModelHandle(null);
    // i18n-ignore-next-line — tester-only screen
    setStatus('Fetching the manifest…');
    const handle = await ensureModel(version.trim(), {
      onStage: (stage) => {
        // i18n-ignore-next-line — tester-only screen
        if (stage === 'manifest') setStatus('Fetching the manifest…');
        // i18n-ignore-next-line — tester-only screen
        if (stage === 'download') setStatus('Downloading the weights (~31 MB)…');
        // i18n-ignore-next-line — tester-only screen
        if (stage === 'verify') setStatus('Verifying sha256…');
      },
    });
    setBusy(false);
    setModelHandle(handle);
    setStatus(
      handle
        ? null
        : // i18n-ignore-next-line — tester-only screen
          'No model. Offline, the version is not published, or the sha256 did not match.',
    );
    if (!handle) hapticError();
  }, [version]);

  const runOnPickedPhoto = useCallback(async () => {
    if (!modelHandle) return;
    hapticLight();
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (picked.canceled || !picked.assets[0]) return;

    setBusy(true);
    setReport(null);
    let runtime: Awaited<ReturnType<typeof createHoldDetectionRuntime>> = null;
    try {
      // i18n-ignore-next-line — tester-only screen
      setStatus('Decoding the photo…');
      // The picker already reports the asset's dimensions, so the decode never
      // has to render the full-resolution file to find them out. It reports 0
      // when the system would not say, which `decodePhotoToRgba` handles.
      const asset = picked.assets[0];
      const image = await decodePhotoToRgba(asset.uri, {
        sourceWidth: asset.width,
        sourceHeight: asset.height,
      });

      // i18n-ignore-next-line — tester-only screen
      setStatus('Opening the ONNX session…');
      const openSession = () =>
        createHoldDetectionRuntime(modelHandle.uri, {
          classes: modelHandle.manifest.outputs.logits.classes,
          // The manifest parses both output names; hand them over so a four-class
          // export is not resolved by ONNX Runtime's key order.
          outputNames: {
            boxes: modelHandle.manifest.outputs.boxes.name,
            logits: modelHandle.manifest.outputs.logits.name,
          },
        });
      runtime = await openSession();
      if (!runtime) {
        // i18n-ignore-next-line — tester-only screen
        setStatus('ONNX Runtime would not open the model on this device.');
        hapticError();
        return;
      }

      const finished = await runBenchmark({
        runtime,
        image,
        modelVersion: modelHandle.version,
        modelConfig: modelHandle.manifest.config,
        requestedExecutionProvider: runtime.requestedExecutionProvider,
        defaultThreshold: modelHandle.defaultThreshold,
        // Straight off the manifest, never the shared package's defaults: the
        // numbers this screen reports have to describe the preprocessing the
        // model was actually exported for.
        fit: letterboxFitFor(modelHandle.manifest.input),
        mean: modelHandle.manifest.input.normalization.mean,
        std: modelHandle.manifest.input.normalization.std,
        // Close this size's session and open a fresh one before the next, larger
        // size: ONNX Runtime's arena only grows, so without this the 768 pass
        // runs on top of 512's and 640's high-water marks. `runtime` is
        // reassigned so the `finally` below always releases the live session.
        recycleRuntime: async () => {
          await runtime?.release();
          runtime = null;
          // i18n-ignore-next-line — tester-only screen
          setStatus('Reopening the ONNX session…');
          runtime = await openSession();
          return runtime;
        },
        onProgress: (size, run, totalRuns) => {
          // i18n-ignore-next-line — tester-only screen
          setStatus(`${size} px — pass ${run} of ${totalRuns}…`);
        },
      });
      setReport(finished);
      setStatus(null);
    } catch (error) {
      hapticError();
      // i18n-ignore-next-line — tester-only screen
      setStatus(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Always release: a leaked session keeps its native arena, and the next
      // run's memory number would be measuring this one's leftovers.
      await runtime?.release();
      setBusy(false);
    }
  }, [modelHandle]);

  const copyResults = useCallback(async () => {
    if (!report) return;
    hapticLight();
    await Clipboard.setStringAsync(
      formatBenchmarkJson(report, {
        platform: Platform.OS,
        osVersion: Platform.Version,
        modelName: Device.modelName,
        deviceName: Device.deviceName,
        totalMemoryBytes: Device.totalMemory,
      }),
    );
    // i18n-ignore-next-line — tester-only screen
    Alert.alert('Copied', 'Paste the JSON into the issue thread for #5435.');
  }, [report]);

  const formModel = useMemo<SwitcherFormModel>(() => {
    const modelRows: SwitcherRow[] = [
      {
        kind: 'info',
        key: 'runtime',
        // i18n-ignore-next-line — tester-only screen
        label: 'ONNX Runtime',
        // i18n-ignore-next-line — tester-only screen
        value: runtimeAvailable ? 'Linked' : 'Missing — this build predates it',
      },
      {
        kind: 'field',
        key: 'version',
        // i18n-ignore-next-line — tester-only screen
        label: 'Model version',
        // The default itself, not a hand-typed example: the two drifted once
        // already (a dotted default next to a dashed placeholder), and a version
        // that does not match a published prefix just reports "No model".
        // i18n-ignore-next-line — tester-only screen
        placeholder: `e.g. ${DEFAULT_MODEL_VERSION}`,
        value: version,
        onChangeText: setVersion,
        onSubmit: () => void loadModel(),
        editable: !busy,
      },
      {
        kind: 'action',
        key: 'load',
        // i18n-ignore-next-line — tester-only screen
        label: modelHandle ? 'Reload the model' : 'Load the model',
        icon: 'reset',
        disabled: busy || !runtimeAvailable,
        onPress: () => void loadModel(),
      },
    ];
    if (modelHandle) {
      modelRows.push(
        // i18n-ignore-next-line — tester-only screen
        { kind: 'info', key: 'config', label: 'Config', value: modelHandle.manifest.config },
        {
          kind: 'info',
          key: 'input',
          // i18n-ignore-next-line — tester-only screen
          label: 'Trained input',
          value: `${modelHandle.trainedInputSize} px`,
        },
        {
          kind: 'info',
          key: 'threshold',
          // i18n-ignore-next-line — tester-only screen
          label: 'Default threshold',
          value: modelHandle.defaultThreshold.toFixed(2),
        },
        {
          kind: 'info',
          key: 'bytes',
          // i18n-ignore-next-line — tester-only screen
          label: 'Weights',
          value: `${(modelHandle.bytes / 1_000_000).toFixed(1)} MB`,
        },
      );
    }
    if (status) modelRows.push({ kind: 'status', key: 'status', label: status, busy });

    const sections: SwitcherFormModel['sections'] = [
      {
        key: 'model',
        // i18n-ignore-next-line — tester-only screen
        title: 'Model',
        // i18n-ignore-next-line — tester-only screen
        intro: 'Downloads from the media bucket into the cache directory. Two versions are kept.',
        rows: modelRows,
      },
      {
        key: 'run',
        // i18n-ignore-next-line — tester-only screen
        title: 'Benchmark',
        // i18n-ignore-next-line — tester-only screen
        intro: 'Pick a wall photo. Three passes at each of 768, 640 and 512 px.',
        rows: [
          {
            kind: 'action',
            key: 'pick',
            // i18n-ignore-next-line — tester-only screen
            label: 'Pick a photo and run',
            icon: 'send',
            disabled: busy || !modelHandle,
            onPress: () => void runOnPickedPhoto(),
          },
        ],
      },
    ];

    if (report) {
      for (const size of report.sizes) {
        sections.push({
          key: `size-${size.size}`,
          title: `${size.size} px`,
          rows: [
            {
              kind: 'info',
              key: 'p50',
              // i18n-ignore-next-line — tester-only screen
              label: 'p50 latency',
              value: `${Math.round(size.p50Ms)} ms`,
            },
            {
              kind: 'info',
              key: 'runs',
              // i18n-ignore-next-line — tester-only screen
              label: 'Passes',
              value: size.runsMs.map((ms) => `${Math.round(ms)}`).join(' / '),
            },
            {
              kind: 'info',
              key: 'default',
              // i18n-ignore-next-line — tester-only screen
              label: `Detections @ ${report.defaultThreshold.toFixed(2)}`,
              value: `${size.detectionsAtDefault}`,
            },
            {
              kind: 'info',
              key: 'low',
              label: `Detections @ ${report.lowThreshold.toFixed(2)}`,
              value: `${size.detectionsAtLow}`,
            },
            {
              kind: 'info',
              key: 'heap',
              // i18n-ignore-next-line — tester-only screen
              label: 'JS heap delta',
              value:
                size.jsHeapDeltaBytes === null
                  ? // i18n-ignore-next-line — tester-only screen
                    'not reported'
                  : `${(size.jsHeapDeltaBytes / 1_000_000).toFixed(1)} MB`,
            },
          ],
        });
      }
      for (const failure of report.failures) {
        sections.push({
          key: `failed-${failure.size}`,
          // i18n-ignore-next-line — tester-only screen
          title: `${failure.size} px — refused`,
          // i18n-ignore-next-line — tester-only screen
          footer:
            'The published graph is exported at one fixed input size with no dynamic axes, so anything below the trained size is rejected. The sizes that did run are still above.',
          rows: [
            {
              kind: 'info',
              key: 'error',
              // i18n-ignore-next-line — tester-only screen
              label: 'Error',
              value: failure.error,
            },
          ],
        });
      }
      sections.push({
        key: 'copy',
        // i18n-ignore-next-line — tester-only screen
        title: 'Report',
        // i18n-ignore-next-line — tester-only screen
        footer:
          'JS heap is NOT the number that decides on-device vs server: ONNX Runtime allocates in native memory, which no JS counter sees. Read peak RSS in Xcode Instruments (Allocations) or Android Studio (Memory Profiler) while this screen runs.',
        rows: [
          {
            kind: 'info',
            key: 'provider',
            // i18n-ignore-next-line — tester-only screen
            label: 'Requested provider',
            // Requested, not measured: ONNX Runtime falls back to CPU per
            // subgraph without saying so, so the honest label is what we asked
            // for. A per-kernel answer needs a native profile.
            value: report.requestedExecutionProvider,
          },
          {
            kind: 'info',
            key: 'photo',
            // i18n-ignore-next-line — tester-only screen
            label: 'Photo',
            value: `${report.photo.sourceWidth}x${report.photo.sourceHeight} → ${report.photo.width}x${report.photo.height}`,
          },
          {
            kind: 'action',
            key: 'copy',
            // i18n-ignore-next-line — tester-only screen
            label: 'Copy results as JSON',
            icon: 'send',
            onPress: () => void copyResults(),
          },
        ],
      });
    }

    return { sections };
  }, [busy, copyResults, loadModel, modelHandle, report, runOnPickedPhoto, runtimeAvailable, status, version]);

  if (!__DEV__) {
    if (profileLoading) {
      return (
        <View style={[styles.loading, { backgroundColor: systemColors.groupedBackground }]}>
          <ActivityIndicator />
        </View>
      );
    }
    if (!profile?.isTester) {
      return <Redirect href="/(tabs)/profile/more" />;
    }
  }

  return <SwitcherForm model={formModel} />;
}

const styles = StyleSheet.create({
  loading: { alignItems: 'center', flex: 1, justifyContent: 'center' },
});
