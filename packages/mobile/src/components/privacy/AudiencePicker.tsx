import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { PrivacyResourceAudience } from '@boardsesh/graphql/operations/privacy';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { useConfirm } from '../../providers/dialog-provider';
import { audienceConfirmation } from './privacy-settings-changes';

export const SOCIAL_AUDIENCES = ['public', 'followers', 'only_me'] as const;
export const SESSION_AUDIENCES = ['public', 'unlisted', 'followers', 'invite_only'] as const;
export const BOARD_AUDIENCES = ['public', 'unlisted', 'followers', 'invite_only'] as const;

/** Inline expansion also works inside native sheets without stacking presenters. */
export function AudiencePicker<TAudience extends PrivacyResourceAudience>({
  audience,
  onChange,
  options,
  disabled = false,
  confirmPublic = false,
  reconfirmPublic = false,
  resource = false,
  label,
}: {
  audience: TAudience;
  onChange: (audience: TAudience) => void;
  options: readonly TAudience[];
  disabled?: boolean;
  confirmPublic?: boolean;
  reconfirmPublic?: boolean;
  resource?: boolean;
  label?: string;
}) {
  const { t } = useTranslation('settings');
  const { spacing, radii, systemColors, brandColors } = useTheme();
  const confirm = useConfirm();
  const [expanded, setExpanded] = useState(false);
  const labels: Record<PrivacyResourceAudience, string> = {
    public: t('privacy.audiences.public'),
    followers: t('privacy.audiences.followers'),
    only_me: t('privacy.audiences.onlyMe'),
    unlisted: t('privacy.audiences.unlisted'),
    invite_only: t('privacy.audiences.invited'),
  };
  const chooseAudience = async (next: TAudience) => {
    const confirmation = audienceConfirmation({ next, current: audience, confirmPublic, reconfirmPublic, resource, t });
    if (confirmation && !(await confirm(confirmation))) return;
    onChange(next);
    setExpanded(false);
  };
  return (
    <View style={{ gap: spacing[2] }}>
      {label ? <Text variant="subheadline">{label}</Text> : null}
      <PressableSurface
        disabled={disabled}
        onPress={() => setExpanded(!expanded)}
        accessibilityLabel={t('privacy.audienceLabel', { audience: labels[audience] })}
        accessibilityState={{ disabled, expanded }}
        style={[
          styles.control,
          { padding: spacing[3], gap: spacing[2], borderRadius: radii.button, borderColor: systemColors.separator },
        ]}
      >
        <Icon name={audience === 'public' ? 'people' : 'lock'} size={18} color={systemColors.secondaryLabel} />
        <Text>{labels[audience]}</Text>
      </PressableSurface>
      {expanded && !disabled
        ? options.map((option) => {
            const selected = option === audience;
            return (
              <PressableSurface
                key={option}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                onPress={() => void chooseAudience(option)}
                style={[
                  styles.option,
                  {
                    padding: spacing[3],
                    gap: spacing[2],
                    borderRadius: radii.button,
                    backgroundColor: systemColors.secondaryBackground,
                  },
                ]}
              >
                <Text color={selected ? brandColors.primary : systemColors.label} style={styles.optionLabel}>
                  {labels[option]}
                </Text>
                {/* The checkmark carries the selection too, so it never rests on
                    colour alone (WCAG 1.4.1). */}
                {selected ? <Icon name="check.small" size={20} color={systemColors.accent} /> : null}
              </PressableSurface>
            );
          })
        : null}
    </View>
  );
}
const styles = StyleSheet.create({
  control: {
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  optionLabel: {
    flex: 1,
  },
});
