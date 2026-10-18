import CoreBluetooth
import XCTest

/// When the app asks for Bluetooth. Creating a `CBCentralManager` while the
/// app's authorization is `.notDetermined` is what shows the system alert, and
/// the singleton used to create one at launch, before sign-in. These pin the
/// rule: the central exists at launch only once the climber has answered, a
/// scan or an explicit `requestAuthorization` creates it otherwise, and every
/// state read, teardown and Live Activity path leaves it alone.
///
/// The creation seam counts instead of creating: the XCTest host has no
/// bluetooth-central background mode, so a real central with a restore
/// identifier would crash it.
@available(iOS 17.0, *)
final class BoardBleCentralCreationTests: XCTestCase {
    private var scheduler: FakeBleTimerScheduler!
    private var manager: BoardBleManager!
    private var authorization: CBManagerAuthorization = .notDetermined
    private var centralCreations = 0

    override func setUp() {
        super.setUp()
        authorization = .notDetermined
        centralCreations = 0
        scheduler = FakeBleTimerScheduler()
        manager = BoardBleManager(
            timerScheduler: scheduler,
            createCentralManagerEagerly: false,
            authorizationProvider: { [unowned self] in self.authorization }
        )
        manager.testHooks.sync {
            manager.testHooks.setConfiguration(nil)
            manager.testHooks.setCentralManagerCreationOverride { [weak self] in
                self?.centralCreations += 1
            }
        }
    }

    override func tearDown() {
        manager.testHooks.sync {
            manager.testHooks.setCentralManagerCreationOverride(nil)
            manager.testHooks.setCentralState(nil)
        }
        manager = nil
        scheduler = nil
        super.tearDown()
    }

    private func failureDescription(_ result: Result<Void, Error>?) -> String? {
        guard case .failure(let error)? = result else { return nil }
        return error.localizedDescription
    }

    // MARK: - Launch

    func testLaunchCreatesTheCentralOnlyOnceTheQuestionIsAnswered() {
        XCTAssertFalse(BoardBleManager.shouldCreateCentralManagerAtLaunch(authorization: .notDetermined))
        // Everyone who already answered keeps today's launch-time central, which
        // CoreBluetooth state restoration depends on.
        XCTAssertTrue(BoardBleManager.shouldCreateCentralManagerAtLaunch(authorization: .allowedAlways))
        XCTAssertTrue(BoardBleManager.shouldCreateCentralManagerAtLaunch(authorization: .denied))
        XCTAssertTrue(BoardBleManager.shouldCreateCentralManagerAtLaunch(authorization: .restricted))
    }

    func testAuthorizationNamesMatchTheJsContract() {
        XCTAssertEqual(BoardBleManager.authorizationName(.notDetermined), "notDetermined")
        XCTAssertEqual(BoardBleManager.authorizationName(.allowedAlways), "allowedAlways")
        XCTAssertEqual(BoardBleManager.authorizationName(.denied), "denied")
        XCTAssertEqual(BoardBleManager.authorizationName(.restricted), "restricted")
    }

    // MARK: - Paths that must not ask

    func testStateReadsAndTeardownNeverCreateTheCentral() {
        manager.testHooks.sync {
            // A central nobody created reads .unknown, which keeps counting as
            // available, as a fresh central did before its first update.
            XCTAssertTrue(manager.isAvailable)
            XCTAssertNil(manager.connectedDeviceInfo)
            manager.stopScan()
            manager.cancelWrites()
        }

        XCTAssertEqual(centralCreations, 0)
    }

    func testLiveActivityReconnectFailsWithoutAsking() {
        // An unanswered question means no board was ever connected, so there is
        // nothing to reconnect to, and a lightbulb tap must not raise the alert.
        var results: [Result<Void, Error>] = []
        manager.testHooks.sync {
            manager.reconnectToLastKnownBoard(origin: .liveActivityIntent) { results.append($0) }
        }

        XCTAssertEqual(centralCreations, 0)
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(failureDescription(results.first), BoardBleError.bluetoothUnavailable.localizedDescription)
    }

    func testConnectWithoutAScanFailsWithoutAsking() {
        var results: [Result<Void, Error>] = []
        manager.testHooks.sync {
            manager.connect(deviceId: UUID().uuidString) { results.append($0) }
        }

        XCTAssertEqual(centralCreations, 0)
        XCTAssertEqual(failureDescription(results.first), BoardBleError.bluetoothUnavailable.localizedDescription)
    }

