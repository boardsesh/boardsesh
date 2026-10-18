import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

// MARK: - Thumbnail Helper

func loadThumbnail(climbUuid: String) -> UIImage? {
    guard let containerURL = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: SharedConstants.appGroupId
    ) else { return nil }
    // ThumbnailFetcher (main-app process) caches per render mode; resolve the
    // saved look the same way so the widget reads the file the fetcher wrote.
    let renderMode = SharedBoardRenderMode.resolve(from: SharedConstants.sharedDefaults)
    let fileName = SharedBoardRenderMode.thumbnailFileName(climbUuid: climbUuid, renderMode: renderMode)
    let path = containerURL.appendingPathComponent("thumbnails/\(fileName)")
    guard let data = try? Data(contentsOf: path) else { return nil }
    return UIImage(data: data)
}

// MARK: - Velvet Send Design Tokens

/// Velvet Send palette + spacing/radius tokens, translated from the mobile
/// design system (docs/ai-design-guidelines.md). Colours resolve per
/// @Environment(\.colorScheme) through `Palette.resolve(_:)`. Keep the lock
/// screen and Dynamic Island chrome on these tokens — no ad-hoc Color literals.
///
/// Colour discipline (set by the design panel): amber is sacred to the lit bulb
/// (the one thing that glows); violet (tint) carries identity, the grade's
/// fallback and a running rest; red only ever means "over your rest"; gray
/// carries plain metadata. Nothing else competes.
enum VelvetSend {
    /// 8-bit hex helper, e.g. `VelvetSend.hex(0xFF, 0x8A, 0x3D)`.
    static func hex(_ red: Int, _ green: Int, _ blue: Int) -> Color {
        Color(
            red: Double(red) / 255.0,
            green: Double(green) / 255.0,
            blue: Double(blue) / 255.0
        )
    }

    struct Palette {
        let tint: Color
        let primaryFill: Color
        let onPrimary: Color
        /// Amber accent — reserved (no longer used on this surface; amber lives
        /// only on the lit bulb's `warning`). Kept for token completeness.
        let accent: Color
        let onAccent: Color
        /// Drives the lit-bulb glyph + glow — the only amber on the card.
        let warning: Color
        /// A rest that has run past its length — the app's red overrun digits.
        let error: Color
        let background: Color
        let elevatedSurface: Color
        let label: Color
        let secondaryLabel: Color
        let tertiaryLabel: Color
        let separator: Color

        static func resolve(_ scheme: ColorScheme) -> Palette {
            let dark = scheme == .dark
            // Qualified `VelvetSend.hex` — a nested type can't see the enclosing
            // enum's static members by unqualified name.
            return Palette(
                tint: dark ? VelvetSend.hex(0xA7, 0x8B, 0xFA) : VelvetSend.hex(0x6D, 0x28, 0xD9),
                primaryFill: dark ? VelvetSend.hex(0x7C, 0x3A, 0xED) : VelvetSend.hex(0x6D, 0x28, 0xD9),
                onPrimary: VelvetSend.hex(0xFF, 0xFF, 0xFF),
                accent: VelvetSend.hex(0xFF, 0x8A, 0x3D),
                onAccent: VelvetSend.hex(0x16, 0x11, 0x1F),
                warning: dark ? VelvetSend.hex(0xFB, 0xBF, 0x24) : VelvetSend.hex(0xB4, 0x53, 0x09),
                // #F87171 on the dark surface; #B91C1C keeps AA contrast on the
                // light one.
                error: dark ? VelvetSend.hex(0xF8, 0x71, 0x71) : VelvetSend.hex(0xB9, 0x1C, 0x1C),
                background: dark ? VelvetSend.hex(0x0F, 0x0B, 0x16) : VelvetSend.hex(0xF4, 0xF1, 0xFB),
                elevatedSurface: dark ? VelvetSend.hex(0x22, 0x1A, 0x32) : VelvetSend.hex(0xFF, 0xFF, 0xFF),
                label: dark ? VelvetSend.hex(0xF5, 0xF2, 0xFB) : VelvetSend.hex(0x16, 0x11, 0x1F),
                secondaryLabel: dark ? VelvetSend.hex(0xA9, 0xA2, 0xB6) : VelvetSend.hex(0x5B, 0x55, 0x63),
                tertiaryLabel: dark ? VelvetSend.hex(0x6E, 0x68, 0x7C) : VelvetSend.hex(0x8E, 0x88, 0x98),
                separator: dark
                    ? Color(red: 180 / 255, green: 168 / 255, blue: 205 / 255).opacity(0.2)
                    : Color(red: 60 / 255, green: 55 / 255, blue: 75 / 255).opacity(0.18)
            )
        }
    }

    enum Spacing {
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 12
        static let lg: CGFloat = 16
        static let xl: CGFloat = 20
        static let xxl: CGFloat = 24
        /// The HIG's standard Lock Screen Live Activity margin ("The standard
        /// layout margin for Live Activities on the Lock Screen is 14 points"),
        /// which lines the card up with notifications.
        static let lockScreenMargin: CGFloat = 14
    }

