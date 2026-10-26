import { StyleSheet, View } from 'react-native';
import type { NativeStackNavigationOptions } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Appbar } from 'react-native-paper';
import {
  CollapsingLargeTitleHeader,
  GlassActionToolbar,
  GlassToolbarAction,
  NATIVE_ACTION_SIZE,
  TOP_ACTION_SIZE,
} from '../chrome';
import { NativeRootHeader } from '../chrome/NativeRootHeader';
import { MaterialAppBarTitle } from '../chrome/MaterialAppBarTitle';
import { MaterialTopAppBar } from '../chrome/MaterialTopAppBar';
import type { ScrollEdgeBackdrop } from '../../hooks/use-scroll-edge-backdrop';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { LargeContentViewer } from '../LargeContentViewer';
import { PressableSurface } from '../PressableSurface';
import { iconMap } from '../icon-map';
import { UserAvatarToolbarAction } from '../user-drawer/UserAvatarToolbarAction';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants';
import { spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { topBarFor } from '../../theme/top-bar';
import { useNativeRootHeader } from '../../hooks/use-native-root-header';
import { useGlassCapability } from '../../hooks/use-glass-capability';

type RecordTopChromeProps = {
  /** The native or Material header owns the contextual session title. */
  title: string;
  /** Rename is a separate action when the header owns the title. */
  onEditTitle?: () => void;
  /** Supplementary chrome height; UIKit accounts for its own header. */
  onHeightChange: (height: number) => void;
  /** The list under the bar, so the Material app bar tints once it scrolls under. */
  scrollEdge?: ScrollEdgeBackdrop;
  onShare?: () => void;
  onEndSession?: () => void;
  /** The owner stops the session; a joiner leaves without ending it. */
  exitVariant?: 'end' | 'leave';
};

/** Session actions only. Board configuration and lights belong to Climbs. */
export function RecordTopChrome({
  title,
  onEditTitle,
  onHeightChange,
  scrollEdge,
  onShare,
  onEndSession,
  exitVariant = 'end',
}: RecordTopChromeProps) {
  const { t } = useTranslation('session');
  const { brandColors, systemColors, variant, radii } = useTheme();
  const nativeRootHeader = useNativeRootHeader();
  const glassCapability = useGlassCapability();
  const topBar = topBarFor(variant);
  const isLeaveExit = exitVariant === 'leave';
  const exitLabel = isLeaveExit ? t('queueBar.ariaLabels.leaveSession') : t('mobile.session.inEndSession');
  const exitActionLabel = isLeaveExit ? t('mobile.session.inLeave') : t('mobile.session.inStop');
  const exitTint = isLeaveExit ? systemColors.label : brandColors.error;
  const editLabel = t('mobile.session.editTitleAria');

  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  const exitAction = onEndSession ? (
    <PressableSurface
      onPress={onEndSession}
      feedback="opacity"
      rippleColor={exitTint as string}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={exitLabel}
      style={[
        styles.exitAction,
        { minHeight: nativeRootHeader ? NATIVE_ACTION_SIZE : TOP_ACTION_SIZE },
        isMaterial && { borderRadius: radii.button },
      ]}
    >
      <LargeContentViewer title={exitActionLabel} onActivate={onEndSession}>
        <Text
          variant="label"
          color={exitTint}
          numberOfLines={1}
          maxFontSizeMultiplier={topBar.labelMaxFontScale}
          style={styles.exitLabel}
        >
          {exitActionLabel}
        </Text>
      </LargeContentViewer>
    </PressableSurface>
  ) : null;

  if (isMaterial) {
    // Invite sits with the other trailing actions, so the title starts at the same
    // inset after the avatar as every other tab's.
    return (
      <MaterialTopAppBar onHeightChange={onHeightChange} scrollEdge={scrollEdge}>
        <UserAvatarToolbarAction variant="material" />
        <MaterialAppBarTitle
          title={title}
          onPress={onEditTitle}
          accessibilityHint={onEditTitle ? editLabel : undefined}
        />
        {onEditTitle ? (
          <Appbar.Action
            icon={iconMap.edit.android}
            color={systemColors.secondaryLabel as string}
            onPress={onEditTitle}
            accessibilityLabel={editLabel}
          />
        ) : null}
        {onShare ? (
          <Appbar.Action
            icon={iconMap['person.badge.plus'].android}
            color={systemColors.label as string}
            onPress={onShare}
            accessibilityLabel={t('mobile.session.invite')}
          />
        ) : null}
        {exitAction}
      </MaterialTopAppBar>
    );
  }

  const leftActions = (
    <GlassActionToolbar actionCount={onShare ? 2 : 1}>
      <UserAvatarToolbarAction variant="glass" />
      {onShare ? (
        <GlassToolbarAction onPress={onShare} accessibilityLabel={t('mobile.session.invite')}>
          <Icon maxFontSizeMultiplier={1} name="person.badge.plus" size={topBar.glyphSize} color={systemColors.label} />
        </GlassToolbarAction>
      ) : null}
    </GlassActionToolbar>
  );
  const rightActions =
    onEndSession || (nativeRootHeader && onEditTitle) ? (
      <View style={styles.rightActions}>
        {nativeRootHeader && onEditTitle ? (
          <GlassToolbarAction onPress={onEditTitle} accessibilityLabel={editLabel}>
            <Icon maxFontSizeMultiplier={1} name="edit" size={topBar.glyphSize} color={systemColors.label} />
          </GlassToolbarAction>
        ) : null}
        {exitAction}
      </View>
    ) : undefined;

  if (nativeRootHeader) {
    const rightItems: NativeStackNavigationOptions['unstable_headerRightItems'] = glassCapability
      ? () => {
          const items: ReturnType<NonNullable<NativeStackNavigationOptions['unstable_headerRightItems']>> = [];
          if (onEditTitle) {
            items.push({
              type: 'button',
              label: editLabel,
              icon: { type: 'sfSymbol', name: iconMap.edit.ios },
              variant: 'plain',
              onPress: onEditTitle,
              accessibilityLabel: editLabel,
            });
          }
          if (onEndSession) {
            items.push({
              type: 'button',
              label: exitActionLabel,
              variant: 'plain',
              labelStyle: { fontWeight: '600' },
              ...(isLeaveExit ? {} : { tintColor: brandColors.error }),
              onPress: onEndSession,
              accessibilityLabel: exitLabel,
            });
          }
          return items;
        }
      : undefined;
    return (
      <NativeRootHeader
        title={title}
        leftActions={leftActions}
        leftActionsStandalone={!onShare}
        rightActions={rightActions}
        rightItems={rightItems}
        onHeightChange={onHeightChange}
      />
    );
  }

  // The floating-header fallback keeps its one title in the scroll content.
  return (
    <CollapsingLargeTitleHeader leftActions={leftActions} rightActions={rightActions} onHeightChange={onHeightChange} />
  );
}

const styles = StyleSheet.create({
  rightActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  exitAction: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: glassSize.inline,
    paddingHorizontal: spacing[2],
    overflow: 'hidden',
  },
  exitLabel: {
    fontWeight: '600',
  },
});
