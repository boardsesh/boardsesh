import ExpoModulesCore
import UIKit

/// An invisible view laid over the hold editor. While it is in a window it
/// holds the keyboard (first responder), answers the shortcuts it was given as
/// `UIKeyCommand`s, and carries the editor's `UIPencilInteraction`.
///
/// Key commands only reach responders in the chain that starts at the first
/// responder, so this view has to be it. Nothing else on the editor ever is —
/// it has no text field — but UIKit hands the keyboard back to nobody after an
/// alert or a trip to the home screen, so the view takes it again whenever its
/// window becomes key, the app becomes active, or a touch lands on the editor.
/// It never takes the keyboard from a text field someone is typing in.
///
/// JS renders it with `pointerEvents="none"`, so touches pass straight through
/// to the editor; `hitTest` is still asked first, which is how a touch tells the
/// view to take the keyboard back.
final class SprayEditorKeyScopeView: ExpoView, UIPencilInteractionDelegate {
  let onShortcut = EventDispatcher()
  let onPencilTap = EventDispatcher()
  let onPencilSqueeze = EventDispatcher()

  private var shortcutCommands: [UIKeyCommand] = []

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isAccessibilityElement = false

    let pencilInteraction = UIPencilInteraction()
    pencilInteraction.delegate = self
    addInteraction(pencilInteraction)

    // Selector-based observers are dropped with the view; no deinit needed.
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(claimKeyFocus), name: UIWindow.didBecomeKeyNotification, object: nil)
    center.addObserver(
      self, selector: #selector(claimKeyFocus), name: UIApplication.didBecomeActiveNotification, object: nil)
  }

  // MARK: - Shortcuts

  func setCommands(_ commands: [SprayShortcutCommand]) {
    shortcutCommands = commands.compactMap { command in
      guard let input = Self.keyInput(for: command.input) else {
        return nil
      }
      let keyCommand = UIKeyCommand(
        title: command.title,
        action: #selector(handleShortcut(_:)),
        input: input,
        modifierFlags: Self.modifierFlags(command.modifiers),
        propertyList: command.id
      )
      // Delete, Escape and Return have system meanings too (text editing,
      // dismissing a sheet). Inside the editor they are the editor's.
      keyCommand.wantsPriorityOverSystemBehavior = true
      return keyCommand
    }
    claimKeyFocus()
  }

  override var canBecomeFirstResponder: Bool {
    window != nil && !shortcutCommands.isEmpty
  }

  override var keyCommands: [UIKeyCommand]? {
    shortcutCommands
  }

  @objc private func handleShortcut(_ sender: UIKeyCommand) {
    guard let id = sender.propertyList as? String else {
      return
    }
    onShortcut(["id": id])
  }

  // MARK: - Keyboard focus

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      if isFirstResponder {
        resignFirstResponder()
      }
      return
    }
    // After the mount transaction, so the rest of the editor is in the window too.
    DispatchQueue.main.async { [weak self] in
      self?.claimKeyFocus()
    }
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    if !isFirstResponder, event?.type == .touches {
      DispatchQueue.main.async { [weak self] in
        self?.claimKeyFocus()
      }
    }
    return super.hitTest(point, with: event)
  }

  @objc private func claimKeyFocus() {
    guard let window, window.isKeyWindow, !isFirstResponder, canBecomeFirstResponder else {
      return
    }
    // Someone typing keeps the keyboard. The editor has no text field, but a
    // screen with one can sit over it while this view is still in the window.
    if FirstResponderProbe.current() is UIKeyInput {
      return
    }
    becomeFirstResponder()
  }

  // MARK: - Apple Pencil

  /// Before iPadOS 17.5. Never called on 17.5 and later, which call the
  /// `didReceiveTap` variant below instead.
  func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
    onPencilTap(["preferredAction": Self.actionName(UIPencilInteraction.preferredTapAction)])
  }

  @available(iOS 17.5, *)
  func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
    onPencilTap(Self.payload(UIPencilInteraction.preferredTapAction, hoverLocation: tap.hoverPose?.location))
  }

  /// Pencil Pro only. Acts once, when the squeeze is let go, as Apple asks: a
  /// squeeze that began but was cancelled does nothing.
  @available(iOS 17.5, *)
  func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
    guard squeeze.phase == .ended else {
      return
    }
    onPencilSqueeze(Self.payload(UIPencilInteraction.preferredSqueezeAction, hoverLocation: squeeze.hoverPose?.location))
  }

  // MARK: - Mapping

  /// The hover point is in this view's coordinates, which JS lays over the
  /// editor exactly, so the palette can open under the Pencil tip.
  private static func payload(_ action: UIPencilPreferredAction, hoverLocation: CGPoint?) -> [String: Any] {
    var payload: [String: Any] = ["preferredAction": actionName(action)]
    if let hoverLocation {
      payload["x"] = Double(hoverLocation.x)
      payload["y"] = Double(hoverLocation.y)
    }
    return payload
  }

  /// The system setting, named for JS (`PencilPreferredAction`). JS decides what
  /// each means in the editor.
  private static func actionName(_ action: UIPencilPreferredAction) -> String {
    if #available(iOS 17.5, *) {
      if action == .showContextualPalette {
        return "showContextualPalette"
      }
      if action == .runSystemShortcut {
        return "runSystemShortcut"
      }
    }
    switch action {
    case .ignore:
      return "ignore"
    case .switchEraser:
      return "switchEraser"
    case .switchPrevious:
      return "switchPrevious"
    case .showColorPalette:
      return "showColorPalette"
    case .showInkAttributes:
      return "showInkAttributes"
    default:
      return "unknown"
    }
  }

  private static func keyInput(for token: String) -> String? {
    switch token {
    case "escape":
      return UIKeyCommand.inputEscape
    case "return":
      return "\r"
    case "backspace":
      return "\u{8}"
    case "delete":
      return UIKeyCommand.inputDelete
    default:
      return token.count == 1 ? token : nil
    }
  }

  private static func modifierFlags(_ modifiers: [String]) -> UIKeyModifierFlags {
    var flags: UIKeyModifierFlags = []
    for modifier in modifiers {
      switch modifier {
      case "command":
        flags.insert(.command)
      case "shift":
        flags.insert(.shift)
      case "option":
        flags.insert(.alternate)
      case "control":
        flags.insert(.control)
      default:
        break
      }
    }
    return flags
  }
}

/// UIKit has no public "who is first responder?". A nil-targeted action is
/// delivered to the first responder, so it reports itself.
private enum FirstResponderProbe {
  static weak var found: UIResponder?

  static func current() -> UIResponder? {
    found = nil
    UIApplication.shared.sendAction(
      #selector(UIResponder.sprayEditorInputReportFirstResponder(_:)), to: nil, from: nil, for: nil)
    return found
  }
}

extension UIResponder {
  @objc fileprivate func sprayEditorInputReportFirstResponder(_ sender: Any?) {
    FirstResponderProbe.found = self
  }
}
