// The "On the wall" status capsule — a compact pill that surfaces the climb
// currently LIT on the physical board (when it differs from the user's own queue
// head, e.g. a teammate is driving the wall in a party session). It sits in the
// centre of the top-header islands row (iOS) / a slim row under the app bar
// (Android) — the home for "what's lit right now" that the bottom queue accessory
// used to overload.
//
// Leads with the SENDER's avatar (whoever sent the climb to the board), so the
// capsule answers "who lit it + what's lit" at a glance — the core party-session
// signal a lightbulb never carried. The avatar is INERT here (one Pressable opens
// the read-only wall preview; the tap-sender-to-profile affordance lives in that
// preview sheet, which has room for a full target). Fully-anonymous senders fall
// back to an amber person glyph — never a bare lightbulb (a bistable leading slot
// breaks the visual scan + VoiceOver grammar) and never a literal "?".
//
// Two platform-native skins behind one stateful body (see selectByVariant below):
//   - Liquid Glass (iOS): a NON-glass pill (HIG: no glass-on-glass over the
//     header's progressive blur) with a warm "lit" amber border + tint.
//   - Material 3 (Android): an elevated assist chip — 8dp corner, level1
//     elevation, surfaceContainer.high tonal fill, NO border. The "lit" warmth is
//     carried the M3-native way through the tertiary colour role (a tonal wash, an
//     amber avatar ring, and a filled-lightbulb badge), not a drawn border.
// The data, grade derivation, tap handler and the debounced a11y announcement all
// live in the single body so a variant flip never resets the announce dedupe.
// Compact by design — the name truncates, the grade stays.

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { useTheme } from '../../providers/theme-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { spacing, borderRadius } from '../../theme/tokens';
import { withAlpha } from '../../theme/colors';
import { selectByVariant } from '../../theme/variants/select-by-variant';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { boardPresenceClimbToClimb } from '../../lib/board-presence/presence-climb';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { BoardDriverAvatar } from '../board-presence/BoardDriverAvatar';
import { useOpenWallPreview } from './use-open-wall-preview';

const CAPSULE_HEIGHT = 32;
// 20pt reads unambiguously as a face above M3's ~18dp floor while protecting the
// truncating climb name in the tight centre slot (M3 would prefer 24; default to
// 20). Fixed — does not scale with Dynamic Type.
const AVATAR_SIZE = 20;
// Material "lit" cue, carried by the tertiary role: a thin amber ring hugs the
// avatar and a filled-lightbulb badge sits in its bottom-trailing corner.
const AVATAR_RING_WIDTH = 1.5;
const LIT_LEADING_SIZE = AVATAR_SIZE + AVATAR_RING_WIDTH * 2;
const LIT_BADGE_SIZE = 14;
const LIT_BADGE_GLYPH = 9;
const ANON_GLYPH = 12;
// 8pt all-round hit expansion lifts the 32pt visual chip to a >=48pt M3 touch
// target without growing the chip itself.
const MATERIAL_HIT_SLOP = spacing[2];
// Debounce assistive-tech announcements so a fast party session (rapid wall
// changes) doesn't spam the speech queue.
const ANNOUNCE_DEBOUNCE_MS = 600;

type WallStatusCapsuleProps = {
  /** The wall's lit climb (already resolved as distinct from the queue head). */
  climb: BoardPresenceClimb;
};

