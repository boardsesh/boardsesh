import ExpoModulesCore
import UIKit

/// A container whose title shows in the Large Content Viewer.
///
/// HIG (Accessibility > Large Content Viewer): when a bar's text cannot grow
/// with the climber's text size, a long press should show it large in the
/// system HUD instead, the way the tab bar does. RN text cannot opt into that,
/// so JS wraps the capped label in this view and passes the words to show.
///
/// The interaction is installed only while the content size is an
/// accessibility size (the only sizes at which UIKit shows the viewer at all),
/// so at every other size this view adds no gesture and behaves like a plain
/// `View`. It follows a size change made while the app is open.
///
/// Lifting the finger on the view sends `onLargeContentViewerActivate`, which is
/// how a UIKit bar item behaves: the viewer's long press cancels the touch
/// underneath, so without it the bar would do nothing.
final class LargeContentViewerView: ExpoView, UILargeContentViewerInteractionDelegate {
  let onLargeContentViewerActivate = EventDispatcher()

  private var largeContentInteraction: UILargeContentViewerInteraction?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    showsLargeContentViewer = true
    scalesLargeContentImage = true

    // Selector-based observers are dropped with the view; no deinit needed.
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(contentSizeCategoryDidChange),
      name: UIContentSizeCategory.didChangeNotification,
      object: nil
    )
    updateInteraction()
  }

  func setTitle(_ title: String?) {
    largeContentTitle = title
  }

  func setSystemImage(_ systemImage: String?) {
    largeContentImage = systemImage.flatMap { UIImage(systemName: $0) }
  }

  @objc private func contentSizeCategoryDidChange() {
    updateInteraction()
  }

  private func updateInteraction() {
    let wanted = UIApplication.shared.preferredContentSizeCategory.isAccessibilityCategory
    if wanted, largeContentInteraction == nil {
      let interaction = UILargeContentViewerInteraction(delegate: self)
      addInteraction(interaction)
      largeContentInteraction = interaction
    } else if !wanted, let interaction = largeContentInteraction {
      removeInteraction(interaction)
      largeContentInteraction = nil
    }
  }

  // MARK: - UILargeContentViewerInteractionDelegate

  /// This view is the only item. Without this, UIKit hit-tests for a view that
  /// shows the viewer, and the RN text views under the finger do not.
  func largeContentViewerInteraction(
    _ interaction: UILargeContentViewerInteraction,
    itemAt point: CGPoint
  ) -> UILargeContentViewerItem? {
    guard largeContentTitle?.isEmpty == false, bounds.contains(point) else {
      return nil
    }
    return self
  }

  func largeContentViewerInteraction(
    _ interaction: UILargeContentViewerInteraction,
    didEndOn item: UILargeContentViewerItem?,
    at point: CGPoint
  ) {
    guard item === self, bounds.contains(point) else {
      return
    }
    onLargeContentViewerActivate([:])
  }
}