    enum Radius {
        static let md: CGFloat = 8
        static let lg: CGFloat = 12
        static let xl: CGFloat = 16
    }

    enum Opacity {
        static let subtle: Double = 0.7
        static let disabled: Double = 0.5
        /// Soft amber glow under the lit bulb — a whisper, not a neon.
        static let litGlowShadow: Double = 0.24
        /// Tinted circle behind the mirror button while the climb is mirrored.
        static let selectedFill: Double = 0.18
    }
}

// MARK: - Grade Colours

/// Resolve a SwiftUI Color from a "#RRGGBB" hex string.
extension Color {
    init?(velvetHex hex: String) {
        var raw = hex
        if raw.hasPrefix("#") { raw.removeFirst() }
        guard raw.count == 6, let value = UInt32(raw, radix: 16) else { return nil }
        self = Color(
            red: Double((value >> 16) & 0xFF) / 255.0,
            green: Double((value >> 8) & 0xFF) / 255.0,
            blue: Double(value & 0xFF) / 255.0
        )
    }
}

/// V-grade -> brand grade-band colour (the punchy yellow->red->purple arc).
/// Ported byte-for-byte from packages/board-constants/src/grade-colors.ts
/// (`V_GRADE_COLORS`) and kept in sync by `grade-colors-ios-parity.test.ts` — the
/// widget is native Swift and can't import the TS table, so this mirror is the
/// source of grade colour on the lock screen + Dynamic Island.
enum GradeColors {
    static let table: [String: String] = [
        "V0": "#FFD400",
        "V1": "#FFB300",
        "V2": "#FF9100",
        "V3": "#FF6D2E",
        "V4": "#FF5026",
        "V5": "#F03E3E",
        "V6": "#E22A2A",
        "V7": "#CF1F3C",
        "V8": "#B81A5A",
        "V9": "#9E1A78",
        "V10": "#7E1C8E",
        "V11": "#9C27B0",
        "V12": "#7B1FA2",
        "V13": "#6A1B9A",
        "V14": "#5C1A87",
        "V15": "#4A148C",
        "V16": "#38006B",
        "V17": "#2A0054",
    ]

    /// Colour for a formatted V-grade ("V5", "V5+"); strips a trailing "+" to
    /// match `getVGradeColor`. Returns nil when the grade isn't a known V-grade.
    static func color(forVGrade vGrade: String) -> Color? {
        let key = vGrade.hasSuffix("+") ? String(vGrade.dropLast()) : vGrade
        guard let hex = table[key] else { return nil }
        return Color(velvetHex: hex)
    }
}

// MARK: - Board Connection State

/// Effective board-connection state from THIS device's perspective. Resolved
/// per render in `resolveState(...)` so the layout (and the lightbulb) always
/// reflect the most authoritative source available.
enum BoardConnection {
    case connectedByMe
    case heldByPeer
    case disconnected

    /// Maps the wire string used by `ContentState.boardConnection` / the App
    /// Group mirror. Unknown / nil values return nil so callers can fall
    /// through to the next source.
    static func from(string raw: String?) -> BoardConnection? {
        guard let raw else { return nil }
        switch raw {
        case "connectedByMe": return .connectedByMe
        case "heldByPeer": return .heldByPeer
        case "disconnected": return .disconnected
        default: return nil
        }
    }
}

/// Resolved render state: the effective connection plus the holder name (only
/// meaningful for `.heldByPeer`).
struct ResolvedBoardState {
    let connection: BoardConnection
    let holderDisplayName: String?
}

/// Orientation and queue slot for the mirror button, pushed state first with
/// the committed App Group snapshot behind it — the same two-step
/// `supportsMirroring` already uses.
///
/// The fallback matters because a content state that predates these fields, or
/// a push that never lands, would otherwise leave the button labelled for the
/// old orientation. Mirroring is an absolute write, so a stale label makes the
/// next tap send the opposite orientation and undo the flip.
@available(iOS 17.0, *)
private func resolveMirrorState(
    context: ActivityViewContext<ClimbSessionAttributes>
) -> (queueItemUuid: String?, mirrored: Bool) {
    let committed = SharedConstants.sharedDefaults.flatMap { SharedQueueState.currentItem(from: $0) }
    return (
        queueItemUuid: context.state.queueItemUuid ?? committed?.uuid,
        mirrored: context.state.mirrored ?? committed?.mirrored ?? false
    )
}

