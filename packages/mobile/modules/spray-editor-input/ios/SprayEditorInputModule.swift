import ExpoModulesCore

/// The spray-wall hold editor's hardware keyboard and Apple Pencil gestures.
///
/// iOS has no JS path to either: React Native 0.86's `onKeyDown` is Android
/// only, and nothing in the app references `UIPencilInteraction`. So the editor
/// mounts one invisible view (`SprayEditorKeyScopeView`) while it is open. JS
/// hands it the shortcut list — keys, modifiers and the localised titles the
/// Cmd-hold overlay shows — and the view reports each shortcut, and each Pencil
/// double tap or squeeze, back as an event. Which handler a shortcut runs is
/// decided in JS (`spray-editor-shortcuts.ts`), so that part ships by OTA.
public class SprayEditorInputModule: Module {
  public func definition() -> ModuleDefinition {
    // The contract with JS: modules/spray-editor-input/src/index.ts resolves
    // this name with requireOptionalNativeModule before it asks for the view,
    // so a binary without this module (every store build before it shipped)
    // renders nothing instead of an unknown native component. Renaming it turns
    // every caller into that absent path, silently.
    Name("SprayEditorInput")

    View(SprayEditorKeyScopeView.self) {
      Events("onShortcut", "onPencilTap", "onPencilSqueeze")

      Prop("commands") { (view: SprayEditorKeyScopeView, commands: [SprayShortcutCommand]) in
        view.setCommands(commands)
      }
    }
  }
}

/// One key the editor answers, as JS describes it (`NativeShortcutCommand`).
struct SprayShortcutCommand: Record {
  /// Which shortcut this is. Sent back unchanged in `onShortcut`.
  @Field var id: String = ""
  /// One character, or a named key: `escape`, `return`, `backspace`, `delete`.
  @Field var input: String = ""
  /// Any of `command`, `shift`, `option`, `control`.
  @Field var modifiers: [String] = []
  /// What the Cmd-hold overlay calls it. Empty keeps an alternate key (Delete
  /// next to Backspace, say) out of the overlay so it is not listed twice.
  @Field var title: String = ""
}
