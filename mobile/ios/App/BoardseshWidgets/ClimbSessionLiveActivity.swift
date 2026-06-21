import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

// MARK: - Thumbnail Helper

func loadThumbnail(climbUuid: String) -> UIImage? {
    guard let containerURL = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: SharedConstants.appGroupId
    ) else { return nil }
    let path = containerURL.appendingPathComponent("thumbnails/\(climbUuid).webp")
    guard let data = try? Data(contentsOf: path) else { return nil }
    return UIImage(data: data)
}

// MARK: - Colors

private let backgroundColor = Color(red: 10 / 255, green: 10 / 255, blue: 10 / 255)
private let pillBackground = Color.white.opacity(0.15)
private let wallDriverTint = Color.yellow

// MARK: - Shared Subviews

@available(iOS 17.0, *)
private struct ThumbnailView: View {
    let climbUuid: String
    let width: CGFloat
    let height: CGFloat

    var body: some View {
        if let image = loadThumbnail(climbUuid: climbUuid) {
            Image(uiImage: image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: width, height: height)
                .clipShape(RoundedRectangle(cornerRadius: 8))
        } else {
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.white.opacity(0.1))
                .frame(width: width, height: height)
                .overlay(
                    Image(systemName: "mountain.2.fill")
                        .font(.system(size: min(width, height) * 0.4))
                        .foregroundColor(.white.opacity(0.4))
                )
        }
    }
}

@available(iOS 17.0, *)
private struct DifficultyPill: View {
    let text: String
    var font: Font = .caption.bold()

    var body: some View {
        Text(text)
            .font(font)
            .foregroundColor(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(pillBackground)
            .clipShape(Capsule())
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
    let title: String
    let systemImage: String
    let imagePlacement: ImagePlacement
    let enabled: Bool

    enum ImagePlacement {
        case leading
        case trailing
    }

    var body: some View {
        HStack(spacing: 4) {
            if imagePlacement == .leading {
                Image(systemName: systemImage)
            }

            Text(title)

            if imagePlacement == .trailing {
                Image(systemName: systemImage)
            }
        }
        .font(.subheadline.weight(.medium))
        .foregroundColor(enabled ? .white : .white.opacity(0.3))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(enabled ? Color.white.opacity(0.15) : Color.white.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

@available(iOS 17.0, *)
private struct WallControlStatus: View {
    let wallControl: WallControlViewState

    var body: some View {
        Image(systemName: wallControl.navigationAllowed ? "lightbulb.fill" : "lightbulb")
            .font(.subheadline.weight(.semibold))
            .foregroundColor(wallControl.navigationAllowed ? wallDriverTint : .white.opacity(0.45))
            .frame(width: 44)
            .padding(.vertical, 8)
            .background(
                wallControl.navigationAllowed
                    ? wallDriverTint.opacity(0.18)
                    : Color.white.opacity(0.06)
            )
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .accessibilityLabel(wallControl.navigationAllowed ? "Wall driver" : "Take wall control")
    }
}

@available(iOS 17.0, *)
private struct WallControlButton: View {
    let wallControl: WallControlViewState

    var body: some View {
        if wallControl.isPartySession && !wallControl.navigationAllowed {
            Button(intent: TakeControlIntent()) {
                WallControlStatus(wallControl: wallControl)
            }
            .buttonStyle(.plain)
        } else {
            WallControlStatus(wallControl: wallControl)
        }
    }
}

@available(iOS 17.0, *)
private struct NavigationControlsView: View {
    let hasPrevious: Bool
    let hasNext: Bool
    let wallControl: WallControlViewState

    var body: some View {
        let previousEnabled = hasPrevious && wallControl.navigationAllowed
        let nextEnabled = hasNext && wallControl.navigationAllowed

        HStack(spacing: 10) {
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

            WallControlButton(wallControl: wallControl)

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
        }
    }
}

// MARK: - Live Activity Widget

@available(iOS 17.0, *)
struct ClimbSessionLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ClimbSessionAttributes.self) { context in
            // Lock Screen / Banner presentation
            LockScreenView(context: context)
                .activityBackgroundTint(backgroundColor)
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                // Expanded Dynamic Island
                DynamicIslandExpandedRegion(.leading) {
                    ThumbnailView(
                        climbUuid: context.state.climbUuid,
                        width: 48,
                        height: 60
                    )
                    .padding(.leading, 4)
                }

                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.climbName)
                            .font(.headline)
                            .fontWeight(.bold)
                            .foregroundColor(.white)
                            .lineLimit(1)

                        HStack(spacing: 6) {
                            DifficultyPill(text: context.state.climbDifficulty)

                            Text("\(context.state.currentIndex + 1) of \(context.state.totalClimbs)")
                                .font(.caption)
                                .foregroundColor(.white.opacity(0.6))
                        }
                    }
                }

                DynamicIslandExpandedRegion(.trailing) {
                    Text("\(context.state.angle)°")
                        .font(.title3)
                        .fontWeight(.semibold)
                        .foregroundColor(.white.opacity(0.7))
                        .padding(.trailing, 4)
                }

                DynamicIslandExpandedRegion(.bottom) {
                    NavigationControlsView(
                        hasPrevious: context.state.hasPrevious,
                        hasNext: context.state.hasNext,
                        wallControl: WallControlViewState.current()
                    )
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                // Compact Dynamic Island - Leading
                if let image = loadThumbnail(climbUuid: context.state.climbUuid) {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 24, height: 24)
                        .clipShape(Circle())
                } else {
                    Image(systemName: "mountain.2.fill")
                        .font(.system(size: 14))
                        .foregroundColor(.white)
                }
            } compactTrailing: {
                // Compact Dynamic Island - Trailing
                Text(context.state.climbDifficulty)
                    .font(.caption.bold())
                    .foregroundColor(.white)
                    .offset(y: -1)
            } minimal: {
                Image(systemName: "mountain.2.fill")
                    .font(.system(size: 12))
                    .foregroundColor(.white)
            }
        }
    }
}

