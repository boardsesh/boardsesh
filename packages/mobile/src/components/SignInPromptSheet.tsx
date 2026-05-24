import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import BottomSheet, { BottomSheetBackdrop, BottomSheetView, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { SignInPrompt } from './SignInPrompt';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';

type SignInPromptSheetProps = {
  visible: boolean;
  onDismiss: () => void;
  title: string;
  description?: string;
};

export function SignInPromptSheet({ visible, onDismiss, title, description }: SignInPromptSheetProps) {
  const { systemColors } = useTheme();
  const sheetRef = useRef<BottomSheet>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);

  useEffect(() => {
    if (mounted) sheetRef.current?.expand();
  }, [mounted]);

  const snapPoints = useMemo(() => ['45%'], []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />,
    [],
  );

  const handleClose = useCallback(() => {
    setMounted(false);
    onDismiss();
  }, [onDismiss]);

  if (!mounted) return null;

  return (
    <BottomSheet
      ref={sheetRef}
      snapPoints={snapPoints}
      enablePanDownToClose
      onClose={handleClose}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: systemColors.secondaryBackground }}
      handleIndicatorStyle={{ backgroundColor: systemColors.separator }}
    >
      <BottomSheetView style={styles.content}>
        <SignInPrompt title={title} description={description} />
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    paddingHorizontal: spacing[4],
  },
});
