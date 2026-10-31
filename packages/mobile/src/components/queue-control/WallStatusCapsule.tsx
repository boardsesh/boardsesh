// The "On the wall" status capsule — surfaces the climb currently LIT on the
// physical board (when it differs from the user's own queue head, e.g. a teammate
// is driving the wall in a party session). It sits in the centre of the
// top-header islands row (iOS) / a slim band under the app bar (Android).
//
// Leads with the sender's avatar so the climb and whoever lit it are visible
// together. The avatar is inert here; the whole pill opens the wall preview,
// which retains the sender profile affordance. Anonymous senders use a person glyph.
//
// Two platform-native skins behind one stateful body (see selectByVariant below):
//   - Liquid Glass (iOS): one regular native-glass pill with a warm "lit" amber
//     tint. Older devices and Reduce Transparency retain the opaque pill.
//   - Material 3 (Android): a full-bleed titled status band — a tertiary accent
//     rail + an "On the wall" overline (the lit semantic stated in words and
//     carried by the tertiary colour role) + a bottom divider. No floating pill,
//     no border, no lightbulb (the bottom queue bar already owns that glyph).
// Both skins carry a trailing close button when given `onDismiss` (the pill drops
// it in compact mode, with the avatar). It hides this lighting only: see
// wall-strip-dismissal.ts.
// The data, grade derivation, tap handler and the debounced a11y announcement all
// live in the single body so a variant flip never resets the announce dedupe.
// Compact by design — the name truncates, the grade stays.