// MARK: - Lock Screen View

@available(iOS 17.0, *)
private struct LockScreenView: View {
    let context: ActivityViewContext<ClimbSessionAttributes>

    var body: some View {
        if context.isStale {
            staleView
        } else {
            activeView
        }
    }

    private var activeView: some View {
        HStack(spacing: 12) {
            // Thumbnail
            ThumbnailView(
                climbUuid: context.state.climbUuid,
                width: 80,
                height: 100
            )

            // Content
            VStack(alignment: .leading, spacing: 6) {
                // Top row: climb name and difficulty
                HStack(alignment: .top) {
                    Text(context.state.climbName)
                        .font(.headline)
                        .fontWeight(.bold)
                        .foregroundColor(.white)
                        .lineLimit(2)

                    Spacer()

                    DifficultyPill(text: context.state.climbDifficulty, font: .subheadline.bold())
                }

                // Middle row: position and angle
                HStack {
                    Text("\(context.state.currentIndex + 1) of \(context.state.totalClimbs)")
                        .font(.subheadline)
                        .foregroundColor(.white.opacity(0.6))

                    Spacer()

                    Text("\(context.state.angle)°")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(.white.opacity(0.7))
                }

                Spacer(minLength: 4)

                // Bottom row: navigation buttons
                NavigationControlsView(
                    hasPrevious: context.state.hasPrevious,
                    hasNext: context.state.hasNext,
                    wallControl: WallControlViewState.current()
                )
            }
        }
        .padding(16)
    }

    private var staleView: some View {
        HStack {
            Image(systemName: "mountain.2.fill")
                .font(.title3)
                .foregroundColor(.white.opacity(0.4))

            Text("Session ended")
                .font(.headline)
                .foregroundColor(.white.opacity(0.5))
        }
        .frame(maxWidth: .infinity)
        .padding(16)
    }
}