@available(iOS 17.0, *)
private func resolveBoardState(
    context: ActivityViewContext<ClimbSessionAttributes>
) -> ResolvedBoardState {
    // App Group mirror is read once and reused for both the connection
    // fallback and the holder-name fallback.
    let appGroup: (boardConnection: String?, holderDisplayName: String?)
    if let defaults = SharedConstants.sharedDefaults {
        appGroup = SharedWidgetWallControlState.loadBoardConnection(from: defaults)
    } else {
        appGroup = (nil, nil)
    }

    let connection: BoardConnection
    if let pushed = BoardConnection.from(string: context.state.boardConnection) {
        // 1. Authoritative pushed state (arrives via APNs when backgrounded).
        connection = pushed
    } else if let mirrored = BoardConnection.from(string: appGroup.boardConnection) {
        // 2. App Group mirror written by the foreground app / intents.
        connection = mirrored
    } else {
        // 3. Derive from navigationAllowed; default preserves today's behaviour.
        connection = WallControlViewState.current().navigationAllowed
            ? .connectedByMe
            : .heldByPeer
    }

    // Prefer the pushed holder name, fall back to the App Group mirror.
    let holderDisplayName = context.state.holderDisplayName ?? appGroup.holderDisplayName

    return ResolvedBoardState(connection: connection, holderDisplayName: holderDisplayName)
}

/// The rest timer at this render, or nil when there is none to show. Read from
/// the App Group only — never from the pushed state, which the backend and the
/// native builders rebuild without it (see `SharedConstants.restTimerKey`).
/// Evaluated when ActivityKit renders, so "past the deadline" is decided here;
/// between renders only the self-updating timer views move.
@available(iOS 17.0, *)
private func resolveRestTimer(
    context: ActivityViewContext<ClimbSessionAttributes>,
    now: Date = Date()
) -> ResolvedRestTimer? {
    guard let defaults = SharedConstants.sharedDefaults else { return nil }
    return ResolvedRestTimer.resolve(
        state: SharedRestTimerStore.load(from: defaults),
        sessionId: context.attributes.sessionId,
        now: now
    )
}

// MARK: - Shared Subviews

@available(iOS 17.0, *)
private struct ThumbnailView: View {
    @Environment(\.colorScheme) private var colorScheme
    let climbUuid: String
    var mirrored: Bool = false
    let width: CGFloat
    let height: CGFloat

    var body: some View {
        let palette = VelvetSend.Palette.resolve(colorScheme)
        if let image = loadThumbnail(climbUuid: climbUuid) {
            // The clipShape already gives the photo its rounded silhouette — no
            // hairline needed on real board art (keeps it cleaner / sleeker).
            Image(uiImage: image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .scaleEffect(x: mirrored ? -1 : 1, y: 1)
                .frame(width: width, height: height)
                .clipShape(RoundedRectangle(cornerRadius: VelvetSend.Radius.lg, style: .continuous))
        } else {
            // The placeholder needs the outline to read as a rounded card.
            RoundedRectangle(cornerRadius: VelvetSend.Radius.lg, style: .continuous)
                .fill(palette.tint.opacity(0.12))
                .frame(width: width, height: height)
                .overlay(
                    Image(systemName: "mountain.2.fill")
                        .font(.system(size: min(width, height) * 0.4))
                        .foregroundColor(palette.tint.opacity(VelvetSend.Opacity.subtle))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: VelvetSend.Radius.lg, style: .continuous)
                        .strokeBorder(palette.separator, lineWidth: 0.5)
                )
        }
    }
}

/// The grade as a bold numeral in its grade-band colour — never a chip/pill
/// (no fill). The heaviest type on the card; weight carries primacy.
@available(iOS 17.0, *)
private struct GradeText: View {
    @Environment(\.colorScheme) private var colorScheme
    let text: String
    var font: Font = .title2.weight(.heavy)

    var body: some View {
        let palette = VelvetSend.Palette.resolve(colorScheme)
        // Normalise first: the backend push carries the raw "6a/V3" while the
        // native paths send "V3", and only the latter has a band colour.
        let grade = VGradeFormatter.displayGrade(text)
        // Real grade-band colour (yellow->red->purple); violet tint as a fallback
        // for any unmapped grade string.
        let gradeColor = GradeColors.color(forVGrade: grade) ?? palette.tint
        Text(verbatim: grade)
            .font(font)
            .foregroundColor(gradeColor)
            .monospacedDigit()
            .fixedSize()
            .accessibilityLabel("Grade \(grade)")
    }
}

/// One inline metadata line: `3 of 12 · 40°`. While a rest timer takes the
/// grade's top-right slot, the grade leads this line instead, in its band
/// colour: `V4 · 3 of 12 · 40°`.
@available(iOS 17.0, *)
private struct MetadataLine: View {
    @Environment(\.colorScheme) private var colorScheme
    let currentIndex: Int
    let totalClimbs: Int
    let angle: Int
    var grade: String? = nil

    var body: some View {
        let palette = VelvetSend.Palette.resolve(colorScheme)
        // A quiet middot between facts — calmer than a hairline bar, the system
        // idiom for inline metadata. "17 of 17 · 40°".
        HStack(spacing: VelvetSend.Spacing.sm) {
            if let grade {
                let shown = VGradeFormatter.displayGrade(grade)
                Text(verbatim: shown)
                    .fontWeight(.semibold)
                    .foregroundColor(GradeColors.color(forVGrade: shown) ?? palette.tint)
                    .accessibilityLabel("Grade \(shown)")
                Text(verbatim: "\u{00B7}").foregroundColor(palette.tertiaryLabel)
            }
            Text("\(currentIndex + 1) of \(totalClimbs)")
            Text(verbatim: "\u{00B7}").foregroundColor(palette.tertiaryLabel)
            Text(verbatim: "\(angle)°")
            Spacer(minLength: 0)
        }
        .font(.subheadline)
        .foregroundColor(palette.secondaryLabel)
        .lineLimit(1)
        .minimumScaleFactor(0.85)
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
    }
}