import { memo, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { useNativeGlass } from '../../hooks/use-native-glass';
import { spacing, borderRadius } from '../../theme/tokens';
import { withAlpha } from '../../theme/colors';
import { selectByVariant } from '../../theme/variants/select-by-variant';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { boardPresenceClimbToClimb } from '../../lib/board-presence/presence-climb';
import { LargeContentViewer } from '../LargeContentViewer';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { GlassSurface } from '../GlassSurface';
import { BoardDriverAvatar } from '../board-presence/BoardDriverAvatar';
import { useOpenWallPreview } from './use-open-wall-preview';
import { NativeHeaderActionContext, NativeTitleMaxWidthContext } from '../chrome/native-header-action-context';
import { NATIVE_ACTION_SIZE } from '../chrome/GlassActionToolbar';

const CAPSULE_HEIGHT = 32;
// The capsule's face: 18pt still reads as a face and leaves the truncating climb
// name more of UIKit's tight title slot. Fixed — does not scale with Dynamic Type.
const CAPSULE_AVATAR_SIZE = 18;
const CAPSULE_ANON_GLYPH = 16;
// The avatar → name → grade gap and the trailing inset, each 2pt under
// spacing[2] / spacing[3] so the name keeps more of the title slot. The spacing
// scale has no 6 or 10.
const CAPSULE_GAP = 6;
const CAPSULE_PADDING_END = 10;
// Under this title bound (a 320pt frame beside five bar slots leaves 58pt) the
// avatar would squeeze the name to nothing and clip the grade, so it drops out.
const CAPSULE_COMPACT_BELOW = 100;
// 20pt reads unambiguously as a face above M3's ~18dp floor in the Material band.
// Fixed — does not scale with Dynamic Type.
const BAND_AVATAR_SIZE = 20;
const ANON_GLYPH = 12;
// Material status band: a 4dp tertiary accent rail down the leading edge and a
// 56dp two-line body (overline + climb line) — already past the 48dp touch floor.
const BAND_RAIL_WIDTH = 4;
const BAND_MIN_HEIGHT = 56;
// The band's close button: a 48dp touch target (the M3 floor) at the trailing edge.
const BAND_CLOSE_SIZE = 48;
const BAND_CLOSE_GLYPH = 20;
// The pill's close glyph sits inside the 32pt pill; hit slop takes its target to 44pt.
const CAPSULE_CLOSE_GLYPH = 12;
const CAPSULE_CLOSE_HIT_SLOP = { top: 6, bottom: 6, left: 6, right: 10 };
// Debounce assistive-tech announcements so a fast party session (rapid wall
// changes) doesn't spam the speech queue.
const ANNOUNCE_DEBOUNCE_MS = 600;

type WallStatusCapsuleProps = {
  /** The wall's lit climb (already resolved as distinct from the queue head). */
  climb: BoardPresenceClimb;
  /** The board in scope, so the grade reads on its scale. The wall payload names no board. */
  boardName?: string | null;
  /** Close the strip for this lighting. No close button without it. */
  onDismiss?: () => void;
};

// memo'd so a ClimbTopChrome re-render (filter/board/search change) doesn't rebuild
// the capsule's hooks while the wall climb is unchanged — the `climb` prop is the
// stable BoardPresenceClimb from useWallClimbIfDistinct (changes only on a wall event).
function WallStatusCapsuleImpl({ climb, boardName, onDismiss }: WallStatusCapsuleProps) {
  const { t } = useTranslation('session');
  const { variant, colorScheme, systemColors, brandColors, m3, m3SurfaceContainers } = useTheme();
  const { resolveGrade } = useDisplayGrade();
  const reduceMotion = useReducedMotion();
  const openWallPreview = useOpenWallPreview();
  const nativeHeader = useContext(NativeHeaderActionContext);
  const titleMaxWidth = useContext(NativeTitleMaxWidthContext);
  const compact = titleMaxWidth != null && titleMaxWidth < CAPSULE_COMPACT_BELOW;
  const nativeGlass = useNativeGlass();

  const name = climb.name ?? '';
  // BoardPresenceClimb carries no Boardsesh grade today, so `resolveGrade` falls
  // back to the legacy label + colour — the capsule swaps to the Boardsesh grade
  // once the backend stamps presence climbs.
  const resolvedGrade = resolveGrade({ difficulty: climb.grade ?? '' }, boardName);
  const formattedGrade = climb.grade ? resolvedGrade.label : null;
  const gradeColor = resolvedGrade.color;
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

  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });

  if (isMaterial) {
    // The grade sits on the app-bar surface (the band body is transparent). In the
    // light scheme that surface is near-white, where bright hues (e.g. V0 #FFD400)
    // fail 4.5:1 — so wrap the grade in a neutral tonal pill there. Dark scheme keeps
    // bare text (already legible on the dark surface).
    const gradeNode = formattedGrade ? (
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
    ) : null;

    return (
      <Animated.View
        key={climbUuid}
        entering={reduceMotion ? undefined : FadeIn.duration(180)}
        style={[styles.bandOuter, { borderBottomColor: m3.outlineVariant }]}
      >
        <PressableSurface
          onPress={handlePress}
          // Android rides its native ripple; the iOS Material opt-in keeps it static.
          feedback="none"
          // Neutral M3 state layer — the warmth lives in the rail + overline.
          rippleColor={m3.onSurfaceVariant}
          accessibilityRole="button"
          accessibilityLabel={a11yLabel}
          accessibilityHint={t('mobile.boardPresence.stripA11yHint')}
          style={[styles.bandPressable, onDismiss && styles.bandPressableWithClose]}
        >
          {/* The "lit" accent: a tertiary rail down the leading edge. */}
          <View pointerEvents="none" style={[styles.bandRail, { backgroundColor: m3.tertiary }]} />
          <View style={styles.bandContent}>
            <Text
              variant="caption1"
              numberOfLines={1}
              // Truncate the trailing sender, never the protected "On the wall" prefix.
              ellipsizeMode="tail"
              maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
              style={[styles.bandOverline, { color: m3.tertiary }]}
            >
              {senderName
                ? t('mobile.boardPresence.stripOverlineWithSender', { sender: senderName })
                : t('mobile.boardPresence.stripOverline')}
            </Text>
            <View style={styles.bandMainRow}>
              {/* Inert + a11y-hidden so the band reads as one node (the profile tap
                  lives in the wall-preview sheet). `userId={null}` only suppresses the
                  avatar's own profile-link tap; the face still resolves from `uri`. */}
              <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                {hasSenderIdentity ? (
                  <BoardDriverAvatar
                    uri={climb.sentByAvatarUrl}
                    name={senderName}
                    userId={null}
                    size={BAND_AVATAR_SIZE}
                    status="none"
                  />
                ) : (
                  <View style={[styles.bandAnon, { backgroundColor: m3SurfaceContainers.highest }]}>
                    <Icon maxFontSizeMultiplier={1} name="profile.fill" size={ANON_GLYPH} color={m3.onSurfaceVariant} />
                  </View>
                )}
              </View>
              <LargeContentViewer title={a11yLabel} onActivate={handlePress} style={{ flex: 1 }}>
                <Text
                  variant="subheadline"
                  color={m3.onSurface}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
                  style={styles.bandName}
                >
                  {name}
                </Text>
              </LargeContentViewer>
              {gradeNode}
            </View>
          </View>
        </PressableSurface>
        {onDismiss ? (
          <PressableSurface
            onPress={onDismiss}
            feedback="none"
            rippleColor={m3.onSurfaceVariant}
            rippleBorderless
            accessibilityRole="button"
            accessibilityLabel={t('mobile.boardPresence.stripDismiss')}
            style={styles.bandClose}
          >
            <Icon name="close" size={BAND_CLOSE_GLYPH} color={m3.onSurfaceVariant} />
          </PressableSurface>
        ) : null}
      </Animated.View>
    );
  }

  const capsuleStyle = [
    styles.capsule,
    { backgroundColor: systemColors.secondaryBackground, borderColor: withAlpha(brandColors.warning, 0.35) },
  ];
  const capsuleContent = (
    <>
      {nativeGlass ? null : <View pointerEvents="none" style={glassTintStyle} />}
      <PressableSurface
        onPress={handlePress}
        feedback={nativeHeader ? 'none' : 'scale'}
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        accessibilityHint={t('mobile.boardPresence.stripA11yHint')}
        style={[styles.pressable, compact && styles.pressableCompact]}
      >
        {/* One tap target and one spoken label; profile navigation lives in the preview. */}
        {compact ? null : (
          <View
            style={styles.capsuleAvatar}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {hasSenderIdentity ? (
              <BoardDriverAvatar
                uri={climb.sentByAvatarUrl}
                name={senderName}
                userId={null}
                size={CAPSULE_AVATAR_SIZE}
                status="none"
              />
            ) : (
              <Icon
                maxFontSizeMultiplier={1}
                name="profile.fill"
                size={CAPSULE_ANON_GLYPH}
                color={brandColors.warning}
              />
            )}
          </View>
        )}
        <LargeContentViewer title={a11yLabel} onActivate={handlePress} style={styles.capsuleNameViewer}>
          <Text
            variant="caption1"
            color={systemColors.label}
            numberOfLines={1}
            ellipsizeMode="tail"
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={styles.name}
          >
            {name}
          </Text>
        </LargeContentViewer>
        {formattedGrade ? (
          <Text
            variant="caption1"
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={[styles.grade, { color: gradeColor }]}
          >
            {formattedGrade}
          </Text>
        ) : null}
        {onDismiss && !compact ? (
          <PressableSurface
            onPress={onDismiss}
            feedback="opacity"
            hitSlop={CAPSULE_CLOSE_HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.boardPresence.stripDismiss')}
            style={styles.capsuleClose}
          >
            <Icon
              maxFontSizeMultiplier={1}
              name="close"
              size={CAPSULE_CLOSE_GLYPH}
              color={systemColors.secondaryLabel}
            />
          </PressableSurface>
        ) : null}
      </PressableSurface>
    </>
  );

  // The native glass draws its own rounded edge. Opaque fills, RN borders and
  // clipping would cover or cut that lens, and opacity entry animations flatten it.
  const capsuleRadius = (nativeHeader ? NATIVE_ACTION_SIZE : CAPSULE_HEIGHT) / 2;
  const surface = nativeGlass ? (
    <GlassSurface
      glassEffectStyle="regular"
      tintColor={withAlpha(brandColors.warning, 0.14)}
      borderRadius={capsuleRadius}
      style={[styles.glassCapsule, nativeHeader ? styles.nativeGlassCapsule : null]}
    >
      {capsuleContent}
    </GlassSurface>
  ) : (
    capsuleContent
  );

  // UIKit owns this title view's layout and navigation transitions. A keyed
  // Reanimated entering transition can mutate it while the bar is laying out.
  if (nativeHeader) {
    return <View style={nativeGlass ? styles.glassWrapper : [capsuleStyle, styles.nativeCapsule]}>{surface}</View>;
  }

  if (nativeGlass) return <View style={styles.glassWrapper}>{surface}</View>;

  return (
    <Animated.View key={climbUuid} entering={reduceMotion ? undefined : FadeIn.duration(180)} style={capsuleStyle}>
      {capsuleContent}
    </Animated.View>
  );
}

