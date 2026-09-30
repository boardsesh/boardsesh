import ExpoModulesCore

@_silgen_name("boardsesh_diagnostics_abort")
private func boardseshDiagnosticsAbort()

public class MobileDiagnosticsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MobileDiagnostics")
    Constants([
      "nativeInitVersion": 1,
      "nativeStartupId": UserDefaults.standard.string(forKey: "boardsesh.diagnostics.startupId") ?? "",
      "previousNativeStartupId": UserDefaults.standard.bool(forKey: "boardsesh.diagnostics.startupMarkerDurable") ? UserDefaults.standard.string(forKey: "boardsesh.diagnostics.previousStartupId") ?? "" : ""
    ])
    Function("crashNativeAbort") {
      #if !DEBUG
      boardseshDiagnosticsAbort()
      #endif
    }
  }
}
