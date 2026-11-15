import { useIsFocused } from 'expo-router';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useNativeRootHeader } from '../../hooks/use-native-root-header';
import { usePhoneSplit } from '../../hooks/use-phone-split';
import { useHingePartiallyOpen } from '../../lib/device-hinge-store';
import { IpadPlayPane } from '../play-drawer/IpadPlayPane';
import { NativeTabletContentView, PhoneSplitPaneView } from './NativeTabletContentView';
export function NativeTabletContent({ children }: { children: ReactNode }) {
  const nativeRootHeader = useNativeRootHeader();
  if (!(nativeRootHeader && Platform.OS === 'ios') || Platform.isPad === true) return children;
  return <PhoneSplitContentHost>{children}</PhoneSplitContentHost>;
}
const renderPane = (content: ReactNode | null) => <PhoneSplitPane content={content} />;
function PhoneSplitContentHost({ children }: { children: ReactNode }) {
  const phoneSplit = usePhoneSplit();
  return (
    <NativeTabletContentView phoneSplit={phoneSplit} renderPane={renderPane}>
      {children}
    </NativeTabletContentView>
  );
}
function PhoneSplitPane({ content }: { content: ReactNode | null }) {
  const partiallyFolded = useHingePartiallyOpen();
  const { fixedFooterBottom } = useBottomChromeMetrics();
  const isFocused = useIsFocused();
  return (
    <PhoneSplitPaneView
      partiallyFolded={partiallyFolded}
      fixedFooterBottom={fixedFooterBottom}
      content={content ?? <IpadPlayPane variant="phoneSplit" acceptsScrollHandoff={isFocused} />}
    />
  );
}