@available(iOS 17.0, *)
private struct WallControlViewState {
    let navigationAllowed: Bool
    let isPartySession: Bool

    static func current() -> WallControlViewState {
        guard let defaults = SharedConstants.sharedDefaults else {
            return WallControlViewState(navigationAllowed: true, isPartySession: false)
        }

        let wallControl = SharedWidgetWallControlState.load(from: defaults)
        return WallControlViewState(
            navigationAllowed: wallControl.navigationAllowed,
            isPartySession: wallControl.requiresServerAuthorization
        )
    }
}

@available(iOS 17.0, *)
private struct NavigationButtonLabel: View {
    @Environment(\.colorScheme) private var colorScheme
    /// A localization key ("Prev" / "Next"), so the label follows the
    /// climber's language; a plain `String` would render verbatim.
    let title: LocalizedStringKey
    let systemImage: String
    let imagePlacement: ImagePlacement
    let enabled: Bool

    enum ImagePlacement {
        case leading
        case trailing
    }

    var body: some View {
        let palette = VelvetSend.Palette.resolve(colorScheme)
        HStack(spacing: VelvetSend.Spacing.xs) {
            if imagePlacement == .leading {
                Image(systemName: systemImage)
            }

            Text(title)

            if imagePlacement == .trailing {
                Image(systemName: systemImage)
            }
        }
        // Text-only: no container/border — just chevron + label. State lives in
        // the foreground colour. The lit bulb is the only accented control.
        .font(.subheadline.weight(.semibold))
        .foregroundColor(enabled ? palette.tint : palette.tertiaryLabel.opacity(0.8))
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .frame(maxWidth: .infinity, minHeight: 44)
        .contentShape(Rectangle())
    }
}

@available(iOS 17.0, *)
private struct WallControlStatus: View {
    @Environment(\.colorScheme) private var colorScheme
    /// Lit when this device drives the board; out otherwise.
    let lit: Bool

    // Keep the glow readable on the light-mode surface (#F4F1FB).
    private var glowOpacity: Double {
        colorScheme == .light ? max(0.30, VelvetSend.Opacity.litGlowShadow) : VelvetSend.Opacity.litGlowShadow
    }

    var body: some View {
        let palette = VelvetSend.Palette.resolve(colorScheme)
        Image(systemName: lit ? "lightbulb.fill" : "lightbulb")
            .font(.title3.weight(.semibold))
            // No container — just the glyph. Colour is the signal; the lit bulb's
            // soft amber glow is the only warm accent on the card.
            .foregroundColor(lit ? palette.warning : palette.secondaryLabel)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
            .shadow(
                color: lit ? palette.warning.opacity(glowOpacity) : .clear,
                radius: lit ? 6 : 0
            )
            .accessibilityLabel(lit ? "Wall lit, you are driving" : "Wall control")
    }
}

@available(iOS 17.0, *)
private struct WallControlButton: View {
    let lit: Bool

    var body: some View {
        // The lightbulb is always a button: tapping it reconnects Bluetooth to
        // the last known board (and, in a party session where this device isn't
        // the driver, also claims wall control). When already connected and
        // driving, ReconnectBoardIntent just re-lights the wall — a harmless
        // no-op grab.
        Button(intent: ReconnectBoardIntent()) {
            WallControlStatus(lit: lit)
        }
        .buttonStyle(.plain)
    }
}

@available(iOS 17.0, *)
private struct NavigationControlsView: View {
    @Environment(\.colorScheme) private var colorScheme
    let sessionId: String
    let queueItemUuid: String?
    let mirrored: Bool
    let supportsMirroring: Bool
    let hasPrevious: Bool
    let hasNext: Bool

