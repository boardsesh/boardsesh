import Darwin
import ExpoModulesCore
import Foundation
import NetworkExtension

/**
 * Joins a device's own hotspot (WLED-AP) with NEHotspotConfiguration. iOS shows
 * its "Join Wi-Fi network" alert; `joinOnce` keeps the network only while the
 * app is in the foreground. iOS cannot bind requests to one network, so a join
 * only counts once a Wi-Fi interface has an IPv4 address on the host's /24:
 * then the host is on the local subnet and a request never leaves over mobile
 * data. That check reads interface addresses only, so it needs no Wi-Fi-info
 * entitlement or location permission.
 */
public class WifiJoinModule: Module {
    private let lock = NSLock()
    private var generation = 0
    private var configuredSsid: String?
    private var subnet: UInt32?

    public func definition() -> ModuleDefinition {
        Name("WifiJoin")

        // Resolves { joined } and never rejects, so no platform message reaches JS.
        AsyncFunction("join") { (ssid: String, passphrase: String?, timeoutMs: Int, hostIp: String, promise: Promise) in
            guard let hostSubnet = Self.subnet24(of: hostIp) else {
                promise.resolve(["joined": false, "error": "failed"])
                return
            }
            let current: Int = self.locked {
                self.generation += 1
                self.configuredSsid = ssid
                self.subnet = hostSubnet
                return self.generation
            }
            let configuration: NEHotspotConfiguration
            if let passphrase = passphrase, !passphrase.isEmpty {
                configuration = NEHotspotConfiguration(ssid: ssid, passphrase: passphrase, isWEP: false)
            } else {
                configuration = NEHotspotConfiguration(ssid: ssid)
            }
            configuration.joinOnce = true
            let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
            NEHotspotConfigurationManager.shared.apply(configuration) { error in
                if let failure = Self.joinError(error) {
                    self.forget(generation: current, removeConfiguration: false)
                    promise.resolve(["joined": false, "error": failure])
                    return
                }
                // apply() can report success before (or without) associating, e.g.
                // when the hotspot is out of range. Wait for a local address.
                self.poll(generation: current, subnet: hostSubnet, deadline: deadline, promise: promise)
            }
        }.runOnQueue(.main)

        AsyncFunction("release") { () in
            self.forget(generation: nil, removeConfiguration: true)
        }.runOnQueue(.main)

        Function("isJoined") { () -> Bool in
            let target: UInt32? = self.locked { self.configuredSsid == nil ? nil : self.subnet }
            guard let target = target else { return false }
            return Self.hasWifiAddress(in: target)
        }

        OnDestroy {
            self.forget(generation: nil, removeConfiguration: true)
        }
    }

    private func poll(generation current: Int, subnet target: UInt32, deadline: Date, promise: Promise) {
        let stillCurrent: Bool = locked { self.generation == current }
        guard stillCurrent else {
            promise.resolve(["joined": false, "error": "failed"])
            return
        }
        if Self.hasWifiAddress(in: target) {
            promise.resolve(["joined": true])
            return
        }
        if Date() >= deadline {
            forget(generation: current, removeConfiguration: true)
            promise.resolve(["joined": false, "error": "timeout"])
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            self.poll(generation: current, subnet: target, deadline: deadline, promise: promise)
        }
    }

    /// Clears state for `generation` (or unconditionally when nil) and drops the configuration.
    private func forget(generation expected: Int?, removeConfiguration: Bool) {
        let ssid: String? = locked {
            if let expected = expected, expected != self.generation { return nil }
            self.generation += 1
            let previous = self.configuredSsid
            self.configuredSsid = nil
            self.subnet = nil
            return previous
        }
        if removeConfiguration, let ssid = ssid {
            NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid)
        }
    }

    private func locked<Result>(_ body: () -> Result) -> Result {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    private static func joinError(_ error: Error?) -> String? {
        guard let error = error as NSError? else { return nil }
        guard error.domain == NEHotspotConfigurationErrorDomain,
              let code = NEHotspotConfigurationError(rawValue: error.code) else { return "failed" }
        switch code {
        case .alreadyAssociated: return nil
        case .userDenied: return "user-denied"
        case .invalidWPAPassphrase, .invalidWEPPassphrase: return "wrong-password"
        default: return "failed"
        }
    }

    /// The /24 network of a dotted IPv4 address, in host byte order.
    private static func subnet24(of address: String) -> UInt32? {
        var parsed = in_addr()
        guard inet_pton(AF_INET, address, &parsed) == 1 else { return nil }
        return UInt32(bigEndian: parsed.s_addr) & 0xFFFF_FF00
    }

    private static func hasWifiAddress(in target: UInt32) -> Bool {
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0, let first = interfaces else { return false }
        defer { freeifaddrs(interfaces) }
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let entry = cursor {
            defer { cursor = entry.pointee.ifa_next }
            let flags = Int32(entry.pointee.ifa_flags)
            guard (flags & IFF_UP) != 0, (flags & IFF_RUNNING) != 0,
                  let socketAddress = entry.pointee.ifa_addr,
                  socketAddress.pointee.sa_family == UInt8(AF_INET),
                  String(cString: entry.pointee.ifa_name).hasPrefix("en") else { continue }
            let address = socketAddress.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
                UInt32(bigEndian: $0.pointee.sin_addr.s_addr)
            }
            if address & 0xFFFF_FF00 == target { return true }
        }
        return false
    }
}
