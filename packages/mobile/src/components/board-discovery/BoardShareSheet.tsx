import { useCallback } from 'react';
import { Share, StyleSheet, View } from 'react-native';
import { ModalSheet } from '../ModalSheet';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { Text } from '../Text';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { SheetTopBar } from '../SheetTopBar';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { hapticSelection } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';
import type { SprayWallVisibility } from '../../lib/spray/spray-share';

/**
 * What the link grants. A private wall or an Only-me board never reaches this
 * sheet. `invite` is a Followers or Invite-only home board's tokened link:
 * whoever opens it can choose Join to become a member.
 */
export type BoardShareVisibility = Exclude<SprayWallVisibility, 'private'> | 'invite';

type BoardShareSheetProps = {
  visible: boolean;
  onDismiss: () => void;
  onFullyDismissed?: () => void;
  /**
   * The share URL, already built. `null` only while an invite link is on its
   * way from the server, or could not be fetched (`linkFailed`).
   */
  shareUrl: string | null;
  /** The wall's or board's name. */
  wallName: string;
  visibility: BoardShareVisibility;
  /** A spray wall (the default) or a home board: the two say different things. */
  subject?: 'wall' | 'board';
  /** The invite link could not be fetched. */
  linkFailed?: boolean;
  /** Offered for an invite link: revoke it and mint a new one. The caller confirms first. */
  onResetLink?: () => void;
  resettingLink?: boolean;
};

const QR_SIZE = 200;
// QR codes need a light background to scan reliably, even in dark mode — this is
// the one place a hardcoded white is correct (it's the scannable surface, not
// themeable chrome).
const QR_TILE_BACKGROUND = '#FFFFFF';

/**
 * Hand a wall's or a home board's link to the crew — QR to scan at the wall,
 * copy and share for everywhere else.
 *
 * Modelled on `InviteSheet`: both use the shared modal coordinator, so
 * the two never fight over a native transition. The one line of copy under the
 * title is the important part — an unlisted link is a capability, a public
 * wall is on the open web, and a home board's invite link lets whoever opens it
 * choose to join; those are different promises. Only an invite link has a Reset: it is
 * the one that grants something, so it is the one an owner needs to retire.
 */
export function BoardShareSheet({
  visible,
  onDismiss,
  onFullyDismissed,
  shareUrl,
  wallName,
  visibility,
  subject = 'wall',
  linkFailed = false,
  onResetLink,
  resettingLink = false,
}: BoardShareSheetProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const { showToast } = useToast();

  const handleCopyLink = useCallback(() => {
    if (!shareUrl) return;
    hapticSelection();
    void Clipboard.setStringAsync(shareUrl).then(() => {
      showToast(t('mobile.sprayShare.copied'), 'success');
    });
  }, [shareUrl, showToast, t]);

  const handleShare = useCallback(() => {
    if (!shareUrl) return;
    hapticSelection();
    void Share.share({ message: shareUrl, url: shareUrl });
  }, [shareUrl]);

  const title = subject === 'board' ? t('mobile.boardShare.title') : t('mobile.sprayShare.title');
  const body = shareBody(subject, visibility, t);

  return (
    <ModalSheet
      visible={visible}
      onClose={onDismiss}
      onFullyDismissed={onFullyDismissed}
      snapPoints={MEDIUM_LARGE_SNAP_POINTS}
      scrollable
      contentContainerStyle={styles.content}
      header={<SheetTopBar title={title} leading={{ kind: 'close', onPress: onDismiss }} />}
    >
      <Text variant="body" color={systemColors.label} style={styles.wallName} numberOfLines={2}>
        {wallName}
      </Text>
      {/* Full label colour, not secondary: on the glass sheet the grey body
          and URL were hard to read (#5960). */}
      <Text variant="footnote" color={systemColors.label} style={styles.subtitle}>
        {body}
      </Text>

      {shareUrl ? (
        <>
          <View
            style={styles.qrTile}
            accessibilityRole="image"
            accessibilityLabel={t('mobile.sprayShare.qrLabel', { name: wallName })}
          >
            <QRCode value={shareUrl} size={QR_SIZE} backgroundColor={QR_TILE_BACKGROUND} />
          </View>

          <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={2} style={styles.url}>
            {shareUrl}
          </Text>
        </>
      ) : (
        <View style={styles.qrPlaceholder}>
          {linkFailed ? (
            <Text
              variant="footnote"
              color={systemColors.secondaryLabel}
              style={styles.subtitle}
              accessibilityRole="alert"
            >
              {t('mobile.boardShare.loadFailed')}
            </Text>
          ) : (
            <ActivityIndicator size="large" accessibilityLabel={t('mobile.boardShare.loading')} />
          )}
        </View>
      )}

      {/* Content actions, not a form confirm: they stay in the body, one
          full-width row (stacked they would overflow the medium detent). */}
      <View style={styles.actions}>
        <Button
          title={t('mobile.sprayShare.copyLink')}
          icon="copy"
          variant="outlined"
          onPress={handleCopyLink}
          disabled={!shareUrl}
          style={styles.button}
        />
        <Button
          title={t('mobile.sprayShare.share')}
          icon="share"
          onPress={handleShare}
          disabled={!shareUrl}
          style={styles.button}
        />
      </View>
      {onResetLink ? (
        <Button
          title={t('mobile.boardShare.resetLink')}
          icon="refresh"
          variant="text"
          onPress={onResetLink}
          disabled={resettingLink || (!shareUrl && !linkFailed)}
          loading={resettingLink}
          style={styles.resetButton}
        />
      ) : null}
    </ModalSheet>
  );
}

type TFn = ReturnType<typeof useTranslation>['t'];

/** The one line under the name: what opening this link does, in words. */
function shareBody(subject: 'wall' | 'board', visibility: BoardShareVisibility, t: TFn): string {
  if (subject === 'wall') {
    return visibility === 'public' ? t('mobile.sprayShare.publicBody') : t('mobile.sprayShare.unlistedBody');
  }
  if (visibility === 'invite') return t('mobile.boardShare.inviteBody');
  return visibility === 'public' ? t('mobile.boardShare.publicBody') : t('mobile.boardShare.unlistedBody');
}

const styles = StyleSheet.create({
  content: {
    alignItems: 'center',
    paddingHorizontal: spacing[6],
    paddingTop: spacing[4],
    paddingBottom: spacing[4],
    gap: spacing[2],
  },
  wallName: {
    textAlign: 'center',
    fontWeight: '600',
  },
  subtitle: {
    textAlign: 'center',
    lineHeight: 18,
  },
  qrTile: {
    backgroundColor: QR_TILE_BACKGROUND,
    padding: spacing[4],
    borderRadius: borderRadius.lg,
    marginVertical: spacing[2],
  },
  // Holds the QR tile's footprint while the invite link loads, so the sheet
  // does not jump when it arrives.
  qrPlaceholder: {
    width: QR_SIZE + spacing[4] * 2,
    height: QR_SIZE + spacing[4] * 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: spacing[2],
  },
  url: {
    textAlign: 'center',
    // Breathing room above the buttons; the URL sat right against them.
    marginBottom: spacing[3],
  },
  actions: {
    flexDirection: 'row',
    gap: spacing[3],
    alignSelf: 'stretch',
    marginTop: spacing[2],
  },
  button: {
    flex: 1,
  },
  resetButton: {
    alignSelf: 'center',
  },
});