    var body: some View {
        let palette = VelvetSend.Palette.resolve(colorScheme)
        // This row is only rendered for connectedByMe (see SessionFooter), so the
        // device holds the board — enablement is purely queue-position based.
        let previousEnabled = hasPrevious
        let nextEnabled = hasNext

        HStack(spacing: VelvetSend.Spacing.sm) {
            Button(intent: PreviousClimbIntent()) {
                NavigationButtonLabel(
                    title: "Prev",
                    systemImage: "chevron.left",
                    imagePlacement: .leading,
                    enabled: previousEnabled
                )
            }
            .buttonStyle(.plain)
            .disabled(!previousEnabled)
            .accessibilityLabel("Previous climb")

            // connectedByMe is the only state that renders this row, so the bulb
            // is always lit here.
            WallControlButton(lit: true)
            if supportsMirroring, let queueItemUuid {
                Button(intent: MirrorClimbIntent(sessionId: sessionId, queueItemUuid: queueItemUuid, mirrored: !mirrored)) {
                    // Velvet tokens, not the system accent: with no asset
                    // catalog accent colour, `Color.accentColor` drew system blue.
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(mirrored ? palette.tint : palette.label)
                        .frame(width: 40, height: 40)
                        .background(
                            mirrored ? palette.tint.opacity(VelvetSend.Opacity.selectedFill) : Color.clear,
                            in: Circle()
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(mirrored ? String(localized: "Unmirror climb") : String(localized: "Mirror climb"))
                .accessibilityAddTraits(mirrored ? .isSelected : [])
            }

            Button(intent: NextClimbIntent()) {
                NavigationButtonLabel(
                    title: "Next",
                    systemImage: "chevron.right",
                    imagePlacement: .trailing,
                    enabled: nextEnabled
                )
            }
            .buttonStyle(.plain)
            .disabled(!nextEnabled)
            .accessibilityLabel("Next climb")
        }
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
    }
}

// MARK: - Rest Timer Subviews (#6513)

/// One colour per rest state, matching the app's pill: violet while it runs,
/// red once over, gray when frozen or once the queue has run out (that clock
/// keeps counting, but is never the over red), faint gray while waiting for a
/// first tick.
@available(iOS 17.0, *)
private func restTimerColor(_ rest: ResolvedRestTimer, palette: VelvetSend.Palette) -> Color {
    if case .waiting = rest.phase { return palette.tertiaryLabel }
    if rest.muted { return palette.secondaryLabel }
    switch rest.phase {
    case .running, .countUp:
        return palette.tint
    case .over:
        return palette.error
    case .paused, .queueEnded, .waiting:
        return palette.secondaryLabel
    }
}

/// The rest clock as text. Only the system timer views move between renders,
/// so a running rest counts down with `Text(timerInterval:)` (it holds at 0:00
/// until the next render flips it to the overrun), an overrun counts up from
/// the deadline behind a minus sign, and frozen phases print a fixed value.
@available(iOS 17.0, *)
private func restTimerDigitsText(_ phase: RestTimerRenderPhase) -> Text {
    switch phase {
    case let .running(start, deadline):
        return Text(timerInterval: start...deadline, countsDown: true)
    case let .over(deadline):
        return Text(verbatim: "\u{2212}") + Text(deadline, style: .timer)
    case let .countUp(start):
        return Text(start, style: .timer)
    case let .paused(seconds), let .queueEnded(seconds), let .waiting(seconds):
        return Text(verbatim: RestTimerFormat.signedClock(seconds))
    }
}

/// The word under the rest clock: what the number cannot say on its own.
@available(iOS 17.0, *)
private func restTimerCaptionText(_ rest: ResolvedRestTimer) -> Text {
    if rest.muted { return Text("Queue's empty") }
    switch rest.phase {
    case .running:
        if let period = rest.periodSeconds {
            return Text("Every \(RestTimerFormat.clock(period))")
        }
        return Text("Rest")
    case .over:
        return Text("Over your rest")
    case .paused:
        return Text("Paused")
    case .queueEnded:
        return Text("Queue's empty")
    case .countUp:
        return Text("Since your last climb")
    case .waiting:
        return Text("Log a climb to start")
    }
}

/// The rest clock's digits in a fixed frame.
@available(iOS 17.0, *)
private struct RestTimerDigits: View {
    @Environment(\.colorScheme) private var colorScheme
    let rest: ResolvedRestTimer
    let font: Font
    let width: CGFloat
    var textAlignment: TextAlignment = .trailing

    var body: some View {
        let palette = VelvetSend.Palette.resolve(colorScheme)
        restTimerDigitsText(rest.phase)
            .font(font)
            .monospacedDigit()
            .foregroundColor(restTimerColor(rest, palette: palette))
            .lineLimit(1)
            // An overrun grows without bound while nothing can redraw the card
            // ("−12:34", then hours): shrink to fit rather than truncate.
            .minimumScaleFactor(0.6)
            .multilineTextAlignment(textAlignment)
            // Timer text claims every point it is offered; a fixed frame keeps
            // it from pushing the climb name or the camera cut-out around.
            .frame(width: width, alignment: frameAlignment)
    }

    private var frameAlignment: Alignment {
        switch textAlignment {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }
}

/// The caption under the digits.
@available(iOS 17.0, *)
private struct RestTimerCaption: View {
    @Environment(\.colorScheme) private var colorScheme
    let rest: ResolvedRestTimer

    var body: some View {
        let palette = VelvetSend.Palette.resolve(colorScheme)
        restTimerCaptionText(rest)
            .font(.caption2.weight(.semibold))
            .foregroundColor(palette.secondaryLabel)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
    }
}

/// Digits over caption, right-aligned: the top-right slot the grade gives up
/// while a rest is on.
@available(iOS 17.0, *)
private struct RestTimerBlock: View {
    let rest: ResolvedRestTimer
    var font: Font = .title2.weight(.semibold)
    var width: CGFloat = 92

    var body: some View {
        VStack(alignment: .trailing, spacing: 0) {
            RestTimerDigits(rest: rest, font: font, width: width)
            RestTimerCaption(rest: rest)
                .frame(maxWidth: width, alignment: .trailing)
        }
        // One element: "Rest timer" names it, the value carries the clock and
        // its caption. Overriding the label of a `.combine` element would drop
        // both, and the closure form that keeps them needs iOS 18.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Rest timer"))
        .accessibilityValue(restTimerDigitsText(rest.phase) + Text(verbatim: ", ") + restTimerCaptionText(rest))
    }
}

/// The connection glyph, wrapped in a draining ring while a rest counts down
/// (red and full once it is over). The Timer app's minimal presentation shows
/// the time left rather than a static icon; the ring keeps the bulb inside so
/// the wall's state is never lost.
@available(iOS 17.0, *)
private struct RestRingGlyph<Glyph: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    let rest: ResolvedRestTimer?
    let size: CGFloat
    @ViewBuilder let glyph: () -> Glyph

    var body: some View {
        let palette = VelvetSend.Palette.resolve(colorScheme)
        // Once the queue has run out the ring keeps going, muted.
        let muted = rest?.muted == true
        switch rest?.phase {
        case let .running(start, deadline)?:
            ZStack {
                ProgressView(timerInterval: start...deadline, countsDown: true) {
                    EmptyView()
                } currentValueLabel: {
                    EmptyView()
                }
                .progressViewStyle(.circular)
                .tint(muted ? palette.secondaryLabel : palette.tint)
                glyph()
            }
            .frame(width: size, height: size)
        case .over?:
            ZStack {
                Circle()
                    .stroke(muted ? palette.secondaryLabel : palette.error, lineWidth: 2)
                glyph()
            }
            .frame(width: size, height: size)
        default:
            glyph()
        }
    }
}

// MARK: - State-specific footers

/// "<name> is on the wall" line for the heldByPeer state — bulb is out, no
/// controls. Violet (a presence/connection signal), never amber.
@available(iOS 17.0, *)
private struct HeldByPeerFooter: View {
    @Environment(\.colorScheme) private var colorScheme
    let holderDisplayName: String?

    /// Interpolated literals, so both lines are localization keys
    /// ("%@ is on the wall", "On the wall") rather than verbatim strings.
    private var message: Text {
        if let name = holderDisplayName, !name.isEmpty {
            return Text("\(name) is on the wall")
        }
        return Text("On the wall")
    }

    var body: some View {
        let palette = VelvetSend.Palette.resolve(colorScheme)
        HStack(spacing: VelvetSend.Spacing.sm) {
            Image(systemName: "dot.radiowaves.left.and.right")
                .font(.subheadline.weight(.semibold))
                .foregroundColor(palette.tint)

            message
                .font(.subheadline.weight(.medium))
                .foregroundColor(palette.secondaryLabel)
                .lineLimit(1)
                .minimumScaleFactor(0.9)

            Spacer(minLength: 0)
        }
        .frame(minHeight: 44)
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Wall held by another climber")
    }
}

/// Tappable reconnect row for the disconnected state — wired to
/// ReconnectBoardIntent.
@available(iOS 17.0, *)
private struct DisconnectedFooter: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = VelvetSend.Palette.resolve(colorScheme)
        Button(intent: ReconnectBoardIntent()) {
            HStack(spacing: VelvetSend.Spacing.sm) {
                Image(systemName: "lightbulb.slash")
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(palette.secondaryLabel)

                Text("Tap to reconnect")
                    .font(.subheadline.weight(.medium))
                    .foregroundColor(palette.tint)
                    .lineLimit(1)
                    .minimumScaleFactor(0.9)

                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
        .accessibilityLabel("Board disconnected. Tap to reconnect")
    }
}

/// Picks the right footer for the resolved state. connectedByMe is the only
/// state that instantiates NavigationControlsView.
@available(iOS 17.0, *)
private struct SessionFooter: View {
    let sessionId: String
    let queueItemUuid: String?
    let mirrored: Bool
    let supportsMirroring: Bool
    let state: ResolvedBoardState
    let hasPrevious: Bool
    let hasNext: Bool

    var body: some View {
        switch state.connection {
        case .connectedByMe:
            NavigationControlsView(
                sessionId: sessionId, queueItemUuid: queueItemUuid,
                mirrored: mirrored, supportsMirroring: supportsMirroring,
                hasPrevious: hasPrevious,
                hasNext: hasNext
            )
        case .heldByPeer:
            HeldByPeerFooter(holderDisplayName: state.holderDisplayName)
        case .disconnected:
            DisconnectedFooter()
        }
    }
}

// MARK: - Live Activity Widget

@available(iOS 17.0, *)
struct ClimbSessionLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ClimbSessionAttributes.self) { context in
            // Lock Screen / Banner presentation. The background is pinned to the
            // dark surface, so the text palette is pinned to dark with it — in
            // light mode the label colour would otherwise resolve to near-black
            // on that same near-black card.
            LockScreenView(context: context)
                .environment(\.colorScheme, .dark)
                .activityBackgroundTint(VelvetSend.Palette.resolve(.dark).background)
                .activitySystemActionForegroundColor(VelvetSend.Palette.resolve(.dark).label)
        } dynamicIsland: { context in
            let state = resolveBoardState(context: context)
            let mirrorState = resolveMirrorState(context: context)
            // The island shows the rest only once there is something to count:
            // a "waiting for your first tick" target would read as a stuck timer.
            let rest = resolveRestTimer(context: context).flatMap { resolved -> ResolvedRestTimer? in
                if case .waiting = resolved.phase { return nil }
                return resolved
            }
            return DynamicIsland {
                // Expanded Dynamic Island
                DynamicIslandExpandedRegion(.leading) {
                    ThumbnailView(
                        climbUuid: context.state.climbUuid,
                        mirrored: mirrorState.mirrored,
                        width: 48,
                        height: 60
                    )
                    .padding(.leading, VelvetSend.Spacing.xs)
                }

                DynamicIslandExpandedRegion(.center) {
                    ExpandedCenterView(context: context, showsGrade: rest != nil)
                }

                DynamicIslandExpandedRegion(.trailing) {
                    ExpandedTrailingView(grade: context.state.climbDifficulty, rest: rest)
                }

                DynamicIslandExpandedRegion(.bottom) {
                    SessionFooter(
                        sessionId: context.attributes.sessionId,
                        queueItemUuid: mirrorState.queueItemUuid,
                        mirrored: mirrorState.mirrored,
                        supportsMirroring: context.state.supportsMirroring ?? (SharedConstants.sharedDefaults?.bool(forKey: SharedConstants.supportsMirroringKey) ?? false),
                        state: state,
                        hasPrevious: context.state.hasPrevious,
                        hasNext: context.state.hasNext
                    )
                    .padding(.horizontal, VelvetSend.Spacing.xs)
                }
            } compactLeading: {
                CompactLeadingView(connection: state.connection, rest: rest)
            } compactTrailing: {
                CompactTrailingView(text: context.state.climbDifficulty, rest: rest)
            } minimal: {
                MinimalView(connection: state.connection, rest: rest)
            }
        }
    }
}

