import Foundation
import XCTest

final class BoardBleEvidenceTests: XCTestCase {
    func testDataBeforeNameAndLateServiceDataSurviveUnchangedIdentity() {
        var scan = BoardBleEvidenceScan(scanId: "scan-a")
        scan.observe(deviceId: "one", localName: nil, cachedName: nil, serviceUuids: [], manufacturerData: "000123", serviceData: nil)
        scan.observe(deviceId: "one", localName: "MoonBoard", cachedName: "Old name", serviceUuids: [], manufacturerData: nil, serviceData: ["FFF0": "000012"])
        XCTAssertEqual(scan.devices["one"]?.manufacturerData, "000123")
        XCTAssertEqual(scan.devices["one"]?.serviceData["fff0"], "000012")
        XCTAssertEqual(scan.devices["one"]?.cachedName, "Old name")
        XCTAssertEqual(scan.devices["one"]?.localName, "MoonBoard")
        XCTAssertEqual((scan.dictionary(selectedDeviceId: "")["devices"] as? [[String: Any]])?.count, 1)
    }

    func testSameNameControllersRemainDistinctAndFrozenSnapshotRejectsLatePackets() {
        var scan = BoardBleEvidenceScan(scanId: "scan-a")
        for deviceId in ["one", "two"] {
            scan.observe(deviceId: deviceId, localName: "MoonBoard", cachedName: nil, serviceUuids: [], manufacturerData: "00", serviceData: nil)
        }
        scan.finish()
        scan.observe(deviceId: "one", localName: "MoonBoard", cachedName: nil, serviceUuids: [], manufacturerData: "ff", serviceData: nil)
        XCTAssertEqual(scan.devices.count, 2)
        XCTAssertEqual(scan.devices["one"]?.manufacturerData, "00")
        XCTAssertEqual(scan.dictionary(selectedDeviceId: "")["complete"] as? Bool, true)
    }

    func testGenericUartIsUnknownUntilExplicitlySelected() {
        var scan = BoardBleEvidenceScan(scanId: "scan")
        scan.observe(deviceId: "unknown", localName: "Sensor", cachedName: nil, serviceUuids: ["6e400001-b5a3-f393-e0a9-e50e24dcca9e"], manufacturerData: "0000", serviceData: nil)
        XCTAssertEqual((scan.dictionary(selectedDeviceId: "")["devices"] as? [[String: Any]])?.count, 0)
        XCTAssertEqual((scan.dictionary(selectedDeviceId: "unknown")["devices"] as? [[String: Any]])?.count, 1)
    }

    func testRecognizedBoardSurvivesUnrelatedTrafficAndRawPayloadsAreBounded() {
        var scan = BoardBleEvidenceScan(scanId: "scan")
        scan.observe(deviceId: "board", localName: "Kilter Board", cachedName: nil, serviceUuids: [], manufacturerData: String(repeating: "ab", count: 600), serviceData: nil)
        for index in 0..<200 {
            scan.observe(deviceId: "sensor-\(index)", localName: nil, cachedName: nil, serviceUuids: [], manufacturerData: nil, serviceData: nil)
        }
        XCTAssertNotNil(scan.devices["board"])
        XCTAssertEqual(scan.devices["board"]?.manufacturerData?.count, 1024)
        XCTAssertEqual(scan.devices["board"]?.truncated, true)
        XCTAssertLessThanOrEqual(scan.devices.count, 129)
        XCTAssertGreaterThan(scan.droppedCount, 0)
    }

    func testNewScanCannotReuseOldObservation() {
        var oldScan = BoardBleEvidenceScan(scanId: "old")
        oldScan.observe(deviceId: "same-handle", localName: "MoonBoard", cachedName: nil, serviceUuids: [], manufacturerData: "ab", serviceData: nil)
        let newScan = BoardBleEvidenceScan(scanId: "new")
        XCTAssertTrue(newScan.devices.isEmpty)
        XCTAssertEqual(newScan.dictionary(selectedDeviceId: "same-handle")["scanId"] as? String, "new")
    }
}
