import { useTranslation } from 'react-i18next';
import { ChromeIconButton } from '../ChromeIconButton';

/**
 * The + in the board picker's and Manage boards' top bar with the
 * `add-board-wizard` flag on: one tap opens the add-a-board wizard, whose
 * first step asks where the board is. Finding a gym is not here any more: Near
 * you's Map › opens the gym map. Bare, like the leading X, so it keeps the
 * native bar's frame. The caller only offers it online and signed in.
 */
export function AddBoardButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation('boards');
  return (
    <ChromeIconButton
      appearance="bare"
      icon="plus"
      role="action"
      onPress={onPress}
      accessibilityLabel={t('mobile.addBoard.aria')}
      testID="add-board-button"
    />
  );
}
