import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { HeaderLeadingButton } from '../HeaderActionButtons';
import type { BoardReturnTo } from '../../lib/boards/board-return-to';
import { exitSprayWizard } from './exit-spray-wizard';

/** A visible way out even when a cold deep link created no back history. */
export function SprayWizardExitButton({ returnTo }: { returnTo: BoardReturnTo }) {
  const router = useRouter();
  const { t } = useTranslation('common');
  return (
    <HeaderLeadingButton
      kind="close"
      onPress={() => exitSprayWizard(router, returnTo)}
      accessibilityLabel={t('ariaLabels.close')}
    />
  );
}