export const WallStatusCapsule = memo(WallStatusCapsuleImpl);

const styles = StyleSheet.create({
  // --- Liquid Glass (iOS) ---
  glassWrapper: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '100%',
  },
  glassCapsule: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '100%',
    height: CAPSULE_HEIGHT,
  },
  nativeGlassCapsule: {
    height: NATIVE_ACTION_SIZE,
  },
  capsule: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '100%',
    height: CAPSULE_HEIGHT,
    borderRadius: CAPSULE_HEIGHT / 2,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  nativeCapsule: {
    height: NATIVE_ACTION_SIZE,
    borderRadius: NATIVE_ACTION_SIZE / 2,
  },
  capsuleAvatar: {
    flexShrink: 0,
  },
  capsuleNameViewer: {
    // A flex:1 label has zero intrinsic width in a UIKit navigation title view.
    flexShrink: 1,
    minWidth: 0,
  },
  pressable: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    height: '100%',
    paddingStart: spacing[1],
    paddingEnd: CAPSULE_PADDING_END,
    gap: CAPSULE_GAP,
  },
  // Without the avatar the name starts at the trailing inset, so the text sits evenly.
  pressableCompact: {
    paddingStart: CAPSULE_PADDING_END,
  },
  name: {
    flexShrink: 1,
    minWidth: 0,
    fontWeight: '600',
  },
  capsuleClose: {
    flexShrink: 0,
  },
  grade: {
    flexShrink: 0,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  // --- Material 3 status band (Android) ---
  bandOuter: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bandPressable: {
    flex: 1,
    minHeight: BAND_MIN_HEIGHT,
    justifyContent: 'center',
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[4],
  },
  bandPressableWithClose: {
    paddingEnd: 0,
  },
  bandClose: {
    width: BAND_CLOSE_SIZE,
    height: BAND_CLOSE_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    marginEnd: spacing[1],
  },
  bandRail: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: BAND_RAIL_WIDTH,
  },
  bandContent: {
    gap: 2,
  },
  bandOverline: {
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  bandMainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  bandName: {
    flex: 1,
    minWidth: 0,
    fontWeight: '500',
  },
  bandAnon: {
    width: BAND_AVATAR_SIZE,
    height: BAND_AVATAR_SIZE,
    borderRadius: BAND_AVATAR_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gradePill: {
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing[1],
    justifyContent: 'center',
  },
});
