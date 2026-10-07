import ExpoModulesCore
import StoreKit

/// Expo Module bridge that reports which App Store storefront the running app is
/// signed in to. StoreKit 2's `Storefront.current` reads the storefront of the
/// signed-in Apple Account, which is what App Review treats as the user's store —
/// not the device region, locale, or IP country, all of which can disagree with it.
///
/// `countryCode` is ISO 3166-1 alpha-3 ("USA", "GBR", "NLD"), *not* alpha-2.
/// Callers comparing against a country must use the three-letter form.
///
/// The value is nil when StoreKit has no storefront to report: no signed-in
/// Apple Account, or a simulator/sandbox build without a StoreKit configuration.
/// Callers must treat nil as "unknown", never as "allowed".
public class StorefrontModule: Module {
    public func definition() -> ModuleDefinition {
        // This string is the contract with JS: consumers resolve the module with
        // requireOptionalNativeModule('Storefront') rather than importing this
        // package, so renaming it silently turns every caller into the
        // module-absent path.
        Name("Storefront")

        AsyncFunction("getCountryCode") { () async -> String? in
            await StoreKit.Storefront.current?.countryCode
        }
    }
}
