import { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ModalSheet } from './ModalSheet';
import { Icon } from './Icon';
import { Text } from './Text';
import { Button } from './Button';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';

type SignInPromptSheetProps = {
  visible: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
};

export function SignInPromptSheet({ visible, onClose, title, description }: SignInPromptSheetProps) {
  const router = useRouter();
  const { t } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const sheetRef = useRef<BottomSheetModal>(null);
  const isPresentedRef = useRef(false);

  useEffect(() => {
    if (visible && !isPresentedRef.current) {
      sheetRef.current?.present();
      isPresentedRef.current = true;
    } else if (!visible && isPresentedRef.current) {
      sheetRef.current?.dismiss();
      isPresentedRef.current = false;
    }
  }, [visible]);

  const handleDismiss = useCallback(() => {
    isPresentedRef.current = false;
    onClose();
  }, [onClose]);

  const handleSignIn = useCallback(() => {
    onClose();
    router.push('/auth/login');
  }, [onClose, router]);

  const copy = useMemo(
    () => ({
      title: title ?? t('userDrawer.signInModalTitle'),
      description: description ?? t('userDrawer.signInModalDescription'),
    }),
    [description, t, title],
  );

  return (
    <ModalSheet
      ref={sheetRef}
      snapPoints={['34%']}
      onDismiss={handleDismiss}
      enablePanDownToClose
      contentContainerStyle={styles.content}
    >
      <View style={styles.content}>
        <View style={[styles.iconCircle, { backgroundColor: systemColors.fill }]}>
          <Icon name="person" size={24} color={brandColors.primary} />
        </View>
        <Text variant="title3" style={styles.title}>
          {copy.title}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.description}>
          {copy.description}
        </Text>
        <Button title={t('userDrawer.signIn')} onPress={handleSignIn} size="large" style={styles.button} />
      </View>
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    alignItems: 'center',
    paddingHorizontal: spacing[5],
    paddingTop: spacing[4],
    paddingBottom: spacing[6],
  },
  iconCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing[3],
  },
  title: {
    textAlign: 'center',
  },
  description: {
    textAlign: 'center',
    marginTop: spacing[2],
  },
  button: {
    alignSelf: 'stretch',
    marginTop: spacing[5],
  },
});