// MARK: - Dynamic Island Subviews

@available(iOS 17.0, *)
private struct ExpandedCenterView: View {
    @Environment(\.colorScheme) private var colorScheme
    let context: ActivityViewContext<ClimbSessionAttributes>
    /// True while the rest timer holds the trailing slot, so the grade moves
    /// to the front of the metadata line instead of disappearing.
    let showsGrade: Bool

    var body: some View {
        let palette = VelvetSend.Palette.resolve(colorScheme)
        VStack(alignment: .leading, spacing: VelvetSend.Spacing.xs) {
            Text(verbatim: context.state.climbName)
                .font(.headline)
                .foregroundColor(palette.label)
                .lineLimit(1)
                .minimumScaleFactor(0.9)

            // Mirror the lock-screen card exactly: the grade is in the trailing
            // region (top-right) unless a rest timer has taken it.
            MetadataLine(
                currentIndex: context.state.currentIndex,
                totalClimbs: context.state.totalClimbs,
                angle: context.state.angle,
                grade: showsGrade ? context.state.climbDifficulty : nil
            )
        }
    }
}

@available(iOS 17.0, *)
private struct ExpandedTrailingView: View {
    let grade: String
    let rest: ResolvedRestTimer?

    var body: some View {
        Group {
            if let rest {
                RestTimerBlock(rest: rest, font: .title3.weight(.semibold), width: 76)
            } else {
                // Grade-band-coloured numeral, top-right — identical to the
                // lock-screen card's top-right grade.
                GradeText(text: grade)
            }
        }
        .padding(.trailing, VelvetSend.Spacing.xs)
    }
}

