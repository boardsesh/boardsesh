import ExpoModulesCore
import UIKit

/// Two iOS accessibility hooks React Native 0.86 has no JS path to.
///
/// - **Differentiate Without Color** (Settings > Accessibility > Display & Text
///   Size). `AccessibilityInfo` has no query for it, so JS reads it here and
///   hears about changes through `onDifferentiateWithoutColorChange`. JS decides
///   what it means (per-role hold shapes, the role-glyph suggestion), so that
///   part ships by OTA.
/// - **Large Content Viewer.** `LargeContentViewerView` is a plain container
///   that, at an accessibility text size, shows its title in the system's
///   magnified HUD when the climber long-presses it. It exists for chrome whose
///   text is capped below the climber's text size (`CHROME_LABEL_MAX_FONT_SCALE`).
public class AccessibilityUIModule: Module {
  private var differentiateWithoutColorObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    // The contract with JS: modules/accessibility-ui/src/index.ts resolves this
    // name with requireOptionalNativeModule, so a binary without the module
    // (every store build before it shipped, Android, the web) reads as absent
    // instead of crashing. Renaming it turns every caller into that path.
    Name("AccessibilityUI")

    Events("onDifferentiateWithoutColorChange")

    // On the main queue: UIAccessibility is UIKit state.
    AsyncFunction("isDifferentiateWithoutColorEnabled") { () -> Bool in
      UIAccessibility.shouldDifferentiateWithoutColor
    }
    .runOnQueue(.main)

    OnStartObserving {
      self.startDifferentiateWithoutColorObservation()
    }

    OnStopObserving {
      self.stopDifferentiateWithoutColorObservation()
    }

    OnDestroy {
      self.stopDifferentiateWithoutColorObservation()
    }

    View(LargeContentViewerView.self) {
      Events("onLargeContentViewerActivate")

      Prop("title") { (view: LargeContentViewerView, title: String?) in
        view.setTitle(title)
      }

      Prop("systemImage") { (view: LargeContentViewerView, systemImage: String?) in
        view.setSystemImage(systemImage)
      }
    }
  }

  private func startDifferentiateWithoutColorObservation() {
    guard differentiateWithoutColorObserver == nil else {
      return
    }
    differentiateWithoutColorObserver = NotificationCenter.default.addObserver(
      forName: Self.notificationName(UIAccessibility.differentiateWithoutColorDidChangeNotification),
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.sendEvent(
        "onDifferentiateWithoutColorChange",
        ["enabled": UIAccessibility.shouldDifferentiateWithoutColor]
      )
    }
  }

  private func stopDifferentiateWithoutColorObservation() {
    if let observer = differentiateWithoutColorObserver {
      NotificationCenter.default.removeObserver(observer)
      differentiateWithoutColorObserver = nil
    }
  }

  // UIKit declares this notification as a plain `NSString` constant, which
  // Swift imports as `String`, unlike most UIAccessibility notifications, which
  // are already `NSNotification.Name`. Both overloads are here so the call above
  // compiles against either import.
  private static func notificationName(_ name: NSNotification.Name) -> NSNotification.Name {
    name
  }

  private static func notificationName(_ name: String) -> NSNotification.Name {
    NSNotification.Name(rawValue: name)
  }
}