// memo'd so a ClimbTopChrome re-render (filter/board/search change) doesn't rebuild
// the capsule's hooks while the wall climb is unchanged — the `climb` prop is the
// stable BoardPresenceClimb from useWallClimbIfDistinct (changes only on a wall event).
function WallStatusCapsuleImpl({ climb }: WallStatusCapsuleProps) {
  const { t } = useTranslation('session');
  const { variant, colorScheme, systemColors, brandColors, m3, m3SurfaceContainers, materialElevation } = useTheme();
  const { formatGrade } = useGradeFormat();
  const reduceMotion = useReducedMotion();
  const openWallPreview = useOpenWallPreview();

  const name = climb.name ?? '';
  const formattedGrade = formatGrade(climb.grade ?? '');
  const gradeColor = getGradeColor(climb.grade ?? '') ?? DEFAULT_GRADE_COLOR;
  const senderName = climb.sentByDisplayName?.trim() || null;
  const hasSenderIdentity = climb.sentByAvatarUrl != null || senderName != null;

  const a11yLabel = senderName
    ? t('mobile.boardPresence.stripA11yLabelWithSender', { name, grade: formattedGrade ?? '', sender: senderName })
    : t('mobile.boardPresence.stripA11yLabel', { name, grade: formattedGrade ?? '' });

  // Announce peer-driven changes the user didn't initiate (debounced + de-duped on
  // the climb's uuid so a re-render doesn't re-announce the same climb). Done
  // explicitly rather than via accessibilityLiveRegion, because the capsule remounts
  // on each climb change (keyed Animated.View) — a fresh node has no "content
  // change" for a live region to catch.
  const announceLabel = senderName
    ? t('mobile.boardPresence.stripAnnounceWithSender', { name, grade: formattedGrade ?? '', sender: senderName })
    : t('mobile.boardPresence.stripAnnounce', { name, grade: formattedGrade ?? '' });
  const climbUuid = climb.climbUuid;
  // De-dupe on the announced TEXT, not the uuid: a re-render with an unchanged label
  // shouldn't re-announce, but a locale switch (same climb, new label) should.
  const lastAnnouncedRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastAnnouncedRef.current === announceLabel) return;
    const handle = setTimeout(() => {
      lastAnnouncedRef.current = announceLabel;
      AccessibilityInfo.announceForAccessibility(announceLabel);
    }, ANNOUNCE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [announceLabel]);

  const handlePress = useCallback(() => openWallPreview(boardPresenceClimbToClimb(climb)), [openWallPreview, climb]);

  // Glass: a warm amber tint composited over the neutral surface = the "lit" carrier.
  const glassTintStyle = useMemo(
    () => [StyleSheet.absoluteFill, { backgroundColor: withAlpha(brandColors.warning, 0.14) }],
    [brandColors.warning],
  );
  // Material: a tertiary tonal wash = the M3-native "lit" accent (no border).
  const materialWashStyle = useMemo(
    () => [StyleSheet.absoluteFill, { backgroundColor: withAlpha(m3.tertiary, 0.1) }],
    [m3.tertiary],
  );

  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });

  if (isMaterial) {
    return (
      <Animated.View
        key={climbUuid}
        entering={reduceMotion ? undefined : FadeIn.duration(180)}
        // Outer carries the tonal fill + the level1 elevation cast — NO
        // overflow:'hidden' here, or Android would clip the shadow.
        style={[styles.materialOuter, { backgroundColor: m3SurfaceContainers.high }, materialElevation.level1]}
      >
        <PressableSurface
          onPress={handlePress}
          // Android rides its native ripple; the iOS Material opt-in keeps it static.
          feedback="none"
          // Neutral M3 state layer — the warmth already lives in the fill + ring,
          // so a tertiary-tinted ripple would over-warm the press.
          rippleColor={m3.onSurfaceVariant}
          hitSlop={MATERIAL_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={a11yLabel}
          accessibilityHint={t('mobile.boardPresence.stripA11yHint')}
          // borderRadius + overflow:'hidden' clips the ripple AND the wash to the
          // 8dp corner; the cast still escapes via the un-clipped outer.
          style={styles.materialPressable}
        >
          <View pointerEvents="none" style={materialWashStyle} />
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.litLeading}>
            {hasSenderIdentity ? (
              <>
                <View style={[styles.avatarRing, { borderColor: m3.tertiary }]}>
                  <BoardDriverAvatar
                    uri={climb.sentByAvatarUrl}
                    name={senderName}
                    userId={null}
                    size={AVATAR_SIZE}
                    status="none"
                  />
                </View>
                <View
                  style={[styles.litBadge, { backgroundColor: m3.tertiary, borderColor: m3SurfaceContainers.high }]}
                >
                  <Icon name="lightbulb.fill" size={LIT_BADGE_GLYPH} color={m3.onTertiary} />
                </View>
              </>
            ) : (
              <View style={[styles.anonLit, { backgroundColor: m3.tertiary }]}>
                <Icon name="profile.fill" size={ANON_GLYPH} color={m3.onTertiary} />
              </View>
            )}
          </View>
          <Text
            variant="subheadline"
            color={m3.onSurface}
            numberOfLines={1}
            ellipsizeMode="tail"
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={styles.materialName}
          >
            {name}
          </Text>
          {formattedGrade ? (
            // Light scheme: a neutral surfaceContainer.highest backdrop keeps the
            // bright grade hues (e.g. V0 #FFD400) legible. Dark scheme: bare text
            // already clears 4.5:1 on the dark tonal fill.
            colorScheme === 'light' ? (
              <View style={[styles.gradePill, { backgroundColor: m3SurfaceContainers.highest }]}>
                <Text
                  variant="subheadline"
                  numberOfLines={1}
                  maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
                  style={[styles.grade, { color: gradeColor }]}
                >
                  {formattedGrade}
                </Text>
              </View>
            ) : (
              <Text
                variant="subheadline"
                numberOfLines={1}
                maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
                style={[styles.grade, { color: gradeColor }]}
              >
                {formattedGrade}
              </Text>
            )
          ) : null}
        </PressableSurface>
      </Animated.View>
    );
  }

  // Liquid Glass (iOS) — the original non-glass amber pill, unchanged.
  return (
    <Animated.View
      // Fades IN on mount and on each wall-climb change (keyed remount). Removal is
      // an instant cut — Reanimated can't reliably intercept an `exiting` whose
      // wrapping parent unmounts in the same commit (the Material under-app-bar row),
      // so we don't promise a fade-out the layout can't deliver.
      key={climbUuid}
      entering={reduceMotion ? undefined : FadeIn.duration(180)}
      style={[
        styles.capsule,
        { backgroundColor: systemColors.secondaryBackground, borderColor: withAlpha(brandColors.warning, 0.35) },
      ]}
    >
      <View pointerEvents="none" style={glassTintStyle} />
      <Pressable
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        accessibilityHint={t('mobile.boardPresence.stripA11yHint')}
        style={styles.pressable}
      >
        {/* The sender, leading. Inert + a11y-hidden so the pill reads as one node
            (the profile tap lives in the wall-preview sheet). `userId={null}` is
            deliberate — it only suppresses the avatar's own profile-link tap; the
            face still resolves from `sentByAvatarUrl` (Avatar renders the image off
            `uri`, not `userId`), so this never degrades a known sender's photo. A
            sender with only a userId (no photo, no display name) has nothing
            renderable as a face/monogram, so it correctly takes the person glyph. */}
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {hasSenderIdentity ? (
            <BoardDriverAvatar
              uri={climb.sentByAvatarUrl}
              name={senderName}
              userId={null}
              size={AVATAR_SIZE}
              status="none"
            />
          ) : (
            <Icon name="profile.fill" size={18} color={brandColors.warning} />
          )}
        </View>
        <Text
          variant="footnote"
          color={systemColors.label}
          numberOfLines={1}
          ellipsizeMode="tail"
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          style={styles.name}
        >
          {name}
        </Text>
        {formattedGrade ? (
          <Text
            variant="footnote"
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={[styles.grade, { color: gradeColor }]}
          >
            {formattedGrade}
          </Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

export const WallStatusCapsule = memo(WallStatusCapsuleImpl);

const styles = StyleSheet.create({
  // --- Liquid Glass (iOS) ---
  capsule: {
    flexShrink: 1,
    maxWidth: '100%',
    height: CAPSULE_HEIGHT,
    borderRadius: CAPSULE_HEIGHT / 2,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  pressable: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    height: '100%',
    paddingLeft: spacing[1],
    paddingRight: spacing[3],
    gap: spacing[2],
  },
  name: {
    flexShrink: 1,
    minWidth: 0,
    fontWeight: '600',
  },
  grade: {
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  // --- Material 3 (Android) ---
  materialOuter: {
    flexShrink: 1,
    maxWidth: '100%',
    borderRadius: borderRadius.md,
  },
  materialPressable: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    height: CAPSULE_HEIGHT,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
    paddingLeft: spacing[2],
    paddingRight: spacing[3],
    gap: spacing[2],
  },
  materialName: {
    flexShrink: 1,
    minWidth: 0,
    fontWeight: '500',
  },
  gradePill: {
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing[1],
    justifyContent: 'center',
  },
  litLeading: {
    position: 'relative',
    width: LIT_LEADING_SIZE,
    height: LIT_LEADING_SIZE,
  },
  avatarRing: {
    width: LIT_LEADING_SIZE,
    height: LIT_LEADING_SIZE,
    borderRadius: LIT_LEADING_SIZE / 2,
    borderWidth: AVATAR_RING_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  litBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: LIT_BADGE_SIZE,
    height: LIT_BADGE_SIZE,
    borderRadius: LIT_BADGE_SIZE / 2,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  anonLit: {
    width: LIT_LEADING_SIZE,
    height: LIT_LEADING_SIZE,
    borderRadius: LIT_LEADING_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
