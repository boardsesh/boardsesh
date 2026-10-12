import Foundation
import os.log
import Security

/// Shared-access-group Keychain helper for credentials that the widget
/// extension also needs to read (currently the user's app auth token and
/// the APNs Live Activity push token used as a Bearer credential on
/// `/api/widget/navigate`).
///
/// Why not App Group UserDefaults?
/// - UserDefaults are stored in plaintext on disk inside the App Group
///   container, so any process with file-system access (including
///   forensic tools on a confiscated device) can read them.
/// - Keychain entries are encrypted at rest by the Secure Enclave and
///   only accessible to processes that hold the matching
///   `keychain-access-groups` entitlement. Sharing across the main app
///   and the widget extension is still possible via the access-group
///   prefix, but processes outside the group can't read them.
///
/// Accessibility is `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`:
/// - Available after the user unlocks the device once per boot, so
///   widget extensions can read it while the phone is locked.
/// - `ThisDeviceOnly` keeps it out of iCloud Keychain backups, since
///   these are short-lived per-session credentials.
enum SharedKeychain {
    private static let logger = Logger(subsystem: "com.boardsesh.app", category: "SharedKeychain")

    /// Keychain access group suffix declared in both `App.entitlements` and
    /// `BoardseshWidgets.entitlements`.
    private static let accessGroupSuffix = ".\(SharedConstants.appGroupId)"

    /// Resolved keychain access group. Keychain queries need the fully
    /// expanded entitlement value, including the app identifier prefix. The
    /// build setting is expanded into both app and widget Info.plists so this
    /// remains extension-safe.
    private static let accessGroup: String? = {
        guard let plistGroup = Bundle.main.object(forInfoDictionaryKey: "BoardseshKeychainAccessGroup") as? String else {
            return unresolvedAccessGroup("missing BoardseshKeychainAccessGroup")
        }

        let trimmedGroup = plistGroup.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedGroup.isEmpty else {
            return unresolvedAccessGroup("empty BoardseshKeychainAccessGroup")
        }
        guard !trimmedGroup.contains("$(") else {
            return unresolvedAccessGroup("unexpanded BoardseshKeychainAccessGroup: \(trimmedGroup)")
        }
        guard trimmedGroup.hasSuffix(accessGroupSuffix) else {
            return unresolvedAccessGroup("unexpected BoardseshKeychainAccessGroup suffix: \(trimmedGroup)")
        }

        return trimmedGroup
    }()

    static let authTokenKey = "bs_auth_token"
    static let livePushTokenKey = "bs_live_push_token"
    /// Persisted record describing a push-token registration that didn't make
    /// it through to the backend yet. Stored as JSON. Cleared on success and
    /// on session end. Schema:
    /// `{"token": "...", "sessionId": "...", "serverUrl": "https://..."}`
    static let pendingPushRegistrationKey = "bs_pending_push_registration"

    // MARK: - Public API

    /// Write a string value to the shared keychain. Replaces any existing
    /// value for the same account key. No-op (returns `false`) on failure.
    @discardableResult
    static func set(_ value: String, for key: String) -> Bool {
        guard let data = value.data(using: .utf8) else { return false }
        guard var query = baseQuery(for: key) else {
            logUnavailable("set", key: key)
            return false
        }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return true
        }
        if updateStatus != errSecItemNotFound {
            logFailure("update", key: key, status: updateStatus)
            return false
        }

        // No existing item — insert a fresh one.
        for (k, v) in attributes {
            query[k] = v
        }
        let addStatus = SecItemAdd(query as CFDictionary, nil)
        if addStatus != errSecSuccess {
            logFailure("add", key: key, status: addStatus)
            return false
        }
        return true
    }

    /// Read a string value from the shared keychain, or `nil` if absent.
    static func get(_ key: String) -> String? {
        guard var query = baseQuery(for: key) else {
            logUnavailable("read", key: key)
            return nil
        }
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnData as String] = true

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            if status != errSecItemNotFound {
                logFailure("read", key: key, status: status)
            }
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    /// Delete the value associated with `key`. No-op if absent.
    static func remove(_ key: String) {
        guard let query = baseQuery(for: key) else {
            logUnavailable("delete", key: key)
            return
        }
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            logFailure("delete", key: key, status: status)
        }
    }

    // MARK: - Internals

    private static func baseQuery(for key: String) -> [String: Any]? {
        guard let resolvedAccessGroup = accessGroup else { return nil }

        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrAccessGroup as String: resolvedAccessGroup,
        ]
    }

    private static func unresolvedAccessGroup(_ reason: String) -> String? {
        let message = "[SharedKeychain] Invalid keychain access group configuration: \(reason). " +
            "Set BoardseshKeychainAccessGroup in each Info.plist to $(AppIdentifierPrefix)\(accessGroupSuffix)."
        logger.fault("\(message, privacy: .public)")
#if DEBUG
        fatalError(message)
#else
        return nil
#endif
    }

    private static func logUnavailable(_ operation: String, key: String) {
        logger.error(
            "[SharedKeychain] \(operation, privacy: .public) skipped for \(key, privacy: .public): keychain access group unavailable"
        )
    }

    private static func logFailure(_ operation: String, key: String, status: OSStatus) {
        logger.error(
            "[SharedKeychain] \(operation, privacy: .public) failed for \(key, privacy: .public): OSStatus \(String(status), privacy: .public)"
        )
    }
}