    // MARK: - Paths that ask

    func testAScanCreatesTheCentralAndWaitsForTheAnswerToStart() {
        var results: [Result<Void, Error>] = []
        manager.testHooks.sync {
            manager.startScan(serviceUuids: []) { results.append($0) }
        }

        XCTAssertEqual(centralCreations, 1)
        // Not powered on yet (the alert is up): the scan is remembered and
        // starts from centralManagerDidUpdateState after an Allow.
        XCTAssertEqual(results.count, 1)
        XCTAssertNil(failureDescription(results.first))
    }

    func testRequestAuthorizationWaitsForAnAllowThenReportsIt() {
        var answers: [CBManagerAuthorization] = []
        manager.testHooks.sync {
            manager.requestAuthorization { answers.append($0) }
        }

        XCTAssertEqual(centralCreations, 1)
        XCTAssertEqual(answers, [])
        XCTAssertTrue(manager.testHooks.sync { manager.testHooks.hasPendingAuthorizationAnswer })

        // The climber taps Allow: CoreBluetooth reports the first real state.
        authorization = .allowedAlways
        manager.testHooks.fireCentralStateUpdate(.poweredOn)

        XCTAssertEqual(answers, [.allowedAlways])
        XCTAssertFalse(manager.testHooks.sync { manager.testHooks.hasPendingAuthorizationAnswer })
        XCTAssertEqual(scheduler.lastOneShot(label: "authorizationAnswerWatchdog")?.cancelled, true)
        XCTAssertEqual(scheduler.repeatingTimers.last?.cancelled, true)
    }

    func testRequestAuthorizationReportsDontAllow() {
        var answers: [CBManagerAuthorization] = []
        manager.testHooks.sync {
            manager.requestAuthorization { answers.append($0) }
        }

        authorization = .denied
        manager.testHooks.fireCentralStateUpdate(.unauthorized)

        XCTAssertEqual(answers, [.denied])
    }

    func testRequestAuthorizationKeepsWaitingThroughAStateUpdateBeforeTheAnswer() {
        var answers: [CBManagerAuthorization] = []
        manager.testHooks.sync {
            manager.requestAuthorization { answers.append($0) }
        }

        // A state update while the alert is still up is not an answer.
        manager.testHooks.fireCentralStateUpdate(.unauthorized)
        XCTAssertEqual(answers, [])

        // The answer then lands with no further state change: the poller
        // catches it.
        authorization = .denied
        manager.testHooks.sync {
            manager.testHooks.setCentralState(.unauthorized)
            scheduler.repeatingTimers.last?.fire()
        }

        XCTAssertEqual(answers, [.denied])
    }

    func testRequestAuthorizationGivesUpAtTheWatchdog() {
        var answers: [CBManagerAuthorization] = []
        manager.testHooks.sync {
            manager.requestAuthorization { answers.append($0) }
            scheduler.lastOneShot(label: "authorizationAnswerWatchdog")?.fire()
        }

        XCTAssertEqual(answers, [.notDetermined])
        XCTAssertEqual(scheduler.repeatingTimers.last?.cancelled, true)
    }

    func testRequestAuthorizationAnswersAtOnceWhenAlreadyAnswered() {
        authorization = .denied
        var answers: [CBManagerAuthorization] = []
        manager.testHooks.sync {
            manager.requestAuthorization { answers.append($0) }
        }

        XCTAssertEqual(answers, [.denied])
        XCTAssertNil(scheduler.lastOneShot(label: "authorizationAnswerWatchdog"))
    }

    func testConcurrentRequestsShareOneWaitAndAllHearTheAnswer() {
        var answers: [CBManagerAuthorization] = []
        manager.testHooks.sync {
            manager.requestAuthorization { answers.append($0) }
            manager.requestAuthorization { answers.append($0) }
        }

        XCTAssertEqual(scheduler.oneShots(label: "authorizationAnswerWatchdog").count, 1)

        authorization = .allowedAlways
        manager.testHooks.fireCentralStateUpdate(.poweredOff)

        XCTAssertEqual(answers, [.allowedAlways, .allowedAlways])
    }
}