@available(iOS 17.0, *)
private struct CompactLeadingView: View {
    let connection: BoardConnection
    let rest: ResolvedRestTimer?

    var body: some View {
        // Leading and trailing read as one piece: the ring here, the digits
        // across the camera. Without a counting rest, just the bulb.
        RestRingGlyph(rest: rest, size: 22) {
            ConnectionGlyph(connection: connection, size: isRinged ? 9 : 14)
        }
    }

    private var isRinged: Bool {
        switch rest?.phase {
        case .running?, .over?: return true
        default: return false
        }
    }
}

@available(iOS 17.0, *)
private struct CompactTrailingView: View {
    @Environment(\.colorScheme) private var colorScheme
    let text: String
    let rest: ResolvedRestTimer?

    var body: some View {
        let palette = VelvetSend.Palette.resolve(colorScheme)
        if let rest {
            // The countdown takes the grade's place while a rest is on.
            RestTimerDigits(
                rest: rest,
                font: .system(size: 15, weight: .semibold),
                width: 46,
                textAlignment: .center
            )
        } else {
            let grade = VGradeFormatter.displayGrade(text)
            Text(verbatim: grade)
                .font(.system(size: 15, weight: .bold))
                .foregroundColor(GradeColors.color(forVGrade: grade) ?? palette.label)
                .offset(y: -1)
        }
    }
}

@available(iOS 17.0, *)
private struct MinimalView: View {
    let connection: BoardConnection
    let rest: ResolvedRestTimer?

    var body: some View {
        RestRingGlyph(rest: rest, size: 22) {
            ConnectionGlyph(connection: connection, size: isRinged ? 9 : 12)
        }
    }

    private var isRinged: Bool {
        switch rest?.phase {
        case .running?, .over?: return true
        default: return false
        }
    }
}

/// The wall's state as one glyph. Amber only when lit; violet for a peer.
@available(iOS 17.0, *)
private struct ConnectionGlyph: View {
    @Environment(\.colorScheme) private var colorScheme
    let connection: BoardConnection
    let size: CGFloat

    var body: some View {
        let palette = VelvetSend.Palette.resolve(colorScheme)
        switch connection {
        case .connectedByMe:
            Image(systemName: "lightbulb.fill")
                .font(.system(size: size))
                .foregroundColor(palette.warning)
        case .heldByPeer:
            Image(systemName: "dot.radiowaves.left.and.right")
                .font(.system(size: size))
                .foregroundColor(palette.tint)
        case .disconnected:
            Image(systemName: "lightbulb.slash")
                .font(.system(size: size))
                .foregroundColor(palette.secondaryLabel)
        }
    }
}

// MARK: - Lock Screen View

@available(iOS 17.0, *)
private struct LockScreenView: View {
    @Environment(\.colorScheme) private var colorScheme
    let context: ActivityViewContext<ClimbSessionAttributes>

    var body: some View {
        if context.isStale {
            staleView
        } else {
            activeView
        }
    }

    private var activeView: some View {
        let palette = VelvetSend.Palette.resolve(colorScheme)
        let state = resolveBoardState(context: context)
        let mirrorState = resolveMirrorState(context: context)
        let rest = resolveRestTimer(context: context)
        return HStack(alignment: .top, spacing: VelvetSend.Spacing.md) {
            // Thumbnail
            ThumbnailView(
                climbUuid: context.state.climbUuid,
                mirrored: mirrorState.mirrored,
                width: 76,
                height: 96
            )

            // Content: a title block (name + top-right grade or rest clock +
            // metadata) and a control strip. One leading edge. The gap between
            // them is `.md`, not `.xl`: the card must stay under the Lock
            // Screen's 160 pt cap even with a two-line name.
            VStack(alignment: .leading, spacing: VelvetSend.Spacing.md) {
                VStack(alignment: .leading, spacing: VelvetSend.Spacing.xs) {
                    // Top row: name (left) + the grade-band-coloured grade, or
                    // the rest clock while a rest is on, pinned top-right.
                    // firstTextBaseline keeps it on the title's first line even
                    // when the name wraps to two.
                    HStack(alignment: .firstTextBaseline, spacing: VelvetSend.Spacing.sm) {
                        Text(verbatim: context.state.climbName)
                            .font(.headline)
                            .foregroundColor(palette.label)
                            .lineLimit(2)
                            .minimumScaleFactor(0.85)

                        Spacer(minLength: VelvetSend.Spacing.sm)

                        if let rest {
                            RestTimerBlock(rest: rest)
                        } else {
                            GradeText(text: context.state.climbDifficulty)
                        }
                    }

                    MetadataLine(
                        currentIndex: context.state.currentIndex,
                        totalClimbs: context.state.totalClimbs,
                        angle: context.state.angle,
                        grade: rest == nil ? nil : context.state.climbDifficulty
                    )
                }

                // Bottom row reflows per resolved board state. heldByPeer /
                // disconnected hide the nav controls entirely so the card
                // shrinks instead of leaving an empty gap.
                SessionFooter(
                    sessionId: context.attributes.sessionId,
                    queueItemUuid: mirrorState.queueItemUuid,
                    mirrored: mirrorState.mirrored,
                    supportsMirroring: context.state.supportsMirroring ?? (SharedConstants.sharedDefaults?.bool(forKey: SharedConstants.supportsMirroringKey) ?? false),
                    state: state,
                    hasPrevious: context.state.hasPrevious,
                    hasNext: context.state.hasNext
                )
            }
        }
        .padding(.vertical, VelvetSend.Spacing.lg)
        .padding(.horizontal, VelvetSend.Spacing.lockScreenMargin)
    }

    private var staleView: some View {
        let palette = VelvetSend.Palette.resolve(colorScheme)
        return VStack(spacing: VelvetSend.Spacing.sm) {
            Image(systemName: "checkmark.seal.fill")
                .font(.title2)
                .foregroundColor(palette.tint)

            Text("Session ended")
                .font(.headline)
                .foregroundColor(palette.label)

            Text(verbatim: context.attributes.boardName)
                .font(.subheadline)
                .foregroundColor(palette.secondaryLabel)
        }
        .frame(maxWidth: .infinity)
        .padding(VelvetSend.Spacing.lg)
    }
}
