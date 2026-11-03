import CoreBluetooth
import XCTest

@available(iOS 17.0, *)
final class LiveActivityWidgetTests: XCTestCase {
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "com.boardsesh.rn.live-activity-tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    private func prepareMirror() {
        defaults.set("session", forKey: SharedConstants.sessionIdKey)
        defaults.set(true, forKey: SharedConstants.supportsMirroringKey)
        SharedWidgetWallControlState.save(navigationAllowed: true, isPartySession: true, to: defaults)
        SharedWidgetWallControlState.saveBoardConnection("connectedByMe", holderDisplayName: nil, to: defaults)
        SharedQueueState.save(items: [makeQueueItem()], currentIndex: 0, to: defaults)
    }

    func testMirrorReceiptSurvivesReplayAndRejectsOldAcknowledgement() {
        prepareMirror()
        let receipt = SharedMirrorConfirmation(sessionId: "session", queueItemUuid: "queue-1", mirrored: true, sequence: 5, stateHash: "hash", stateHashOrdered: nil)
        XCTAssertNotNil(SharedMirrorState.apply(receipt, in: defaults))
        XCTAssertEqual(SharedQueueState.load(from: defaults).0.first?.mirrored, true)
        XCTAssertEqual(SharedMirrorState.pending(in: defaults), receipt)
        SharedMirrorState.acknowledge(sessionId: "other", sequence: 6, in: defaults)
        SharedMirrorState.acknowledge(sessionId: "session", sequence: 4, in: defaults)
        XCTAssertNotNil(SharedMirrorState.pending(in: defaults))
        SharedMirrorState.acknowledge(sessionId: "session", sequence: 5, in: defaults)
        XCTAssertNil(SharedMirrorState.pending(in: defaults))
    }

    func testOlderMirrorResponseCannotOverwriteNewerNativeState() {
        prepareMirror()
        XCTAssertTrue(SharedMirrorState.persist(items: [makeQueueItem(mirrored: false)], currentIndex: 0, sequence: 7, in: defaults))
        let receipt = SharedMirrorConfirmation(sessionId: "session", queueItemUuid: "queue-1", mirrored: true, sequence: 6, stateHash: "hash", stateHashOrdered: nil)
        // The newer native snapshot wins, but the caller still gets it back so
        // it republishes current truth instead of leaving the widget stale.
        let snapshot = SharedMirrorState.apply(receipt, in: defaults)
        XCTAssertEqual(snapshot?.items.first?.mirrored, false)
        XCTAssertEqual(SharedQueueState.load(from: defaults).0.first?.mirrored, false)
        XCTAssertEqual(SharedMirrorState.sequence(in: defaults), 7)
        // A stale receipt is not stored, so it cannot displace a newer one.
        XCTAssertNil(SharedMirrorState.pending(in: defaults))
    }

    func testMirrorCommitsWhenTheCurrentSlotMovedWhileTheRequestWasInFlight() {
        prepareMirror()
        // A widget Next landed between the tap and the 200. The tapped item is
        // no longer at the current index, but the server already refused a stale
        // slot, so the confirmed orientation still has to reach the wall.
        SharedQueueState.save(
            items: [makeQueueItem(uuid: "queue-1"), makeQueueItem(uuid: "queue-2", climbUuid: "climb-2")],
            currentIndex: 1,
            to: defaults
        )
        let receipt = SharedMirrorConfirmation(sessionId: "session", queueItemUuid: "queue-1", mirrored: true, sequence: 9, stateHash: "hash", stateHashOrdered: nil)
        let snapshot = SharedMirrorState.apply(receipt, in: defaults)
        XCTAssertEqual(snapshot?.items.first?.mirrored, true)
        XCTAssertEqual(snapshot?.index, 1)
        XCTAssertEqual(SharedQueueState.load(from: defaults).0.first?.mirrored, true)
    }

    func testMirrorTapSurvivesAMovedIndexAtThePreRequestGate() {
        prepareMirror()
        SharedQueueState.save(
            items: [makeQueueItem(uuid: "queue-1"), makeQueueItem(uuid: "queue-2", climbUuid: "climb-2")],
            currentIndex: 1,
            to: defaults
        )
        XCTAssertTrue(SharedMirrorState.canMirror(sessionId: "session", queueItemUuid: "queue-1", in: defaults))
        XCTAssertFalse(SharedMirrorState.canMirror(sessionId: "session", queueItemUuid: "missing", in: defaults))
    }

    func testMirrorTapIsNotGatedOnTheNavigationAllowedFlag() {
        prepareMirror()
        // The button renders on connectedByMe alone, so a drifted
        // navigationAllowed flag must not silently swallow the tap.
        SharedWidgetWallControlState.save(navigationAllowed: false, isPartySession: true, to: defaults)
        XCTAssertTrue(SharedMirrorState.canMirror(sessionId: "session", queueItemUuid: "queue-1", in: defaults))
    }

    func testUnrelatedSequenceBumpDoesNotCancelTheBoardWrite() {
        prepareMirror()
        let receipt = SharedMirrorConfirmation(sessionId: "session", queueItemUuid: "queue-1", mirrored: true, sequence: 6, stateHash: "hash", stateHashOrdered: nil)
        XCTAssertNotNil(SharedMirrorState.apply(receipt, in: defaults))
        // A later event carrying the same mirrored slot arrives while the BLE
        // write is still awaiting readiness. Exact sequence equality used to
        // make `isCurrent` false here and silently drop the wall write.
        XCTAssertTrue(SharedMirrorState.persist(items: [makeQueueItem(mirrored: true)], currentIndex: 0, sequence: 11, in: defaults))
        XCTAssertTrue(SharedMirrorState.isCurrent(receipt, in: defaults))
        // A real change of orientation or slot still cancels it.
        XCTAssertTrue(SharedMirrorState.persist(items: [makeQueueItem(mirrored: false)], currentIndex: 0, sequence: 12, in: defaults))
        XCTAssertFalse(SharedMirrorState.isCurrent(receipt, in: defaults))
    }

    func testUnconfirmedMirrorRequestIsParkedForReplay() {
        prepareMirror()
        let request = SharedMirrorRequest(sessionId: "session", queueItemUuid: "queue-1", mirrored: true)
        SharedMirrorState.saveRequest(request, in: defaults)
        XCTAssertEqual(SharedMirrorState.pendingRequest(in: defaults), request)

        // Survives repeated handovers: only an explicit acknowledgement retires it,
        // so a replay that lands before the board link is back does not lose the tap.
        XCTAssertNotNil(SharedMirrorState.pendingRequest(in: defaults))
        XCTAssertNotNil(SharedMirrorState.pendingRequest(in: defaults))

        // Scoped to the session it was tapped in.
        defaults.set("other", forKey: SharedConstants.sessionIdKey)
        XCTAssertNil(SharedMirrorState.pendingRequest(in: defaults))
        defaults.set("session", forKey: SharedConstants.sessionIdKey)
        XCTAssertNotNil(SharedMirrorState.pendingRequest(in: defaults))

        SharedMirrorState.clearRequest(in: defaults)
        XCTAssertNil(SharedMirrorState.pendingRequest(in: defaults))
    }

    func testParkedMirrorRequestExpiresAndIsDroppedOnRead() {
        prepareMirror()
        let stale = Date().addingTimeInterval(-(SharedMirrorRequest.timeToLive + 60))
        SharedMirrorState.saveRequest(
            SharedMirrorRequest(sessionId: "session", queueItemUuid: "queue-1", mirrored: true, createdAt: stale),
            in: defaults
        )
        XCTAssertNil(SharedMirrorState.pendingRequest(in: defaults))
        // Dropped from storage, not just filtered on read.
        XCTAssertNil(defaults.data(forKey: SharedConstants.pendingMirrorRequestKey))
    }

    func testMirroredSlotThatIsNoLongerCurrentDoesNotPassTheBoardWriteGate() {
        prepareMirror()
        SharedQueueState.save(
            items: [makeQueueItem(uuid: "queue-1"), makeQueueItem(uuid: "queue-2", climbUuid: "climb-2")],
            currentIndex: 1,
            to: defaults
        )
        let receipt = SharedMirrorConfirmation(sessionId: "session", queueItemUuid: "queue-1", mirrored: true, sequence: 9, stateHash: "hash", stateHashOrdered: nil)
        XCTAssertNotNil(SharedMirrorState.apply(receipt, in: defaults))
        // queue-2 is on the wall, so the mirrored slot must not be written there.
        XCTAssertFalse(SharedMirrorState.isCurrent(receipt, in: defaults))
    }

    func testBufferedSocketSnapshotCannotUndoAcceptedMirror() {
        prepareMirror()
        let receipt = SharedMirrorConfirmation(sessionId: "session", queueItemUuid: "queue-1", mirrored: true, sequence: 6, stateHash: "hash", stateHashOrdered: nil)
        XCTAssertNotNil(SharedMirrorState.apply(receipt, in: defaults))
        XCTAssertFalse(SharedMirrorState.persist(items: [makeQueueItem()], currentIndex: 0, sequence: 5, in: defaults))
        XCTAssertTrue(SharedMirrorState.isCurrent(receipt, in: defaults))
        SharedWidgetWallControlState.saveBoardConnection("heldByPeer", holderDisplayName: "Crew", to: defaults)
        XCTAssertFalse(SharedMirrorState.isCurrent(receipt, in: defaults))
    }

    func testFreshSubscriptionCanRebaselineAfterServerSequenceReset() {
        prepareMirror()
        XCTAssertTrue(SharedMirrorState.persist(items: [makeQueueItem(mirrored: true)], currentIndex: 0, sequence: 8, in: defaults))
        XCTAssertFalse(SharedMirrorState.persist(items: [makeQueueItem()], currentIndex: 0, sequence: 2, subscriptionSequence: 7, in: defaults))
        XCTAssertTrue(SharedMirrorState.persist(items: [makeQueueItem()], currentIndex: 0, sequence: 2, subscriptionSequence: 8, in: defaults))
        XCTAssertEqual(SharedMirrorState.sequence(in: defaults), 2)
        XCTAssertFalse(SharedQueueState.load(from: defaults).0[0].mirrored)
    }

    private func makeQueueItem(
        uuid: String = "queue-1",
        climbUuid: String = "climb-1",
        climbName: String = "Test Climb",
        difficulty: String = "6c+/V5",
        angle: Int = 40,
        mirrored: Bool = false
    ) -> SharedQueueItem {
        SharedQueueItem(
            uuid: uuid,
            climbUuid: climbUuid,
            climbName: climbName,
            difficulty: difficulty,
            angle: angle,
            frames: "p1r12p2r13",
            setterUsername: "tester",
            mirrored: mirrored
        )
    }

    func testLocalSessionAllowsNavigationWithoutServerAuthorization() {
        defaults.set("local-activity-1", forKey: SharedConstants.sessionIdKey)

        let wallControl = SharedWidgetWallControlState.load(from: defaults)

        XCTAssertTrue(wallControl.navigationAllowed)
        XCTAssertFalse(wallControl.requiresServerAuthorization)
        XCTAssertEqual(SharedWidgetTakeControlRuntime.action(for: wallControl), .enableLocalNavigation)
    }

    func testLegacyPartySessionFailsClosedWhenDriverStateMissing() {
        defaults.set("session-party-1", forKey: SharedConstants.sessionIdKey)

        let wallControl = SharedWidgetWallControlState.load(from: defaults)

        XCTAssertFalse(wallControl.navigationAllowed)
        XCTAssertTrue(wallControl.requiresServerAuthorization)
        XCTAssertEqual(SharedWidgetTakeControlRuntime.action(for: wallControl), .requestServerAuthorization)
    }

    func testPartyNonDriverRequiresServerTakeControl() {
        SharedWidgetWallControlState.save(navigationAllowed: false, isPartySession: true, to: defaults)

        let wallControl = SharedWidgetWallControlState.load(from: defaults)

        XCTAssertFalse(wallControl.navigationAllowed)
        XCTAssertTrue(wallControl.requiresServerAuthorization)
        XCTAssertEqual(SharedWidgetTakeControlRuntime.action(for: wallControl), .requestServerAuthorization)
    }

    func testPartyDriverDoesNotRequestTakeControlAgain() {
        SharedWidgetWallControlState.save(navigationAllowed: true, isPartySession: true, to: defaults)

        let wallControl = SharedWidgetWallControlState.load(from: defaults)

        XCTAssertTrue(wallControl.navigationAllowed)
        XCTAssertTrue(wallControl.requiresServerAuthorization)
        XCTAssertEqual(SharedWidgetTakeControlRuntime.action(for: wallControl), .alreadyAllowed)
    }

    func testReconnectDiagnosticKeepsBleFailureWhenTakeControlAlsoFails() {
        XCTAssertEqual(
            ReconnectBoardIntent.diagnosticCompletionClass(
                current: .bleFailure,
                networkResult: .serverRejected
            ),
            .bleFailure
        )
        XCTAssertEqual(
            ReconnectBoardIntent.diagnosticCompletionClass(
                current: .bleFailure,
                networkResult: .retryableFailure
            ),
            .bleFailure
        )
    }

    func testReconnectDiagnosticRecordsNetworkFailureAfterSuccessfulBleReconnect() {
        XCTAssertEqual(
            ReconnectBoardIntent.diagnosticCompletionClass(
                current: .success,
                networkResult: .serverRejected
            ),
            .serverRejected
        )
        XCTAssertEqual(
            ReconnectBoardIntent.diagnosticCompletionClass(
                current: .success,
                networkResult: .retryableFailure
            ),
            .retryableNetworkFailure
        )
    }

    func testMarkControlClaimedEnablesPartyNavigationButKeepsAuthorization() {
        SharedWidgetWallControlState.save(navigationAllowed: false, isPartySession: true, to: defaults)

        SharedWidgetTakeControlRuntime.markControlClaimed(isPartySession: true, to: defaults)
        let wallControl = SharedWidgetWallControlState.load(from: defaults)

        XCTAssertTrue(wallControl.navigationAllowed)
        XCTAssertTrue(wallControl.requiresServerAuthorization)
        XCTAssertEqual(SharedWidgetTakeControlRuntime.action(for: wallControl), .alreadyAllowed)
    }

    func testNavigationDirectionBounds() {
        XCTAssertEqual(ClimbNavigationDirection.next.newIndex(from: 0, count: 2), 1)
        XCTAssertNil(ClimbNavigationDirection.next.newIndex(from: 1, count: 2))
        XCTAssertEqual(ClimbNavigationDirection.previous.newIndex(from: 1, count: 2), 0)
        XCTAssertNil(ClimbNavigationDirection.previous.newIndex(from: 0, count: 2))
        XCTAssertNil(ClimbNavigationDirection.previous.newIndex(from: 3, count: 2))
    }

    // MARK: Rest timer (#6513)

    private let restNow = Date(timeIntervalSince1970: 1_800_000_000)

    private func restState(
        status: String,
        sessionId: String = "session",
        startOffset: Double? = nil,
        deadlineOffset: Double? = nil,
        periodSeconds: Double? = nil,
        targetSeconds: Double? = 120,
        frozenSignedSeconds: Double? = nil
    ) -> SharedRestTimerState {
        let nowMs = restNow.timeIntervalSince1970 * 1000
        return SharedRestTimerState(
            v: SharedRestTimerState.currentVersion,
            sessionId: sessionId,
            status: status,
            startMs: startOffset.map { nowMs + $0 * 1000 },
            deadlineMs: deadlineOffset.map { nowMs + $0 * 1000 },
            periodSeconds: periodSeconds,
            targetSeconds: targetSeconds,
            frozenSignedSeconds: frozenSignedSeconds
        )
    }

    private func resolveRest(_ state: SharedRestTimerState?, sessionId: String = "session") -> ResolvedRestTimer? {
        ResolvedRestTimer.resolve(state: state, sessionId: sessionId, now: restNow)
    }

    func testRestTimerStateRoundTripsThroughTheAppGroup() {
        let state = restState(status: SharedRestTimerState.statusRunning, startOffset: -30, deadlineOffset: 90)
        SharedRestTimerStore.save(state, to: defaults)
        XCTAssertEqual(SharedRestTimerStore.load(from: defaults), state)

        XCTAssertTrue(SharedRestTimerStore.clear(in: defaults))
        XCTAssertNil(SharedRestTimerStore.load(from: defaults))
        // A second clear has nothing to take off the card, so it asks for no redraw.
        XCTAssertFalse(SharedRestTimerStore.clear(in: defaults))
    }

    func testRestTimerSaveThatCannotEncodeClearsTheOldSnapshot() {
        let old = restState(status: SharedRestTimerState.statusRunning, startOffset: -30, deadlineOffset: 90)
        XCTAssertTrue(SharedRestTimerStore.save(old, to: defaults))

        // JSONEncoder rejects a non-finite number; the old rest must not keep counting.
        let unencodable = SharedRestTimerState(
            v: SharedRestTimerState.currentVersion,
            sessionId: "session",
            status: SharedRestTimerState.statusRunning,
            startMs: .nan,
            deadlineMs: 1,
            periodSeconds: nil,
            targetSeconds: 120,
            frozenSignedSeconds: nil
        )
        XCTAssertFalse(SharedRestTimerStore.save(unencodable, to: defaults))
        XCTAssertNil(SharedRestTimerStore.load(from: defaults))
    }

    func testRestTimerStoreRejectsGarbageAndUnknownVersions() throws {
        defaults.set(Data("not json".utf8), forKey: SharedConstants.restTimerKey)
        XCTAssertNil(SharedRestTimerStore.load(from: defaults))

        let future = """
        {"v": 2, "sessionId": "session", "status": "running", "deadlineMs": 1}
        """
        defaults.set(Data(future.utf8), forKey: SharedConstants.restTimerKey)
        XCTAssertNil(SharedRestTimerStore.load(from: defaults))
    }

    func testRestTimerStoreDecodesTheJsonJsWritesWithNulls() throws {
        let json = """
        {"v": 1, "sessionId": "session", "status": "waiting", "startMs": null, "deadlineMs": null,
         "periodSeconds": null, "targetSeconds": 90, "frozenSignedSeconds": 90}
        """
        defaults.set(Data(json.utf8), forKey: SharedConstants.restTimerKey)
        let state = try XCTUnwrap(SharedRestTimerStore.load(from: defaults))
        XCTAssertEqual(resolveRest(state)?.phase, .waiting(signedSeconds: 90))
    }

    func testRestTimerStoreAndResolverRejectNumbersTheWidgetCannotDraw() {
        // JSONEncoder writes 1e300 without complaint, and Int(1e300) would trap
        // the widget extension. Out-of-bounds snapshots render as "no timer".
        let outOfBounds: [SharedRestTimerState] = [
            restState(status: SharedRestTimerState.statusWaiting, targetSeconds: 1e300, frozenSignedSeconds: 1e300),
            restState(status: SharedRestTimerState.statusPaused, frozenSignedSeconds: -1e300),
            restState(status: SharedRestTimerState.statusRunning, startOffset: -30, deadlineOffset: 90, periodSeconds: 1e300),
            restState(status: SharedRestTimerState.statusRunning, startOffset: 1e300, deadlineOffset: 90),
            restState(status: SharedRestTimerState.statusCountUp, startOffset: -1e300, targetSeconds: nil),
        ]
        for state in outOfBounds {
            XCTAssertFalse(state.isWithinBounds)
            // Never written: save clears the key and reports the refusal.
            XCTAssertFalse(SharedRestTimerStore.save(state, to: defaults))
            XCTAssertNil(defaults.data(forKey: SharedConstants.restTimerKey))
            XCTAssertNil(SharedRestTimerStore.load(from: defaults))
            XCTAssertNil(resolveRest(state))
        }
        // A value on the bound still draws.
        let edge = restState(status: SharedRestTimerState.statusPaused, frozenSignedSeconds: -86_400)
        XCTAssertEqual(resolveRest(edge)?.phase, .paused(signedSeconds: -86_400))
    }

    func testRestWholeSecondsNeverTraps() {
        XCTAssertEqual(ResolvedRestTimer.wholeSeconds(1e300), 86_400)
        XCTAssertEqual(ResolvedRestTimer.wholeSeconds(-1e300), -86_400)
        XCTAssertEqual(ResolvedRestTimer.wholeSeconds(.nan), 0)
        XCTAssertEqual(ResolvedRestTimer.wholeSeconds(.infinity), 0)
        XCTAssertEqual(ResolvedRestTimer.wholeSeconds(-12.9), -12)
    }

    func testRunningRestCountsDownToItsDeadline() {
        let resolved = resolveRest(restState(status: SharedRestTimerState.statusRunning, startOffset: -30, deadlineOffset: 90))
        XCTAssertEqual(
            resolved?.phase,
            .running(start: restNow.addingTimeInterval(-30), deadline: restNow.addingTimeInterval(90))
        )
        XCTAssertNil(resolved?.periodSeconds)
        XCTAssertEqual(resolved?.targetSeconds, 120)
        XCTAssertEqual(resolved?.muted, false)
    }

    func testRunningRestRenderedAfterItsDeadlineIsOver() {
        let resolved = resolveRest(restState(status: SharedRestTimerState.statusRunning, startOffset: -150, deadlineOffset: -30))
        XCTAssertEqual(resolved?.phase, .over(deadline: restNow.addingTimeInterval(-30)))
    }

    func testFixedWindowRollsOnToTheCurrentWindowInsteadOfGoingOver() {
        // The 60 s window ended 130 s ago: two more windows have started since.
        let resolved = resolveRest(restState(
            status: SharedRestTimerState.statusRunning,
            startOffset: -190,
            deadlineOffset: -130,
            periodSeconds: 60,
            targetSeconds: 60
        ))
        XCTAssertEqual(
            resolved?.phase,
            .running(start: restNow.addingTimeInterval(-10), deadline: restNow.addingTimeInterval(50))
        )
        XCTAssertEqual(resolved?.periodSeconds, 60)
    }

    func testRunningRangeIsNeverInverted() {
        // `Text(timerInterval:)` traps on lower > upper.
        let resolved = resolveRest(restState(status: SharedRestTimerState.statusRunning, startOffset: 200, deadlineOffset: 90))
        guard case let .running(start, deadline)? = resolved?.phase else {
            return XCTFail("expected a running rest, got \(String(describing: resolved?.phase))")
        }
        XCTAssertLessThanOrEqual(start, deadline)
    }

    func testRunningRestWithoutAStartFallsBackToOneRestLength() {
        let resolved = resolveRest(restState(status: SharedRestTimerState.statusRunning, deadlineOffset: 90))
        XCTAssertEqual(
            resolved?.phase,
            .running(start: restNow.addingTimeInterval(-30), deadline: restNow.addingTimeInterval(90))
        )
    }

    func testFrozenRestPhasesKeepTheirSign() {
        XCTAssertEqual(
            resolveRest(restState(status: SharedRestTimerState.statusPaused, frozenSignedSeconds: -12))?.phase,
            .paused(signedSeconds: -12)
        )
        XCTAssertEqual(
            resolveRest(restState(status: SharedRestTimerState.statusWaiting, frozenSignedSeconds: nil))?.phase,
            .waiting(signedSeconds: 120)
        )
    }

    func testQueueEndedKeepsCountingTheRestItReplacedMuted() {
        // Before the deadline: the same countdown the rest was running.
        let before = resolveRest(restState(status: SharedRestTimerState.statusQueueEnded, startOffset: -30, deadlineOffset: 90))
        XCTAssertEqual(
            before?.phase,
            .running(start: restNow.addingTimeInterval(-30), deadline: restNow.addingTimeInterval(90))
        )
        XCTAssertEqual(before?.muted, true)

        // Past it: the overrun keeps counting, still muted (never the over red).
        let after = resolveRest(restState(status: SharedRestTimerState.statusQueueEnded, startOffset: -150, deadlineOffset: -30))
        XCTAssertEqual(after?.phase, .over(deadline: restNow.addingTimeInterval(-30)))
        XCTAssertEqual(after?.muted, true)
    }

    func testQueueEndedFixedWindowKeepsRolling() {
        let resolved = resolveRest(restState(
            status: SharedRestTimerState.statusQueueEnded,
            startOffset: -190,
            deadlineOffset: -130,
            periodSeconds: 60,
            targetSeconds: 60
        ))
        XCTAssertEqual(
            resolved?.phase,
            .running(start: restNow.addingTimeInterval(-10), deadline: restNow.addingTimeInterval(50))
        )
        XCTAssertEqual(resolved?.muted, true)
    }

    func testQueueEndedWithoutARestLengthCountsUp() {
        let resolved = resolveRest(restState(status: SharedRestTimerState.statusQueueEnded, startOffset: -42, targetSeconds: nil))
        XCTAssertEqual(resolved?.phase, .countUp(start: restNow.addingTimeInterval(-42)))
        XCTAssertEqual(resolved?.muted, true)
    }

    func testQueueEndedWithNoTimingFallsBackToItsFrozenValue() {
        let resolved = resolveRest(restState(status: SharedRestTimerState.statusQueueEnded, frozenSignedSeconds: 40))
        XCTAssertEqual(resolved?.phase, .queueEnded(signedSeconds: 40))
        XCTAssertEqual(resolved?.muted, true)
    }

    func testCountUpRestNeverStartsInTheFuture() {
        XCTAssertEqual(
            resolveRest(restState(status: SharedRestTimerState.statusCountUp, startOffset: -42, targetSeconds: nil))?.phase,
            .countUp(start: restNow.addingTimeInterval(-42))
        )
        XCTAssertEqual(
            resolveRest(restState(status: SharedRestTimerState.statusCountUp, startOffset: 5, targetSeconds: nil))?.phase,
            .countUp(start: restNow)
        )
    }

    func testRestTimerHiddenForAnotherSessionAnUnknownStatusOrNothingToCount() {
        XCTAssertNil(resolveRest(nil))
        XCTAssertNil(resolveRest(restState(status: SharedRestTimerState.statusRunning, deadlineOffset: 90), sessionId: "other"))
        XCTAssertNil(resolveRest(restState(status: "sprinting", deadlineOffset: 90)))
        XCTAssertNil(resolveRest(restState(status: SharedRestTimerState.statusRunning)))
        XCTAssertNil(resolveRest(restState(status: SharedRestTimerState.statusCountUp, targetSeconds: nil)))
    }

    func testRestClockFormatsLikeTheApp() {
        XCTAssertEqual(RestTimerFormat.signedClock(90), "1:30")
        XCTAssertEqual(RestTimerFormat.signedClock(0), "0:00")
        XCTAssertEqual(RestTimerFormat.signedClock(-12), "\u{2212}0:12")
        XCTAssertEqual(RestTimerFormat.clock(3_725), "1:02:05")
    }

    func testDisplayGradeAgreesWhicheverPathDeliveredIt() {
        // The backend push carries the raw difficulty; the native paths format it.
        XCTAssertEqual(VGradeFormatter.displayGrade("6a/V3"), "V3")
        XCTAssertEqual(VGradeFormatter.displayGrade("6c+/V5"), "V5+")
        XCTAssertEqual(VGradeFormatter.displayGrade("V5+"), "V5+")
        XCTAssertEqual(VGradeFormatter.displayGrade("v4"), "V4")
        XCTAssertEqual(VGradeFormatter.displayGrade("7A"), "7A")
        XCTAssertEqual(VGradeFormatter.displayGrade(""), "")
        for raw in ["6a/V3", "6c+/V5", "V5+", "7A", "8A+/V11"] {
            let once = VGradeFormatter.displayGrade(raw)
            XCTAssertEqual(VGradeFormatter.displayGrade(once), once, "displayGrade must be idempotent for \(raw)")
        }
    }

    // MARK: Keep-lighting window (2.7)

    private let lightNow = Date(timeIntervalSince1970: 1_800_000_000)

    private var lightNowMs: Double { lightNow.timeIntervalSince1970 * 1000 }

    private func lightingState(
        mode: String,
        sessionId: String = "session",
        endsInSeconds: Double? = nil,
        windowSeconds: Double? = nil,
        family: String? = SharedLightingWindowState.familyGeneral,
        source: String = SharedLightingWindowState.sourceApp
    ) -> SharedLightingWindowState {
        SharedLightingWindowState(
            v: SharedLightingWindowState.currentVersion,
            sessionId: sessionId,
            mode: mode,
            endsAtMs: endsInSeconds.map { lightNowMs + $0 * 1000 },
            windowSeconds: windowSeconds,
            family: family,
            source: source,
            updatedAtMs: lightNowMs - 5_000
        )
    }

    private func keepLightingConfig(
        keepLighting: String = "45",
        drivesInSession: Bool = true,
        inCrew: Bool = false,
        enabled: Bool = true
    ) -> SharedKeepLightingConfig {
        SharedKeepLightingConfig(
            v: SharedKeepLightingConfig.currentVersion,
            keepLighting: keepLighting,
            drivesInSession: drivesInSession,
            inCrew: inCrew,
            enabled: enabled
        )
    }

    private func press(
        current: SharedLightingWindowState?,
        config: SharedKeepLightingConfig?,
        sessionId: String = "session"
    ) -> SharedLightingWindowState? {
        SharedLightingWindowRuntime.afterPress(current: current, config: config, sessionId: sessionId, now: lightNow)
    }

    func testLightingWindowRoundTripsThroughTheAppGroup() {
        let state = lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: 30, windowSeconds: 45)
        XCTAssertTrue(SharedLightingWindowStore.save(state, to: defaults))
        XCTAssertEqual(SharedLightingWindowStore.load(from: defaults), state)

        XCTAssertTrue(SharedLightingWindowStore.clear(in: defaults))
        XCTAssertNil(SharedLightingWindowStore.load(from: defaults))
        XCTAssertFalse(SharedLightingWindowStore.clear(in: defaults))
    }

    func testLightingWindowStoreRejectsGarbageUnknownVersionsAndNumbersItCannotDraw() {
        defaults.set(Data("not json".utf8), forKey: SharedConstants.lightingWindowKey)
        XCTAssertNil(SharedLightingWindowStore.load(from: defaults))

        let future = """
        {"v": 2, "sessionId": "session", "mode": "window", "endsAtMs": 1800000030000, "source": "app", "updatedAtMs": 1800000000000}
        """
        defaults.set(Data(future.utf8), forKey: SharedConstants.lightingWindowKey)
        XCTAssertNil(SharedLightingWindowStore.load(from: defaults))

        let outOfBounds = [
            lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: 1e300, windowSeconds: 45),
            lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: 30, windowSeconds: 1e300),
            lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: 30, windowSeconds: 0),
            lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: 30, windowSeconds: -45),
        ]
        for state in outOfBounds {
            XCTAssertFalse(state.isWithinBounds)
            XCTAssertFalse(SharedLightingWindowStore.save(state, to: defaults))
            XCTAssertNil(defaults.data(forKey: SharedConstants.lightingWindowKey))
            XCTAssertEqual(LightingRenderPhase.resolve(state: state, sessionId: "session", now: lightNow), .previews)
        }
    }

    func testLightingWindowStoreDecodesASnapshotWithNullsAndMissingFields() throws {
        let json = """
        {"v": 1, "sessionId": "session", "mode": "driving", "endsAtMs": null, "source": "lockScreen", "updatedAtMs": 1800000000000}
        """
        defaults.set(Data(json.utf8), forKey: SharedConstants.lightingWindowKey)
        let state = try XCTUnwrap(SharedLightingWindowStore.load(from: defaults))
        XCTAssertNil(state.windowSeconds)
        XCTAssertNil(state.family)
        XCTAssertEqual(LightingRenderPhase.resolve(state: state, sessionId: "session", now: lightNow), .driving)
    }

    func testLightingWindowDrainsToItsEndThenReadsAsPreviews() {
        let open = lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: 30, windowSeconds: 45)
        XCTAssertEqual(
            LightingRenderPhase.resolve(state: open, sessionId: "session", now: lightNow),
            .window(start: lightNow.addingTimeInterval(-15), end: lightNow.addingTimeInterval(30))
        )
        // The widget runs no code at the end: the first render past it shows previews.
        XCTAssertEqual(
            LightingRenderPhase.resolve(state: open, sessionId: "session", now: lightNow.addingTimeInterval(30)),
            .previews
        )
    }

    func testLightingWindowRangeIsNeverInverted() {
        // A window with no length on record still draws a valid range.
        let noLength = lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: 30, windowSeconds: nil)
        guard case let .window(start, end) = LightingRenderPhase.resolve(state: noLength, sessionId: "session", now: lightNow) else {
            return XCTFail("expected a window")
        }
        XCTAssertLessThanOrEqual(start, end)
        XCTAssertEqual(start, lightNow)
    }

    func testLightingShowsPreviewsForAnotherSessionOffOrAnUnknownMode() {
        let driving = lightingState(mode: SharedLightingWindowState.modeDriving)
        XCTAssertEqual(LightingRenderPhase.resolve(state: driving, sessionId: "session", now: lightNow), .driving)
        XCTAssertEqual(LightingRenderPhase.resolve(state: driving, sessionId: "other", now: lightNow), .previews)
        XCTAssertEqual(LightingRenderPhase.resolve(state: nil, sessionId: "session", now: lightNow), .previews)
        XCTAssertEqual(
            LightingRenderPhase.resolve(state: lightingState(mode: SharedLightingWindowState.modeOff), sessionId: "session", now: lightNow),
            .previews
        )
        XCTAssertEqual(
            LightingRenderPhase.resolve(state: lightingState(mode: "sprinting", endsInSeconds: 30), sessionId: "session", now: lightNow),
            .previews
        )
    }

    func testKeepLightingPlanFollowsTheSettingsLikeTheApp() {
        // The choice: a 45 s timed drive.
        XCTAssertEqual(
            SharedKeepLighting.plan(for: keepLightingConfig()),
            .window(seconds: 45, family: SharedLightingWindowState.familyGeneral)
        )
        // In a crew with "In a session too" off, the general choice lights one climb.
        XCTAssertNil(SharedKeepLighting.plan(for: keepLightingConfig(drivesInSession: false, inCrew: true)))
        XCTAssertEqual(
            SharedKeepLighting.plan(for: keepLightingConfig(drivesInSession: true, inCrew: true)),
            .window(seconds: 45, family: SharedLightingWindowState.familyGeneral)
        )
        // Right away lights one climb and starts no drive.
        XCTAssertNil(SharedKeepLighting.plan(for: keepLightingConfig(keepLighting: "off")))
        XCTAssertEqual(
            SharedKeepLighting.plan(for: keepLightingConfig(keepLighting: "until_stopped")),
            .driving(family: SharedLightingWindowState.familyGeneral)
        )
        // Stop driving after's longer choices (2.7): 2 and 5 minutes.
        XCTAssertEqual(
            SharedKeepLighting.plan(for: keepLightingConfig(keepLighting: "120")),
            .window(seconds: 120, family: SharedLightingWindowState.familyGeneral)
        )
        XCTAssertEqual(
            SharedKeepLighting.plan(for: keepLightingConfig(keepLighting: "300")),
            .window(seconds: 300, family: SharedLightingWindowState.familyGeneral)
        )
        // Off where the app would not keep lighting, and with no config at all.
        XCTAssertNil(SharedKeepLighting.plan(for: keepLightingConfig(enabled: false)))
        XCTAssertNil(SharedKeepLighting.plan(for: nil))
        // A value this build can't read lights one climb; a newer bundle's longer timed drive still works.
        XCTAssertNil(SharedKeepLighting.plan(for: keepLightingConfig(keepLighting: "forever")))
        XCTAssertNil(SharedKeepLighting.plan(for: keepLightingConfig(keepLighting: "nan")))
        XCTAssertNil(SharedKeepLighting.plan(for: keepLightingConfig(keepLighting: "0")))
        XCTAssertNil(SharedKeepLighting.plan(for: keepLightingConfig(keepLighting: "86400")))
        XCTAssertEqual(
            SharedKeepLighting.plan(for: keepLightingConfig(keepLighting: "90")),
            .window(seconds: 90, family: SharedLightingWindowState.familyGeneral)
        )
    }

    func testKeepLightingConfigRoundTripsAndRejectsAnUnknownVersion() {
        let config = keepLightingConfig(inCrew: true)
        SharedKeepLightingConfigStore.save(config, to: defaults)
        XCTAssertEqual(SharedKeepLightingConfigStore.load(from: defaults), config)

        let future = """
        {"v": 2, "keepLighting": "45", "moonboardKeepLighting": "until_stopped", "drivesInSession": true, "inCrew": false, "moonboard": false, "enabled": true}
        """
        defaults.set(Data(future.utf8), forKey: SharedConstants.keepLightingConfigKey)
        XCTAssertNil(SharedKeepLightingConfigStore.load(from: defaults))

        SharedKeepLightingConfigStore.clear(in: defaults)
        XCTAssertNil(defaults.data(forKey: SharedConstants.keepLightingConfigKey))
    }

    func testLockScreenPressOpensAWindowFromTheSettings() throws {
        let opened = try XCTUnwrap(press(current: nil, config: keepLightingConfig()))
        XCTAssertEqual(opened.mode, SharedLightingWindowState.modeWindow)
        XCTAssertEqual(opened.endsAtMs, lightNowMs + 45_000)
        XCTAssertEqual(opened.windowSeconds, 45)
        XCTAssertEqual(opened.family, SharedLightingWindowState.familyGeneral)
        XCTAssertEqual(opened.source, SharedLightingWindowState.sourceLockScreen)
        XCTAssertEqual(opened.updatedAtMs, lightNowMs)
        XCTAssertEqual(opened.sessionId, "session")
    }

    func testLockScreenPressRenewsAnOpenWindowByItsOwnLength() throws {
        // A 30 s window opened in the app, 10 s left; the settings say 60 s now.
        let open = lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: 10, windowSeconds: 30)
        let renewed = try XCTUnwrap(press(current: open, config: keepLightingConfig(keepLighting: "60")))
        XCTAssertEqual(renewed.mode, SharedLightingWindowState.modeWindow)
        XCTAssertEqual(renewed.endsAtMs, lightNowMs + 30_000)
        XCTAssertEqual(renewed.windowSeconds, 30)
        XCTAssertEqual(renewed.source, SharedLightingWindowState.sourceLockScreen)
        // It renews even when the settings would no longer open one: the window is the climber's.
        XCTAssertNotNil(press(current: open, config: nil))
    }

    func testLockScreenPressKeepsADriveAsItIs() {
        let driving = lightingState(mode: SharedLightingWindowState.modeDriving)
        XCTAssertNil(press(current: driving, config: keepLightingConfig()))
    }

    func testLockScreenPressAfterTheWindowEndedOpensAFreshOne() throws {
        let over = lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: -1, windowSeconds: 30)
        let fresh = try XCTUnwrap(press(current: over, config: keepLightingConfig()))
        XCTAssertEqual(fresh.endsAtMs, lightNowMs + 45_000)
        XCTAssertEqual(fresh.windowSeconds, 45)
    }

    func testLockScreenPressUnderRightAwayOrNoSettingsLightsOneClimbAndStartsNoDrive() {
        XCTAssertNil(press(current: nil, config: keepLightingConfig(keepLighting: "off")))
        XCTAssertNil(press(current: nil, config: nil))
        XCTAssertNil(press(current: lightingState(mode: SharedLightingWindowState.modeOff), config: keepLightingConfig(enabled: false)))
        // A timed drive that already ran out is not one to renew: Right away starts nothing new.
        let over = lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: -1, windowSeconds: 45)
        XCTAssertNil(press(current: over, config: keepLightingConfig(keepLighting: "off")))
    }

    func testLockScreenPressIgnoresAnotherSessionsWindow() throws {
        let otherDrive = lightingState(mode: SharedLightingWindowState.modeDriving, sessionId: "old-session")
        let opened = try XCTUnwrap(press(current: otherDrive, config: keepLightingConfig()))
        XCTAssertEqual(opened.sessionId, "session")
        XCTAssertEqual(opened.mode, SharedLightingWindowState.modeWindow)
    }

    func testLockScreenPressUntilStoppedStartsADrive() throws {
        let drive = try XCTUnwrap(press(current: nil, config: keepLightingConfig(keepLighting: "until_stopped")))
        XCTAssertEqual(drive.mode, SharedLightingWindowState.modeDriving)
        XCTAssertNil(drive.endsAtMs)
        XCTAssertEqual(drive.family, SharedLightingWindowState.familyGeneral)
    }

    // A JS from before #7218 still says MoonBoard and sends the MoonBoard
    // choice in its own slot. This build reads neither (2.7: one choice for
    // every board), so the press takes the general choice and the general
    // rule: one lit climb in a crew with In a session too off.
    func testAMoonBoardFlagFromAnOlderBundleFollowsTheGeneralRule() throws {
        let legacy = """
        {"v": 1, "keepLighting": "45", "moonboardKeepLighting": "until_stopped", "drivesInSession": false, "inCrew": true, "moonboard": true, "enabled": true}
        """
        defaults.set(Data(legacy.utf8), forKey: SharedConstants.keepLightingConfigKey)
        let config = try XCTUnwrap(SharedKeepLightingConfigStore.load(from: defaults))
        XCTAssertEqual(config, keepLightingConfig(drivesInSession: false, inCrew: true))
        XCTAssertNil(SharedKeepLighting.plan(for: config))
        XCTAssertNil(press(current: nil, config: config))

        let solo = """
        {"v": 1, "keepLighting": "45", "moonboardKeepLighting": "until_stopped", "drivesInSession": false, "inCrew": false, "moonboard": true, "enabled": true}
        """
        defaults.set(Data(solo.utf8), forKey: SharedConstants.keepLightingConfigKey)
        XCTAssertEqual(
            SharedKeepLighting.plan(for: SharedKeepLightingConfigStore.load(from: defaults)),
            .window(seconds: 45, family: SharedLightingWindowState.familyGeneral)
        )
    }

    func testRecordPressStoresTheWindowForTheStagedSessionOnly() throws {
        SharedKeepLightingConfigStore.save(keepLightingConfig(), to: defaults)
        // No session staged: no card to press, nothing stored.
        XCTAssertNil(SharedLightingWindowRuntime.recordPress(in: defaults, now: lightNow))
        XCTAssertNil(SharedLightingWindowStore.load(from: defaults))

        defaults.set("session", forKey: SharedConstants.sessionIdKey)
        let stored = try XCTUnwrap(SharedLightingWindowRuntime.recordPress(in: defaults, now: lightNow))
        XCTAssertEqual(SharedLightingWindowStore.load(from: defaults), stored)

        // A drive stored, a second press changes nothing and reports so.
        SharedLightingWindowStore.save(lightingState(mode: SharedLightingWindowState.modeDriving), to: defaults)
        XCTAssertNil(SharedLightingWindowRuntime.recordPress(in: defaults, now: lightNow))
        XCTAssertEqual(SharedLightingWindowStore.load(from: defaults)?.mode, SharedLightingWindowState.modeDriving)
    }

    func testLightingSnapshotsThatDrawAlikeIgnoreWhoWroteThem() {
        let lockScreen = lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: 30, windowSeconds: 45, source: SharedLightingWindowState.sourceLockScreen)
        let app = lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: 30, windowSeconds: 45, source: SharedLightingWindowState.sourceApp)
        XCTAssertTrue(app.drawsLike(lockScreen))
        XCTAssertFalse(app.drawsLike(nil))
        XCTAssertFalse(app.drawsLike(lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: 40, windowSeconds: 45)))
    }

    func testLightingStartDropsAnotherSessionsWindowAndKeepsThisOne() {
        let ours = lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: 30, windowSeconds: 45)
        SharedLightingWindowStore.save(ours, to: defaults)
        SharedLightingWindowStore.clear(unlessSession: "session", in: defaults)
        XCTAssertEqual(SharedLightingWindowStore.load(from: defaults), ours)

        SharedLightingWindowStore.clear(unlessSession: "next-session", in: defaults)
        XCTAssertNil(defaults.data(forKey: SharedConstants.lightingWindowKey))
    }

    func testLightingEndSessionClearsTheWindowTheSettingsAndThePressStamp() {
        SharedLightingWindowStore.save(lightingState(mode: SharedLightingWindowState.modeDriving), to: defaults)
        SharedKeepLightingConfigStore.save(keepLightingConfig(), to: defaults)
        SharedLockScreenPress.begin(in: defaults, asksServer: false, now: lightNow, pressId: "press-1")
        SharedLockScreenPress.settle("press-1", in: defaults, now: lightNow)
        XCTAssertNotNil(SharedLightingWindowStore.load(from: defaults))
        XCTAssertNotNil(SharedKeepLightingConfigStore.load(from: defaults))
        XCTAssertNotNil(SharedLockScreenPress.load(from: defaults))

        SharedLightingWindowRuntime.endSession(in: defaults)

        XCTAssertNil(defaults.data(forKey: SharedConstants.lightingWindowKey))
        XCTAssertNil(defaults.data(forKey: SharedConstants.keepLightingConfigKey))
        // A settled stamp outlives nothing: the session it belonged to is gone.
        XCTAssertNil(defaults.data(forKey: SharedConstants.lockScreenPressKey))
    }

    func testLightingWriteRedrawsOnlyWhenTheCardChanges() {
        let window = lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: 30, windowSeconds: 45)
        // Clearing nothing draws nothing new.
        XCTAssertFalse(SharedLightingWindowStore.write(nil, to: defaults))
        XCTAssertTrue(SharedLightingWindowStore.write(window, to: defaults))
        XCTAssertEqual(SharedLightingWindowStore.load(from: defaults), window)

        // JS taking over the lock-screen window it adopted: same card, no redraw,
        // but its own write replaces the lock-screen one so it isn't adopted twice.
        let lockScreen = lightingState(
            mode: SharedLightingWindowState.modeWindow,
            endsInSeconds: 30,
            windowSeconds: 45,
            source: SharedLightingWindowState.sourceLockScreen
        )
        SharedLightingWindowStore.save(lockScreen, to: defaults)
        XCTAssertFalse(SharedLightingWindowStore.write(window, to: defaults))
        XCTAssertEqual(SharedLightingWindowStore.load(from: defaults)?.source, SharedLightingWindowState.sourceApp)

        // A renewal, a drive, and off all redraw.
        let renewed = lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: 45, windowSeconds: 45)
        XCTAssertTrue(SharedLightingWindowStore.write(renewed, to: defaults))
        XCTAssertTrue(SharedLightingWindowStore.write(lightingState(mode: SharedLightingWindowState.modeDriving), to: defaults))
        XCTAssertTrue(SharedLightingWindowStore.write(nil, to: defaults))
        XCTAssertNil(defaults.data(forKey: SharedConstants.lightingWindowKey))

        // A window it cannot draw is never stored, and only redraws when it takes one off the card.
        let unreadable = lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: 30, windowSeconds: 0)
        XCTAssertFalse(SharedLightingWindowStore.write(unreadable, to: defaults))
        SharedLightingWindowStore.save(window, to: defaults)
        XCTAssertTrue(SharedLightingWindowStore.write(unreadable, to: defaults))
        XCTAssertNil(defaults.data(forKey: SharedConstants.lightingWindowKey))
    }

    func testLightingNeedsRedrawComparesWhatTheCardDraws() {
        let window = lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: 30, windowSeconds: 45)
        XCTAssertFalse(SharedLightingWindowStore.needsRedraw(previous: nil, next: nil))
        XCTAssertTrue(SharedLightingWindowStore.needsRedraw(previous: window, next: nil))
        XCTAssertTrue(SharedLightingWindowStore.needsRedraw(previous: nil, next: window))
        XCTAssertFalse(SharedLightingWindowStore.needsRedraw(previous: window, next: window))
        XCTAssertTrue(
            SharedLightingWindowStore.needsRedraw(
                previous: window,
                next: lightingState(mode: SharedLightingWindowState.modeWindow, sessionId: "other", endsInSeconds: 30, windowSeconds: 45)
            )
        )
    }

    func testContentStateDecodesAPushWithoutTheRestRevision() throws {
        // What the backend sends today: no restRevision or lightingRevision (and no device-only fields).
        let json = """
        {
          "climbName": "Masquerade",
          "climbDifficulty": "6a/V3",
          "angle": 40,
          "currentIndex": 0,
          "totalClimbs": 2,
          "hasNext": true,
          "hasPrevious": false,
          "climbUuid": "climb-1"
        }
        """
        let state = try JSONDecoder().decode(ClimbSessionAttributes.ContentState.self, from: Data(json.utf8))
        XCTAssertNil(state.restRevision)
        XCTAssertNil(state.lightingRevision)
        XCTAssertEqual(state.climbName, "Masquerade")
    }

    // MARK: Stop driving from the Lock Screen bulb

    private func stopAt(_ current: SharedLightingWindowState?, sessionId: String = "session") -> SharedLightingWindowState? {
        SharedLightingWindowRuntime.afterStop(current: current, sessionId: sessionId, now: lightNow)
    }

    func testLockScreenStopTurnsATimedOrOpenEndedDriveOff() throws {
        for drive in [
            lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: 30, windowSeconds: 45),
            lightingState(mode: SharedLightingWindowState.modeDriving, family: nil, source: SharedLightingWindowState.sourceLockScreen),
        ] {
            let stopped = try XCTUnwrap(stopAt(drive))
            XCTAssertEqual(stopped.mode, SharedLightingWindowState.modeOff)
            XCTAssertNil(stopped.endsAtMs)
            XCTAssertNil(stopped.windowSeconds)
            XCTAssertEqual(stopped.source, SharedLightingWindowState.sourceLockScreen)
            XCTAssertEqual(stopped.updatedAtMs, lightNowMs)
            XCTAssertEqual(stopped.sessionId, "session")
            XCTAssertEqual(LightingRenderPhase.resolve(state: stopped, sessionId: "session", now: lightNow), .previews)
        }
    }

    func testLockScreenStopFindsNothingToStopOnPreviewsAnEndedDriveOrAnotherSession() {
        XCTAssertNil(stopAt(nil))
        XCTAssertNil(stopAt(lightingState(mode: SharedLightingWindowState.modeOff)))
        // A timed drive that ran out between the render and the tap.
        XCTAssertNil(stopAt(lightingState(mode: SharedLightingWindowState.modeWindow, endsInSeconds: -1, windowSeconds: 45)))
        XCTAssertNil(stopAt(lightingState(mode: SharedLightingWindowState.modeDriving), sessionId: "next-session"))
    }

    func testRecordStopStoresTheStopForTheStagedSessionOnly() throws {
        SharedLightingWindowStore.save(lightingState(mode: SharedLightingWindowState.modeDriving), to: defaults)
        // No session staged: no card, nothing stored.
        XCTAssertNil(SharedLightingWindowRuntime.recordStop(in: defaults, now: lightNow))
        XCTAssertEqual(SharedLightingWindowStore.load(from: defaults)?.mode, SharedLightingWindowState.modeDriving)

        defaults.set("session", forKey: SharedConstants.sessionIdKey)
        let stored = try XCTUnwrap(SharedLightingWindowRuntime.recordStop(in: defaults, now: lightNow))
        XCTAssertEqual(SharedLightingWindowStore.load(from: defaults), stored)
        // A second tap finds nothing driving.
        XCTAssertNil(SharedLightingWindowRuntime.recordStop(in: defaults, now: lightNow))
        // A press after the stop starts a drive from the settings again, as Put on board would.
        SharedKeepLightingConfigStore.save(keepLightingConfig(), to: defaults)
        XCTAssertEqual(SharedLightingWindowRuntime.recordPress(in: defaults, now: lightNow)?.mode, SharedLightingWindowState.modeWindow)
    }

    func testTheBulbOffersAStopOnlyToAnAppThatTakesOne() throws {
        XCTAssertFalse(SharedLightingWindowRuntime.lockScreenStopSupported(in: defaults))
        // A JS that predates the stop mirrors its settings without the field.
        let legacy = """
        {"v": 1, "keepLighting": "45", "moonboardKeepLighting": "until_stopped", "drivesInSession": true, "inCrew": false, "moonboard": false, "enabled": true}
        """
        defaults.set(Data(legacy.utf8), forKey: SharedConstants.keepLightingConfigKey)
        XCTAssertNotNil(SharedKeepLightingConfigStore.load(from: defaults))
        XCTAssertFalse(SharedLightingWindowRuntime.lockScreenStopSupported(in: defaults))

        var config = keepLightingConfig(enabled: false)
        config.lockScreenStop = true
        SharedKeepLightingConfigStore.save(config, to: defaults)
        // Whatever the press settings say: a swipe's drive is stoppable too.
        XCTAssertTrue(SharedLightingWindowRuntime.lockScreenStopSupported(in: defaults))
        XCTAssertEqual(SharedKeepLightingConfigStore.load(from: defaults), config)
    }

    func testTheStopWaitsForTheAppUntilItWritesItsOwn() {
        let stop = lightingState(mode: SharedLightingWindowState.modeOff, family: nil, source: SharedLightingWindowState.sourceLockScreen)
        XCTAssertFalse(StopDrivingIntent.appSettled(stop, current: stop))
        // JS adopted it and wrote its own off.
        XCTAssertTrue(StopDrivingIntent.appSettled(stop, current: lightingState(mode: SharedLightingWindowState.modeOff, family: nil)))
        // Or a later press already replaced it.
        let later = SharedLightingWindowState(
            v: SharedLightingWindowState.currentVersion,
            sessionId: "session",
            mode: SharedLightingWindowState.modeWindow,
            endsAtMs: lightNowMs + 45_000,
            windowSeconds: 45,
            family: SharedLightingWindowState.familyGeneral,
            source: SharedLightingWindowState.sourceLockScreen,
            updatedAtMs: stop.updatedAtMs + 1
        )
        XCTAssertTrue(StopDrivingIntent.appSettled(stop, current: later))
        XCTAssertTrue(StopDrivingIntent.appSettled(stop, current: nil))
    }

    // MARK: A lock-screen press in flight

    // The intent stamps the press before its server request and board write,
    // so JS's timed-drive end check can wait for it instead of letting go of
    // the board under it.
    func testAPressIsStampedInFlightWithAShortExpiry() throws {
        XCTAssertNil(SharedLockScreenPress.load(from: defaults))

        let pressId = SharedLockScreenPress.begin(in: defaults, asksServer: false, now: lightNow, pressId: "press-1")
        XCTAssertEqual(pressId, "press-1")
        let local = try XCTUnwrap(SharedLockScreenPress.load(from: defaults))
        XCTAssertEqual(local.pressId, "press-1")
        XCTAssertNil(local.settledAtMs)
        // The board's 3 s ready wait and 1.5 s drain, the ActivityKit updates and a margin.
        XCTAssertEqual(local.expiresAtMs, lightNowMs + 8_000)

        // A party session asks the server first: its 10 s request timeout comes on top.
        SharedLockScreenPress.begin(in: defaults, asksServer: true, now: lightNow, pressId: "press-2")
        XCTAssertEqual(SharedLockScreenPress.load(from: defaults)?.expiresAtMs, lightNowMs + 18_000)

        // A fresh id every press when none is given.
        let first = SharedLockScreenPress.begin(in: defaults, asksServer: false)
        let second = SharedLockScreenPress.begin(in: defaults, asksServer: false)
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(SharedLockScreenPress.load(from: defaults)?.pressId, second)
    }

    // Settled after the write, before the Darwin post: JS then knows the press
    // was over by the time it landed, and ends a lapsed drive keeping the board.
    func testAPressSettlesAfterItsWriteKeepingItsExpiry() throws {
        SharedLockScreenPress.begin(in: defaults, asksServer: false, now: lightNow, pressId: "press-1")
        let settledAt = lightNow.addingTimeInterval(2)
        SharedLockScreenPress.settle("press-1", in: defaults, now: settledAt)
        let settled = try XCTUnwrap(SharedLockScreenPress.load(from: defaults))
        XCTAssertEqual(settled.pressId, "press-1")
        XCTAssertEqual(settled.settledAtMs, settledAt.timeIntervalSince1970 * 1000)
        XCTAssertEqual(settled.expiresAtMs, lightNowMs + 8_000)
    }

    // Two quick presses: the first one settling leaves the second in flight.
    func testAPressOnlySettlesItsOwnStamp() throws {
        SharedLockScreenPress.begin(in: defaults, asksServer: true, now: lightNow, pressId: "press-1")
        SharedLockScreenPress.begin(in: defaults, asksServer: true, now: lightNow, pressId: "press-2")

        SharedLockScreenPress.settle("press-1", in: defaults, now: lightNow)
        let inFlight = try XCTUnwrap(SharedLockScreenPress.load(from: defaults))
        XCTAssertEqual(inFlight.pressId, "press-2")
        XCTAssertNil(inFlight.settledAtMs)

        // The party server turned press 2 down. It settles rather than removing
        // the stamp, which covered press 1 and press 1 may still be writing, so
        // JS ends a lapsed drive keeping the board instead of letting go.
        let turnedDownAt = lightNow.addingTimeInterval(1)
        SharedLockScreenPress.settle("press-2", in: defaults, now: turnedDownAt)
        let settled = try XCTUnwrap(SharedLockScreenPress.load(from: defaults))
        XCTAssertEqual(settled.pressId, "press-2")
        XCTAssertEqual(settled.settledAtMs, turnedDownAt.timeIntervalSince1970 * 1000)

        // Nothing stored: settling writes nothing.
        SharedLockScreenPress.clear(in: defaults)
        XCTAssertNil(defaults.data(forKey: SharedConstants.lockScreenPressKey))
        SharedLockScreenPress.settle("press-2", in: defaults, now: lightNow)
        XCTAssertNil(defaults.data(forKey: SharedConstants.lockScreenPressKey))
    }

    func testThePressStampRejectsGarbageAndAnUnknownVersion() throws {
        defaults.set(Data("not json".utf8), forKey: SharedConstants.lockScreenPressKey)
        XCTAssertNil(SharedLockScreenPress.load(from: defaults))

        let future = """
        {"v": 2, "pressId": "press-1", "expiresAtMs": 1800000008000}
        """
        defaults.set(Data(future.utf8), forKey: SharedConstants.lockScreenPressKey)
        XCTAssertNil(SharedLockScreenPress.load(from: defaults))

        let inFlight = """
        {"v": 1, "pressId": "press-1", "expiresAtMs": 1800000008000, "settledAtMs": null}
        """
        defaults.set(Data(inFlight.utf8), forKey: SharedConstants.lockScreenPressKey)
        let state = try XCTUnwrap(SharedLockScreenPress.load(from: defaults))
        XCTAssertNil(state.settledAtMs)
        XCTAssertEqual(state.expiresAtMs, 1_800_000_008_000)
    }

    // MARK: The disconnected card's bulb

    private func storePairing(bound: UUID?, configKey: String = "kilter::1::1::") {
        var pairing: [String: Any] = [
            "configKey": configKey,
            "configuration": ["boardName": "kilter", "layoutId": 1, "sizeId": 1],
        ]
        if let bound { pairing["boundPeripheralUuid"] = bound.uuidString }
        defaults.set(try? JSONSerialization.data(withJSONObject: pairing), forKey: SharedConstants.bleBoardConfigKey)
    }

    func testTheDisconnectedCardOffersReconnectOnlyForARememberedBoard() {
        // Nothing paired yet, or an in-app Disconnect cleared the board.
        XCTAssertEqual(SharedBoardReconnect.footer(in: defaults), .openApp)
        storePairing(bound: nil)
        XCTAssertEqual(SharedBoardReconnect.footer(in: defaults), .openApp)
        storePairing(bound: UUID(), configKey: "")
        XCTAssertEqual(SharedBoardReconnect.footer(in: defaults), .openApp)
        // An older pairing format (a bare configuration) can't be reconnected either.
        defaults.set(Data(#"{"boardName": "kilter", "layoutId": 1, "sizeId": 1}"#.utf8), forKey: SharedConstants.bleBoardConfigKey)
        XCTAssertEqual(SharedBoardReconnect.footer(in: defaults), .openApp)

        storePairing(bound: UUID())
        XCTAssertEqual(SharedBoardReconnect.footer(in: defaults), .reconnect)
        // No App Group: today's button.
        XCTAssertEqual(SharedBoardReconnect.footer(in: nil), .reconnect)
    }

    func testTheCardSaysWhyTheLastReconnectFailedUntilOneSucceeds() {
        storePairing(bound: UUID())
        SharedBoardReconnect.record(.unreachable, in: defaults)
        XCTAssertEqual(SharedBoardReconnect.footer(in: defaults), .retry(.unreachable))
        SharedBoardReconnect.record(.bluetoothOff, in: defaults)
        XCTAssertEqual(SharedBoardReconnect.footer(in: defaults), .retry(.bluetoothOff))
        // A forgotten board says open the app, whatever failed before.
        storePairing(bound: nil)
        XCTAssertEqual(SharedBoardReconnect.footer(in: defaults), .openApp)

        storePairing(bound: UUID())
        SharedWidgetWallControlState.saveBoardConnection("disconnected", holderDisplayName: nil, to: defaults)
        SharedBoardReconnect.record(nil, in: defaults)
        XCTAssertEqual(SharedBoardReconnect.footer(in: defaults), .reconnect)
        // The bulb lights at once, before the app adopts the link.
        XCTAssertEqual(SharedWidgetWallControlState.loadBoardConnection(from: defaults).boardConnection, "connectedByMe")
    }

    func testContentStateRoundTripsTheLightingRevision() throws {
        // What this binary's own redraw writes: the revision survives the trip,
        // so ActivityKit sees a changed state.
        let json = """
        {
          "climbName": "Masquerade",
          "climbDifficulty": "6a/V3",
          "angle": 40,
          "currentIndex": 0,
          "totalClimbs": 2,
          "hasNext": true,
          "hasPrevious": false,
          "climbUuid": "climb-1",
          "lightingRevision": 3
        }
        """
        let decoded = try JSONDecoder().decode(ClimbSessionAttributes.ContentState.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.lightingRevision, 3)
        XCTAssertNil(decoded.restRevision)

        var bumped = decoded
        bumped.lightingRevision = 4
        let roundTripped = try JSONDecoder().decode(
            ClimbSessionAttributes.ContentState.self,
            from: JSONEncoder().encode(bumped)
        )
        XCTAssertEqual(roundTripped.lightingRevision, 4)
        XCTAssertEqual(roundTripped, bumped)
    }

    func testSharedQueueItemDecodesOldPayloadWithoutMirroredField() throws {
        let json = """
        {
          "uuid": "queue-1",
          "climbUuid": "climb-1",
          "climbName": "Old Payload",
          "difficulty": "V4",
          "angle": 40,
          "frames": "p1r12",
          "setterUsername": "tester"
        }
        """

        let item = try JSONDecoder().decode(SharedQueueItem.self, from: Data(json.utf8))

        XCTAssertFalse(item.mirrored)
    }

    func testBoardBleConfigurationDecodesPayloadWithoutAdjacentHoldField() throws {
        let json = """
        {
          "boardName": "moonboard",
          "layoutId": 1,
          "sizeId": 2,
          "apiLevel": null,
          "deviceName": "MoonBoard",
          "colorOverrides": {},
          "numRows": 18
        }
        """

        let configuration = try JSONDecoder().decode(BoardBleConfiguration.self, from: Data(json.utf8))

        XCTAssertNil(configuration.lightAdjacentHolds)
        XCTAssertFalse(configuration.lightAdjacentHolds ?? false)
    }

    func testSharedQueueStateCurrentItemRequiresValidIndex() {
        let items = [
            makeQueueItem(uuid: "queue-1", climbUuid: "climb-1", climbName: "First"),
            makeQueueItem(uuid: "queue-2", climbUuid: "climb-2", climbName: "Second")
        ]
        SharedQueueState.save(items: items, currentIndex: 1, to: defaults)

        XCTAssertEqual(SharedQueueState.currentItem(from: defaults)?.climbName, "Second")

        SharedQueueState.saveCurrentIndex(2, to: defaults)
        XCTAssertNil(SharedQueueState.currentItem(from: defaults))

        SharedQueueState.saveCurrentIndex(-1, to: defaults)
        XCTAssertNil(SharedQueueState.currentItem(from: defaults))
    }

    func testMoonboardPacketEncodesRolesAndSerialPositions() {
        // Parity with packages/shared/ble-protocol/src/__tests__/moonboard.test.ts:
        // p1r42 -> S at serial position 0, p2r43 -> P at serial position 35.
        let result = BoardBleEncoding.makeMoonboardPacket(frames: "p1r42p2r43")

        XCTAssertEqual(String(decoding: result.packet, as: UTF8.self), "l#S0,P35#")
        XCTAssertEqual(result.skippedRoleCount, 0)
        XCTAssertEqual(result.skippedPositionCount, 0)
        XCTAssertEqual(result.totalPlacements, 2)
    }

    func testMoonboardPacketSkipsUnknownRolesAndOutOfRangeHolds() {
        // Role 45 (foot) is not a MoonBoard LED role; hold id 199 is past the
        // 198-hold grid. Both are dropped, the valid start hold still lights.
        let result = BoardBleEncoding.makeMoonboardPacket(frames: "p1r42p5r45p199r43")

        XCTAssertEqual(String(decoding: result.packet, as: UTF8.self), "l#S0#")
        XCTAssertEqual(result.skippedRoleCount, 1)
        XCTAssertEqual(result.skippedPositionCount, 1)
        XCTAssertEqual(result.totalPlacements, 3)
    }

    func testMoonboardPacketClearsForEmptyFrames() {
        // Empty frames = deliberate clear-all: `l##` clears every LED on community
        // firmware (JS parity). totalPlacements 0 (nothing to skip) is what keeps
        // the caller's all-skipped guard from refusing it.
        let result = BoardBleEncoding.makeMoonboardPacket(frames: "")
        XCTAssertEqual(String(decoding: result.packet, as: UTF8.self), "l##")
        XCTAssertEqual(result.totalPlacements, 0)
        XCTAssertEqual(result.skippedRoleCount, 0)
        XCTAssertEqual(result.skippedPositionCount, 0)
    }

    func testMoonboardPacketIsEmptyWhenAllPlacementsSkipped() {
        // A non-empty climb whose holds all drop (role 45 is not a MoonBoard LED
        // role) must produce no packet so the BLE manager refuses to write and
        // leaves the wall lit as-is — never falls through to the clear-all frame.
        XCTAssertTrue(BoardBleEncoding.makeMoonboardPacket(frames: "p1r45").packet.isEmpty)
    }

    func testMoonboardPacketIsEmptyForMalformedFrames() {
        // Corrupt/truncated frames that PARSE to nothing are not a clear: the
        // clear-all gate is the raw empty string, so these must hit the
        // zero-encodable refusal (empty packet), never emit `l##` (#3420).
        XCTAssertTrue(BoardBleEncoding.makeMoonboardPacket(frames: "p12").packet.isEmpty)
        XCTAssertTrue(BoardBleEncoding.makeMoonboardPacket(frames: "pXr42").packet.isEmpty)
        XCTAssertTrue(BoardBleEncoding.makeMoonboardPacket(frames: "garbage").packet.isEmpty)
    }

    func testMoonboardPacketPrefixesV2AdditionalLedMarker() {
        // Parity with moonboard.test.ts "V2 additional-LED prefix": lightAdjacentHolds
        // prepends `~D` to a non-empty frame, asking the firmware to also light each
        // hold's firmware-defined neighbour LED.
        let result = BoardBleEncoding.makeMoonboardPacket(frames: "p1r42p2r43p198r44", lightAdjacentHolds: true)
        XCTAssertEqual(String(decoding: result.packet, as: UTF8.self), "~Dl#S0,P35,E197#")
    }

    func testMoonboardPacketOmitsV2PrefixByDefault() {
        let result = BoardBleEncoding.makeMoonboardPacket(frames: "p1r42")
        XCTAssertEqual(String(decoding: result.packet, as: UTF8.self), "l#S0#")
    }

    func testMoonboardPacketNeverPrefixesClearAll() {
        // The clear-all `l##` never gets the V2 marker, even when requested —
        // prefixing it has no effect and would needlessly exercise the firmware's
        // empty-string parsing path.
        let result = BoardBleEncoding.makeMoonboardPacket(frames: "", lightAdjacentHolds: true)
        XCTAssertEqual(String(decoding: result.packet, as: UTF8.self), "l##")
    }

    func testMoonboardPacketNeverPrefixesAllSkippedFrame() {
        XCTAssertTrue(BoardBleEncoding.makeMoonboardPacket(frames: "p1r45", lightAdjacentHolds: true).packet.isEmpty)
    }

    func testMoonboardSerialPositionMirrorsGridMath() {
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 1), 0)
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 2), 35)
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 198), 197)
        XCTAssertNil(BoardBleEncoding.moonboardSerialPosition(holdId: 0))
        XCTAssertNil(BoardBleEncoding.moonboardSerialPosition(holdId: 199))
    }

    // MARK: - Session queue sync (SessionQueueState.swift)

    private func makeQueueState(uuids: [String], currentIndex: Int) -> QueueStateReducer.QueueState {
        let items = uuids.map { makeQueueItem(uuid: $0, climbUuid: "climb-\($0)", climbName: "Climb \($0)") }
        return QueueStateReducer.QueueState(items: items, currentIndex: currentIndex)
    }

    func testFullSyncIsAcceptedRegardlessOfSequenceGap() {
        // A FullSync is an authoritative snapshot sent on every (re)subscribe.
        // Gap-checking it against the previous connection's sequence caused an
        // infinite reconnect loop after ≥2 events were missed while offline.
        let fullSync = QueueUpdateEvent.fullSync(items: [], currentItem: nil, sequence: 12)
        XCTAssertEqual(
            QueueSequencePolicy.decision(for: fullSync, lastKnown: 3),
            .apply(newLastSequence: 12)
        )

        // Deltas still gap-check: one step ahead applies, a jump resyncs.
        let delta = QueueUpdateEvent.itemRemoved(uuid: "q1", sequence: 5)
        XCTAssertEqual(
            QueueSequencePolicy.decision(for: delta, lastKnown: 4),
            .apply(newLastSequence: 5)
        )
        XCTAssertEqual(
            QueueSequencePolicy.decision(for: delta, lastKnown: 3),
            .resync
        )
        // First event after a (re)connect (lastKnown reset to -1) always applies.
        XCTAssertEqual(
            QueueSequencePolicy.decision(for: delta, lastKnown: -1),
            .apply(newLastSequence: 5)
        )
    }

    // F3 (docs/current-climb-outside-queue.md, sections 2 and 4): every queue
    // reshape is a FullSync followed by a CurrentClimbChanged under the SAME
    // sequence, so a locked phone still repaints the wall. These three pin the
    // native gates that trailing event passes; tightening any of them to reject
    // an equal sequence would silently stop the repaint.

    func testTrailingCurrentClimbChangedAtTheFullSyncSequenceIsApplied() {
        let fullSync = QueueUpdateEvent.fullSync(items: [], currentItem: nil, sequence: 9)
        XCTAssertEqual(QueueSequencePolicy.decision(for: fullSync, lastKnown: 8), .apply(newLastSequence: 9))
        let trailing = QueueUpdateEvent.currentClimbChanged(item: makeQueueItem(), sequence: 9)
        XCTAssertEqual(
            QueueSequencePolicy.decision(for: trailing, lastKnown: 9),
            .apply(newLastSequence: 9)
        )
    }

    func testMirrorStatePersistsTwiceAtTheSameSequence() {
        XCTAssertTrue(SharedMirrorState.persist(items: [makeQueueItem()], currentIndex: 0, sequence: 9, in: defaults))
        XCTAssertTrue(SharedMirrorState.persist(items: [makeQueueItem()], currentIndex: 0, sequence: 9, in: defaults))
        XCTAssertEqual(SharedMirrorState.sequence(in: defaults), 9)
    }

    func testCurrentClimbChangedRepaintsTheBoard() {
        XCTAssertTrue(QueueEventRepaintPolicy.shouldRepaintBoard(for: .currentClimbChanged(item: makeQueueItem(), sequence: 9)))
        XCTAssertFalse(QueueEventRepaintPolicy.shouldRepaintBoard(for: .fullSync(items: [], currentItem: nil, sequence: 9)))
    }

    func testClimbMirroredUpdatesOnlyTheMatchingItem() {
        var state = makeQueueState(uuids: ["A", "B"], currentIndex: 0)
        state = QueueStateReducer.apply(.climbMirrored(uuid: "B", mirrored: true, sequence: 1), to: state)
        XCTAssertFalse(state.items[0].mirrored)
        XCTAssertTrue(state.items[1].mirrored)
        XCTAssertEqual(state.currentIndex, 0)

        // A nil or unknown uuid is a no-op on the state (the manager still
        // persists + repaints unconditionally after every event, so downstream
        // behaviour matches the pre-refactor code).
        let unchanged = state
        state = QueueStateReducer.apply(.climbMirrored(uuid: nil, mirrored: true, sequence: 2), to: state)
        XCTAssertEqual(state, unchanged)
        state = QueueStateReducer.apply(.climbMirrored(uuid: "missing", mirrored: true, sequence: 3), to: state)
        XCTAssertEqual(state, unchanged)
    }

    func testQueueMutationsAheadOfCurrentKeepTheCurrentItem() {
        // Remove ahead of current: [A, B, C, D] current C → [B, C, D] current C.
        var state = makeQueueState(uuids: ["A", "B", "C", "D"], currentIndex: 2)
        state = QueueStateReducer.apply(.itemRemoved(uuid: "A", sequence: 1), to: state)
        XCTAssertEqual(state.items.map(\.uuid), ["B", "C", "D"])
        XCTAssertEqual(state.currentIndex, 1)

        // Insert ahead of current keeps following the item.
        let inserted = makeQueueItem(uuid: "X", climbUuid: "climb-X", climbName: "Climb X")
        state = QueueStateReducer.apply(.itemAdded(item: inserted, position: 0, sequence: 2), to: state)
        XCTAssertEqual(state.items.map(\.uuid), ["X", "B", "C", "D"])
        XCTAssertEqual(state.currentIndex, 2)

        // Reorder across the current item keeps following it too.
        state = QueueStateReducer.apply(.reordered(uuid: "D", oldIndex: 3, newIndex: 0, sequence: 3), to: state)
        XCTAssertEqual(state.items.map(\.uuid), ["D", "X", "B", "C"])
        XCTAssertEqual(state.currentIndex, 3)

        // Reordering the CURRENT item itself follows it to its new position.
        state = QueueStateReducer.apply(.reordered(uuid: "C", oldIndex: 3, newIndex: 0, sequence: 4), to: state)
        XCTAssertEqual(state.items.map(\.uuid), ["C", "D", "X", "B"])
        XCTAssertEqual(state.currentIndex, 0)
    }

    func testRemovingTheCurrentItemFallsToItsSuccessor() {
        var state = makeQueueState(uuids: ["A", "B", "C"], currentIndex: 1)
        state = QueueStateReducer.apply(.itemRemoved(uuid: "B", sequence: 1), to: state)
        XCTAssertEqual(state.items.map(\.uuid), ["A", "C"])
        XCTAssertEqual(state.currentIndex, 1) // now C

        // Removing the last item while it is current clamps to the new tail.
        state = QueueStateReducer.apply(.itemRemoved(uuid: "C", sequence: 2), to: state)
        XCTAssertEqual(state.currentIndex, 0)

        // Emptying the queue leaves index 0 into an empty array — every
        // consumer bounds-checks: SharedQueueState.currentItem returns nil, and
        // the implicit re-light then leaves the wall alone (#4544) while the
        // explicit displayCurrentItem path still clears. So this must stay a
        // representable, non-crashing state.
        state = QueueStateReducer.apply(.itemRemoved(uuid: "A", sequence: 3), to: state)
        XCTAssertTrue(state.items.isEmpty)
        XCTAssertEqual(state.currentIndex, 0)
        SharedQueueState.save(items: state.items, currentIndex: state.currentIndex, to: defaults)
        XCTAssertNil(SharedQueueState.currentItem(from: defaults))
    }

    func testGraphQLErrorRoutingCoversSubscriptionAndMutationIds() {
        // A subscription-level error must reconnect — it used to fall through
        // the mutation-only handling and was silently dropped while server
        // pings kept the connection looking healthy.
        XCTAssertEqual(
            QueueGraphQLErrorRouting.action(forOperationId: "1", subscriptionId: "1"),
            .reconnect
        )
        XCTAssertEqual(
            QueueGraphQLErrorRouting.action(forOperationId: "join-session", subscriptionId: "1"),
            .reconnect
        )
        XCTAssertEqual(
            QueueGraphQLErrorRouting.action(forOperationId: "mutation-abc123", subscriptionId: "1"),
            .revertOptimisticNavigation(correlationId: "abc123")
        )
        XCTAssertEqual(
            QueueGraphQLErrorRouting.action(forOperationId: "something-else", subscriptionId: "1"),
            .ignore
        )
        XCTAssertEqual(
            QueueGraphQLErrorRouting.action(forOperationId: nil, subscriptionId: "1"),
            .ignore
        )
    }

    func testSubscriptionRejectingHistoryCountResubscribesWithoutIt() {
        // A backend without QueueState.historyCount (before F3, or rolled back
        // past it) rejects the whole native document. Reconnecting would send
        // the same document until the attempt cap and freeze the lock screen,
        // so the socket resubscribes with the pre-F3 document instead.
        let errorJson = #"""
        {"id":"1","type":"error","payload":[{"message":"Cannot query field \"historyCount\" on type \"QueueState\".","locations":[{"line":8,"column":17}]}]}
        """#
        let errorPayload = (try? JSONSerialization.jsonObject(with: Data(errorJson.utf8)) as? [String: Any])?["payload"]
        let messages = QueueGraphQLErrorRouting.errorMessages(inPayload: errorPayload)
        XCTAssertEqual(messages, ["Cannot query field \"historyCount\" on type \"QueueState\"."])
        XCTAssertEqual(
            QueueGraphQLErrorRouting.action(forOperationId: "1", subscriptionId: "1", errorMessages: messages),
            .resubscribeWithoutHistoryCount
        )

        // Only the subscription resubscribes: join-session and mutations keep
        // their routing whatever the message says, and an unrelated
        // subscription error still reconnects.
        XCTAssertEqual(
            QueueGraphQLErrorRouting.action(forOperationId: "join-session", subscriptionId: "1", errorMessages: messages),
            .reconnect
        )
        XCTAssertEqual(
            QueueGraphQLErrorRouting.action(forOperationId: "mutation-abc123", subscriptionId: "1", errorMessages: messages),
            .revertOptimisticNavigation(correlationId: "abc123")
        )
        XCTAssertEqual(
            QueueGraphQLErrorRouting.action(forOperationId: "1", subscriptionId: "1", errorMessages: ["Session not found"]),
            .reconnect
        )
        // An object payload (not graphql-ws's error array) carries no messages.
        XCTAssertEqual(QueueGraphQLErrorRouting.errorMessages(inPayload: ["message": "x"]), [])
        XCTAssertEqual(QueueGraphQLErrorRouting.errorMessages(inPayload: nil), [])
    }

    func testFallbackDocumentDropsOnlyTheHistoryCountLine() {
        let document = """
        subscription QueueUpdates($sessionId: ID!) {
          queueUpdates(sessionId: $sessionId) {
            ... on FullSync {
              state {
                sequence
                stateHash
                historyCount
                queue { uuid }
              }
            }
          }
        }
        """
        let fallback = QueueSubscriptionDocument.withoutHistoryCount(document)
        XCTAssertFalse(fallback.contains("historyCount"))
        XCTAssertEqual(
            fallback.components(separatedBy: "\n").count,
            document.components(separatedBy: "\n").count - 1
        )
        XCTAssertTrue(fallback.contains("stateHash"))
        XCTAssertTrue(fallback.contains("queue { uuid }"))
        // A document without the field is left as it is.
        XCTAssertEqual(QueueSubscriptionDocument.withoutHistoryCount(fallback), fallback)
    }

    func testOffQueueCurrentClimbIsAppendedNotIgnored() {
        // Mirrors the JS reducer's shouldAddToQueue: a peer navigating to a
        // search result (not a queue member) must not leave the stale index
        // repainting the previous climb over theirs.
        let offQueue = makeQueueItem(uuid: "S", climbUuid: "climb-S", climbName: "Search Pick")
        var state = makeQueueState(uuids: ["A", "B"], currentIndex: 0)
        state = QueueStateReducer.apply(.currentClimbChanged(item: offQueue, sequence: 1), to: state)
        XCTAssertEqual(state.items.map(\.uuid), ["A", "B", "S"])
        XCTAssertEqual(state.currentIndex, 2)

        // An in-queue current climb just moves the index — no duplicate append.
        state = QueueStateReducer.apply(
            .currentClimbChanged(item: state.items[1], sequence: 2), to: state)
        XCTAssertEqual(state.items.map(\.uuid), ["A", "B", "S"])
        XCTAssertEqual(state.currentIndex, 1)
    }

    func testFullSyncWithOffQueueCurrentItemAppendsIt() {
        let items = ["A", "B"].map { makeQueueItem(uuid: $0, climbUuid: "climb-\($0)", climbName: "Climb \($0)") }
        let offQueue = makeQueueItem(uuid: "S", climbUuid: "climb-S", climbName: "Search Pick")
        let state = QueueStateReducer.apply(
            .fullSync(items: items, currentItem: offQueue, sequence: 7),
            to: makeQueueState(uuids: [], currentIndex: 0)
        )
        XCTAssertEqual(state.items.map(\.uuid), ["A", "B", "S"])
        XCTAssertEqual(state.currentIndex, 2)
    }

    // MARK: - History / Up next line (F3, #6666)

    private func makeQueueItems(_ uuids: [String]) -> [SharedQueueItem] {
        uuids.map { makeQueueItem(uuid: $0, climbUuid: "climb-\($0)", climbName: "Climb \($0)") }
    }

    /// Parses a graphql-ws `next` payload from JSON text, the way the socket
    /// receives it, so JSON null and NSNumber decoding are exercised too.
    private func parseQueueUpdate(json: String) -> QueueUpdateEvent? {
        let payload = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        guard let updates = QueueMessageParser.extractQueueUpdates(from: payload) else { return nil }
        return QueueMessageParser.parseQueueUpdate(updates)
    }

    private func fullSyncHistoryCount(_ event: QueueUpdateEvent?) -> Int? {
        guard let event, case .fullSync(_, _, _, let historyCount) = event else { return nil }
        return historyCount
    }

    func testFullSyncWithNothingCurrentLandsOnTheHeadOfUpNext() {
        // History [A B], nothing current, Up next [C D]: a crewmate removed the
        // current climb. The lock screen used to show A (index 0), History's
        // oldest climb; it now shows C, the climb Next would pick.
        let state = QueueStateReducer.apply(
            .fullSync(items: makeQueueItems(["A", "B", "C", "D"]), currentItem: nil, sequence: 4, historyCount: 2),
            to: makeQueueState(uuids: ["A", "B", "X", "C", "D"], currentIndex: 2)
        )
        XCTAssertEqual(state.items.map(\.uuid), ["A", "B", "C", "D"])
        XCTAssertEqual(state.currentIndex, 2)

        // No History: the head of Up next is index 0.
        let noHistory = QueueStateReducer.apply(
            .fullSync(items: makeQueueItems(["C", "D"]), currentItem: nil, sequence: 5, historyCount: 0),
            to: state
        )
        XCTAssertEqual(noHistory.currentIndex, 0)
    }

    func testFullSyncWithAnEmptyUpNextShowsNoClimb() {
        // Up next empty (historyCount == count): the line sits one past
        // History's newest climb, out of bounds on purpose, so no
        // already-climbed climb is presented as current. Larger values clamp
        // to the same place, negative ones to 0.
        XCTAssertEqual(QueueStateReducer.lineIndex(historyCount: 3, itemCount: 3), 3)
        XCTAssertEqual(QueueStateReducer.lineIndex(historyCount: 9999, itemCount: 3), 3)
        XCTAssertEqual(QueueStateReducer.lineIndex(historyCount: -3, itemCount: 3), 0)
        XCTAssertEqual(QueueStateReducer.lineIndex(historyCount: 0, itemCount: 0), 0)
        XCTAssertEqual(QueueStateReducer.lineIndex(historyCount: 2, itemCount: 0), 0)
        // A pre-F3 server sends no historyCount: today's index 0.
        XCTAssertEqual(QueueStateReducer.lineIndex(historyCount: nil, itemCount: 3), 0)

        let emptyUpNext = QueueStateReducer.apply(
            .fullSync(items: makeQueueItems(["A", "B", "C"]), currentItem: nil, sequence: 6, historyCount: 3),
            to: makeQueueState(uuids: [], currentIndex: 0)
        )
        XCTAssertEqual(emptyUpNext.currentIndex, 3)
        // Nothing reads as current (LiveActivityManager.buildContentState
        // bounds-checks the same way, so the Live Activity gets no frame)...
        SharedQueueState.save(items: emptyUpNext.items, currentIndex: emptyUpNext.currentIndex, to: defaults)
        XCTAssertNil(SharedQueueState.currentItem(from: defaults))
        // ...and the widget's Previous lands on History's newest climb, the
        // one the server's Previous picks with nothing current, while Next
        // is out of bounds, as the server's Next is with Up next empty.
        XCTAssertEqual(ClimbNavigationDirection.previous.newIndex(from: emptyUpNext.currentIndex, count: 3), 2)
        XCTAssertNil(ClimbNavigationDirection.next.newIndex(from: emptyUpNext.currentIndex, count: 3))

        // A climb added to the empty Up next becomes the line's head.
        let added = QueueStateReducer.apply(
            .itemAdded(item: makeQueueItem(uuid: "D", climbUuid: "climb-D", climbName: "Climb D"), position: 3, sequence: 7),
            to: emptyUpNext
        )
        XCTAssertEqual(added.items.map(\.uuid), ["A", "B", "C", "D"])
        XCTAssertEqual(added.currentIndex, 3)

        let emptyQueue = QueueStateReducer.apply(
            .fullSync(items: [], currentItem: nil, sequence: 8, historyCount: 0),
            to: emptyUpNext
        )
        XCTAssertTrue(emptyQueue.items.isEmpty)
        XCTAssertEqual(emptyQueue.currentIndex, 0)
        SharedQueueState.save(items: emptyQueue.items, currentIndex: emptyQueue.currentIndex, to: defaults)
        XCTAssertNil(SharedQueueState.currentItem(from: defaults))
    }

    func testFullSyncWithACurrentClimbIgnoresHistoryCount() {
        // While a climb is current the server sends its index as historyCount;
        // the reducer follows the current uuid whatever the field says.
        let items = makeQueueItems(["A", "B", "C"])
        let state = QueueStateReducer.apply(
            .fullSync(items: items, currentItem: items[1], sequence: 8, historyCount: 0),
            to: makeQueueState(uuids: [], currentIndex: 0)
        )
        XCTAssertEqual(state.currentIndex, 1)

        // An off-queue current climb is still appended, as before F3.
        let offQueue = makeQueueItem(uuid: "S", climbUuid: "climb-S", climbName: "Search Pick")
        let appended = QueueStateReducer.apply(
            .fullSync(items: items, currentItem: offQueue, sequence: 9, historyCount: 1),
            to: state
        )
        XCTAssertEqual(appended.items.map(\.uuid), ["A", "B", "C", "S"])
        XCTAssertEqual(appended.currentIndex, 3)
    }

    func testFullSyncParsesHistoryCountFromTheWire() {
        let withLine = parseQueueUpdate(json: """
        {"data":{"queueUpdates":{"__typename":"FullSync","sequence":11,"state":{"sequence":11,"stateHash":"h","historyCount":2,"queue":[{"uuid":"A","climb":{"uuid":"climb-A","name":"Climb A"}},{"uuid":"B","climb":{"uuid":"climb-B","name":"Climb B"}},{"uuid":"C","climb":{"uuid":"climb-C","name":"Climb C"}}],"currentClimbQueueItem":null}}}}
        """)
        XCTAssertEqual(fullSyncHistoryCount(withLine), 2)
        guard let parsedWithLine = withLine else { return XCTFail("FullSync did not parse") }
        XCTAssertEqual(parsedWithLine.sequence, 11)
        let state = QueueStateReducer.apply(parsedWithLine, to: makeQueueState(uuids: [], currentIndex: 0))
        XCTAssertEqual(state.items.map(\.uuid), ["A", "B", "C"])
        XCTAssertEqual(state.currentIndex, 2)

        // JSON null and an absent field (a pre-F3 server) both parse to nil,
        // which keeps today's index 0.
        let nullLine = parseQueueUpdate(json: """
        {"data":{"queueUpdates":{"__typename":"FullSync","sequence":12,"state":{"sequence":12,"stateHash":"h","historyCount":null,"queue":[{"uuid":"A","climb":{"uuid":"climb-A","name":"Climb A"}}],"currentClimbQueueItem":null}}}}
        """)
        XCTAssertNotNil(nullLine)
        XCTAssertNil(fullSyncHistoryCount(nullLine))

        let absentLine = parseQueueUpdate(json: """
        {"data":{"queueUpdates":{"__typename":"FullSync","sequence":13,"state":{"sequence":13,"stateHash":"h","queue":[{"uuid":"A","climb":{"uuid":"climb-A","name":"Climb A"}}],"currentClimbQueueItem":null}}}}
        """)
        XCTAssertNotNil(absentLine)
        XCTAssertNil(fullSyncHistoryCount(absentLine))
        guard let parsedAbsentLine = absentLine else { return XCTFail("FullSync did not parse") }
        XCTAssertEqual(QueueStateReducer.apply(parsedAbsentLine, to: makeQueueState(uuids: [], currentIndex: 0)).currentIndex, 0)
    }

    func testMoonboardSerialPositionMiniGridMath() {
        // Parity with moonboard.test.ts §Mini (numRows = 12): the Mini LED strip
        // is 11×12, so the odd-column serpentine reversal folds at row 12 (#3392).
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 1, numRows: 12), 0)
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 2, numRows: 12), 23)
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 11, numRows: 12), 120)
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 12, numRows: 12), 1)
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 123, numRows: 12), 12)
        XCTAssertEqual(BoardBleEncoding.moonboardSerialPosition(holdId: 132, numRows: 12), 131)
        // Past the 132-LED Mini strip; valid only on the 18-row wall.
        XCTAssertNil(BoardBleEncoding.moonboardSerialPosition(holdId: 133, numRows: 12))
    }

    func testMoonboardPacketEncodesMiniPositions() {
        // Same holds address different LEDs on the two grids: B1 is serial 35 on
        // the 18-row wall but 23 on the 12-row Mini.
        let mini = BoardBleEncoding.makeMoonboardPacket(frames: "p1r42p2r43p132r44", numRows: 12)
        XCTAssertEqual(String(decoding: mini.packet, as: UTF8.self), "l#S0,P23,E131#")
        XCTAssertEqual(mini.skippedPositionCount, 0)

        let standard = BoardBleEncoding.makeMoonboardPacket(frames: "p2r43")
        XCTAssertEqual(String(decoding: standard.packet, as: UTF8.self), "l#P35#")
    }

    func testBoardRenderUrlUsesSharedBoardContext() {
        defaults.set("https://www.boardsesh.com", forKey: SharedConstants.serverUrlKey)
        defaults.set("kilter", forKey: SharedConstants.boardNameKey)
        defaults.set(1, forKey: SharedConstants.layoutIdKey)
        defaults.set(12, forKey: SharedConstants.sizeIdKey)
        defaults.set("10,12", forKey: SharedConstants.setIdsKey)

        let url = SharedQueueState.boardRenderUrl(for: makeQueueItem(), from: defaults)

        XCTAssertEqual(url?.scheme, "https")
        XCTAssertEqual(url?.host, "www.boardsesh.com")
        XCTAssertEqual(url?.path, "/api/internal/board-render")
        XCTAssertTrue(url?.absoluteString.contains("board_name=kilter") ?? false)
        XCTAssertTrue(url?.absoluteString.contains("frames=p1r12p2r13") ?? false)
        XCTAssertTrue(url?.absoluteString.contains("thumbnail=1") ?? false)
        // 2.0: the thumbnail is composited server-side (matches the Capacitor app);
        // the on-device bundled-art compositing is deferred to the revisit issue.
        XCTAssertTrue(url?.absoluteString.contains("include_background=1") ?? false)
        // The climber's saved look is always explicit; unset resolves to aura
        // (the app default since 2.4 and the server's default for an absent param).
        XCTAssertTrue(url?.absoluteString.contains("render_mode=aura") ?? false)
    }

    func testBoardRenderUrlUsesSavedClassicRenderMode() {
        defaults.set("https://www.boardsesh.com", forKey: SharedConstants.serverUrlKey)
        defaults.set("kilter", forKey: SharedConstants.boardNameKey)
        defaults.set(1, forKey: SharedConstants.layoutIdKey)
        defaults.set(12, forKey: SharedConstants.sizeIdKey)
        defaults.set("10,12", forKey: SharedConstants.setIdsKey)
        defaults.set("classic", forKey: SharedConstants.renderModeKey)

        let url = SharedQueueState.boardRenderUrl(for: makeQueueItem(), from: defaults)

        XCTAssertTrue(url?.absoluteString.contains("render_mode=classic") ?? false)
    }

    func testBoardRenderUrlRejectsGarbageRenderMode() {
        defaults.set("https://www.boardsesh.com", forKey: SharedConstants.serverUrlKey)
        defaults.set("kilter", forKey: SharedConstants.boardNameKey)
        defaults.set(1, forKey: SharedConstants.layoutIdKey)
        defaults.set(12, forKey: SharedConstants.sizeIdKey)
        defaults.set("10,12", forKey: SharedConstants.setIdsKey)
        defaults.set("neon", forKey: SharedConstants.renderModeKey)

        let url = SharedQueueState.boardRenderUrl(for: makeQueueItem(), from: defaults)

        // Validation lives in one choke point (SharedBoardRenderMode.resolve):
        // anything but "classic" resolves to aura rather than reaching the server.
        XCTAssertTrue(url?.absoluteString.contains("render_mode=aura") ?? false)
    }

    // The fetcher (module target) writes and the widget (extension target)
    // reads by this one filename contract; a look change must never serve the
    // other mode's cached bytes.
    func testThumbnailFileNameCarriesRenderMode() {
        XCTAssertEqual(SharedBoardRenderMode.resolve(from: defaults), "aura")
        defaults.set("classic", forKey: SharedConstants.renderModeKey)
        XCTAssertEqual(SharedBoardRenderMode.resolve(from: defaults), "classic")
        defaults.set("neon", forKey: SharedConstants.renderModeKey)
        XCTAssertEqual(SharedBoardRenderMode.resolve(from: defaults), "aura")
        XCTAssertEqual(SharedBoardRenderMode.resolve(from: nil), "aura")

        XCTAssertEqual(
            SharedBoardRenderMode.thumbnailFileName(climbUuid: "climb-1", renderMode: "aura"),
            "climb-1-aura.webp"
        )
        XCTAssertEqual(
            SharedBoardRenderMode.thumbnailFileName(climbUuid: "climb-1", renderMode: "classic"),
            "climb-1-classic.webp"
        )
    }

    // The disconnect-reason dict feeds the JS `disconnected` event
    // (NativeBleDisconnectEvent) and, through it, the `Bluetooth Disconnected`
    // analytics event — key names and the nil-for-clean contract are load-bearing.
    func testDisconnectReasonBodyIsNilForCleanDisconnect() {
        XCTAssertNil(BoardBleEncoding.disconnectReasonBody(from: nil))
    }

    func testDisconnectReasonBodyCarriesCBErrorFields() {
        let timeout = BoardBleEncoding.disconnectReasonBody(from: CBError(.connectionTimeout))
        XCTAssertEqual(timeout?["errorCode"] as? Int, CBError.connectionTimeout.rawValue)
        XCTAssertEqual(timeout?["errorDomain"] as? String, CBErrorDomain)
        XCTAssertFalse((timeout?["errorDescription"] as? String ?? "").isEmpty)
        // The takeover-vs-idle distinction rides on the code: peer-terminated
        // (another central grabbing the last-connection-wins board) must stay
        // distinguishable from the range/idle timeout above.
        let peerDropped = BoardBleEncoding.disconnectReasonBody(from: CBError(.peripheralDisconnected))
        XCTAssertNotEqual(peerDropped?["errorCode"] as? Int, timeout?["errorCode"] as? Int)
    }

    func testDisconnectReasonBodyWrapsArbitraryNSError() {
        let error = NSError(domain: "com.example.test", code: 42, userInfo: [NSLocalizedDescriptionKey: "boom"])
        let body = BoardBleEncoding.disconnectReasonBody(from: error)
        XCTAssertEqual(body?["errorCode"] as? Int, 42)
        XCTAssertEqual(body?["errorDomain"] as? String, "com.example.test")
        XCTAssertEqual(body?["errorDescription"] as? String, "boom")
    }

    // The write type is gated on board family. Aurora (Kilter/Tension) drove the
    // wall with write-without-response through the entire Capacitor era and the
    // first RN port, so it ALWAYS takes that path — even when iOS reports the
    // characteristic without the `.writeWithoutResponse` bit (seen on iOS 26.x,
    // which routed Aurora to a stalling write-with-response path). Only the
    // original MoonBoard LED box (UART advertises `.write` only; CoreBluetooth
    // silently drops a `.withoutResponse` write to it) falls back to
    // `.withResponse`.
    func testPreferredWriteTypeIsMoonboardGated() {
        // Aurora: always without-response, regardless of advertised properties.
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: .writeWithoutResponse, boardName: "kilter"), .withoutResponse)
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: .write, boardName: "kilter"), .withoutResponse)
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: .write, boardName: "tension"), .withoutResponse)
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: [.read], boardName: "tension"), .withoutResponse)
        // Unknown / nil board (e.g. a JS write before configureBoard): safe
        // without-response default, never the stalling with-response path.
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: .write, boardName: nil), .withoutResponse)
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: [.read], boardName: nil), .withoutResponse)
        // MoonBoard: choose from the advertised properties (the 00bda53a2 fix).
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: .write, boardName: "moonboard"), .withResponse)
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: .writeWithoutResponse, boardName: "moonboard"), .withoutResponse)
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: [.write, .writeWithoutResponse], boardName: "moonboard"), .withoutResponse)
        // Defensive default: a characteristic advertising neither write property
        // can't be written either way (CoreBluetooth drops/ rejects the write and
        // the wall stays dark) — we just don't pick the unacknowledged path for it.
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: [.read], boardName: "moonboard"), .withResponse)
        // Woods: unconditionally acknowledged (spec §8) — the property bits
        // never override it, mirroring Aurora's fixed choice the other way.
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: .write, boardName: "woods"), .withResponse)
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: .writeWithoutResponse, boardName: "woods"), .withResponse)
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: [.write, .writeWithoutResponse], boardName: "woods"), .withResponse)
        XCTAssertEqual(BoardBleEncoding.preferredWriteType(for: [.read], boardName: "woods"), .withResponse)
    }

    // Transport chunk sizing (#3230). Aurora without-response chunks come from
    // the negotiated maximumWriteValueLength clamped to [20, 244] — never the
    // ATT-512-derived 509 the failing iOS 26.5 cohort clusters at. MoonBoard
    // (both controller generations) and any with-response path stay at 20.
    // Twin of `effectiveChunkSizeForMtu` in
    // packages/shared/ble-protocol/src/transport.ts, with one domain
    // difference: this side takes maximumWriteValueLength, which iOS reports
    // as a PAYLOAD length (ATT MTU − 3), while the TS side takes the raw MTU —
    // so the matrices differ by exactly 3 (TS mtu 23 ↔ Swift length 20).
    func testEffectiveChunkSizeClampsAuroraAndPinsMoonboard() {
        // Aurora without-response: clamp to the ATT-247 ceiling (244 payload).
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 509, writeType: .withoutResponse, boardName: "kilter"), 244)
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 512, writeType: .withoutResponse, boardName: "tension"), 244)
        // Pass through negotiated payload lengths inside the window.
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 244, writeType: .withoutResponse, boardName: "kilter"), 244)
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 182, writeType: .withoutResponse, boardName: "kilter"), 182)
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 23, writeType: .withoutResponse, boardName: "kilter"), 23)
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 252, writeType: .withoutResponse, boardName: "tension"), 244)
        // Floor at the classic 20: the BLE-default link reports payload 20
        // (ATT 23 − 3); anything below is degenerate and must not shrink chunks.
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 20, writeType: .withoutResponse, boardName: "kilter"), 20)
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 19, writeType: .withoutResponse, boardName: "kilter"), 20)
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 0, writeType: .withoutResponse, boardName: "kilter"), 20)
        // nil board (a JS write before configureBoard) is Aurora-shaped: clamped MTU sizing.
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 509, writeType: .withoutResponse, boardName: nil), 244)
        // MoonBoard stays on the proven 20-byte chunks on BOTH write types.
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 509, writeType: .withoutResponse, boardName: "moonboard"), 20)
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 509, writeType: .withResponse, boardName: "moonboard"), 20)
        // Any with-response path stays at 20 regardless of board.
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 512, writeType: .withResponse, boardName: "kilter"), 20)
        // Woods: spec §8 mandates 20-byte chunks on both write types (the
        // without-response case is unreachable but must not size from the MTU).
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 509, writeType: .withResponse, boardName: "woods"), 20)
        XCTAssertEqual(BoardBleEncoding.effectiveChunkSize(negotiatedMaxWriteLength: 509, writeType: .withoutResponse, boardName: "woods"), 20)
    }

    // MARK: - Aurora packet encoding (parity with @boardsesh/ble-protocol)

    private func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    /// Color byte of a single-LED v3 packet:
    /// [SOH, LEN, CHK, STX, T, posLo, posHi, color, ETX].
    private func singleLedColorByte(_ result: BoardBlePacketResult) -> UInt8? {
        let bytes = [UInt8](result.packet)
        guard bytes.count == 9 else { return nil }
        return bytes[7]
    }

    func testAuroraPacketByteExactMatchesValidatedKilter12x12() {
        // 3rd-party validated payload for Kilter Original 12x12 (Layout 1) — the
        // same ground-truth fixture as the web bluetooth-packet.test.ts. Locks
        // Swift ↔ TS ↔ hardware parity for the v3 encoder.
        let result = BoardBleEncoding.makeAuroraPacket(
            frames: "p1379r44p1395r44p1447r45p1464r45",
            placementPositions: [1379: 68, 1395: 476, 1447: 0, 1464: 33],
            boardName: "kilter"
        )
        XCTAssertEqual(hex(result.packet), "010dbb02544400e3dc01e30000f42100f403")
    }

    func testAuroraPacketByteExactMatchesValidatedKilter8x12Original() {
        let result = BoardBleEncoding.makeAuroraPacket(
            frames: "p1382r44p1392r44p1450r45p1461r45",
            placementPositions: [1382: 56, 1392: 311, 1450: 0, 1461: 21],
            boardName: "kilter"
        )
        XCTAssertEqual(hex(result.packet), "010d7802543800e33701e30000f41500f403")
    }

    func testAuroraHoldStateColorsMatchCanonicalMap() {
        // Indirect holdStateMap parity: each role's canonical LED color must
        // encode to the same v3 color byte as @boardsesh/board-constants. A drift
        // in the hand-copied Swift map would flip one of these bytes.
        func color(_ frames: String, _ board: String) -> UInt8? {
            singleLedColorByte(
                BoardBleEncoding.makeAuroraPacket(frames: frames, placementPositions: [1: 10], boardName: board)
            )
        }
        // kilter: 42 STARTING #00FF00, 43 HAND #00FFFF, 44 FINISH #FF00FF, 45 FOOT #FFAA00
        XCTAssertEqual(color("p1r42", "kilter"), 0x1C)
        XCTAssertEqual(color("p1r43", "kilter"), 0x1F)
        XCTAssertEqual(color("p1r44", "kilter"), 0xE3)
        XCTAssertEqual(color("p1r45", "kilter"), 0xF4)
        // tension: 1 STARTING #00FF00, 3 FINISH #FF0000
        XCTAssertEqual(color("p1r1", "tension"), 0x1C)
        XCTAssertEqual(color("p1r3", "tension"), 0xE0)
        // decoy (common Aurora role map): 3 FINISH #FF0000
        XCTAssertEqual(color("p1r3", "decoy"), 0xE0)
    }

    func testAuroraColorOverrideSanitization() {
        let positions = [1: 10]
        // A valid 6-digit hex override is honoured (red).
        XCTAssertEqual(
            singleLedColorByte(
                BoardBleEncoding.makeAuroraPacket(
                    frames: "p1r42",
                    placementPositions: positions,
                    boardName: "kilter",
                    colorOverrides: ["STARTING": "#FF0000"]
                )
            ),
            0xE0
        )
        // Malformed overrides fall back to the canonical color (green 0x1C), NOT
        // black — parity with the TS SIX_DIGIT_HEX_PATTERN guard.
        for bad in ["#fff", "red", "#FF00FF00", "12345g", "ab#cdef"] {
            XCTAssertEqual(
                singleLedColorByte(
                    BoardBleEncoding.makeAuroraPacket(
                        frames: "p1r42",
                        placementPositions: positions,
                        boardName: "kilter",
                        colorOverrides: ["STARTING": bad]
                    )
                ),
                0x1C,
                "override \"\(bad)\" should fall back to the canonical green"
            )
        }
    }

    func testParseApiLevelMatchesFirstAtSign() {
        XCTAssertEqual(BoardBleEncoding.parseApiLevel(deviceName: "Kilter Board#abc123@3"), 3)
        XCTAssertEqual(BoardBleEncoding.parseApiLevel(deviceName: "Kilter Board"), 2)
        XCTAssertEqual(BoardBleEncoding.parseApiLevel(deviceName: nil), 2)
        XCTAssertEqual(BoardBleEncoding.parseApiLevel(deviceName: "Board@4"), 4)
        // The FIRST '@' with digits wins (mirrors TS /@(\d+)/), not the last —
        // the old `.backwards` implementation would have returned 9 here.
        XCTAssertEqual(BoardBleEncoding.parseApiLevel(deviceName: "Board@2@9"), 2)
        // First '@' has no digits after it; fall through to the next.
        XCTAssertEqual(BoardBleEncoding.parseApiLevel(deviceName: "Board@x@5"), 5)
    }

}

@available(iOS 17.0, *)
private final class IntentDiagnosticTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var currentDate: Date

    init(currentDate: Date) {
        self.currentDate = currentDate
    }

    func now() -> Date {
        lock.lock()
        defer { lock.unlock() }
        return currentDate
    }

    func advance(by interval: TimeInterval) {
        lock.lock()
        defer { lock.unlock() }
        currentDate = currentDate.addingTimeInterval(interval)
    }
}

@available(iOS 17.0, *)
final class LiveActivityIntentDiagnosticStoreTests: XCTestCase {
    private var suiteName: String!
    private var defaults: UserDefaults!
    private var clock = IntentDiagnosticTestClock(
        currentDate: Date(timeIntervalSince1970: 2_000_000_000)
    )

    override func setUp() {
        super.setUp()
        suiteName = "com.boardsesh.rn.intent-diagnostic-tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
        clock = IntentDiagnosticTestClock(currentDate: Date(timeIntervalSince1970: 2_000_000_000))
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    private func makeStore(
        processId: UUID = UUID(),
        appVersion: String = "2.0.0",
        buildNumber: String = "481",
        maxRecords: Int = 16,
        timeToLive: TimeInterval = 24 * 60 * 60,
        incompleteGrace: TimeInterval = 30
    ) -> LiveActivityIntentDiagnosticStore {
        let clock = self.clock
        return LiveActivityIntentDiagnosticStore(
            defaults: defaults,
            storageKey: "intent-diagnostic-tests",
            processId: processId,
            appVersion: appVersion,
            buildNumber: buildNumber,
            maxRecords: maxRecords,
            timeToLive: timeToLive,
            incompleteGrace: incompleteGrace,
            now: { clock.now() }
        )
    }

    func testRunLifecycleAndNormalEarlyCompletionAreDurableAndIdempotent() throws {
        let store = makeStore()
        let run = store.begin(kind: .nextClimb)

        XCTAssertEqual(store.recordsSnapshot().single?.lastStage, .entered)
        run.mark(.networkStarted)
        XCTAssertEqual(store.recordsSnapshot().single?.lastStage, .networkStarted)

        // Models an ordinary guard return (for example queue bounds). The
        // production intent uses defer, so the same completion always runs.
        run.complete(.navigationOutOfBounds)
        run.mark(.bleStarted)
        run.complete(.success)

        let completed = try XCTUnwrap(store.recordsSnapshot().single)
        XCTAssertEqual(completed.lastStage, .completed)
        XCTAssertEqual(completed.completionClass, .navigationOutOfBounds)
        XCTAssertNil(LiveActivityInterruptedIntentDiagnostic(record: completed))
    }

    func testSameProcessAndCompletedRecordsAreNeverConsumed() {
        let processId = UUID()
        let store = makeStore(processId: processId)
        _ = store.begin(kind: .previousClimb)
        let completed = store.begin(kind: .takeControl)
        completed.complete(.alreadyAllowed)
        clock.advance(by: 60)

        XCTAssertTrue(store.consumeInterruptedRuns().isEmpty)
        XCTAssertEqual(store.recordsSnapshot().count, 2)
    }

    func testPreviousProcessRecordWaitsForGraceThenConsumesOnce() throws {
        let firstProcess = makeStore(processId: UUID())
        _ = firstProcess.begin(kind: .nextClimb)

        clock.advance(by: 29)
        let foregroundProcess = makeStore(processId: UUID())
        XCTAssertTrue(foregroundProcess.consumeInterruptedRuns().isEmpty)

        clock.advance(by: 2)
        let consumed = foregroundProcess.consumeInterruptedRuns()
        XCTAssertEqual(consumed.count, 1)
        let interrupted = try XCTUnwrap(consumed.single)
        XCTAssertEqual(interrupted.intentKind, .nextClimb)
        XCTAssertNotEqual(interrupted.lastStage, .completed)
        XCTAssertNil(interrupted.completionClass)
        let bridgeDiagnostic = try XCTUnwrap(LiveActivityInterruptedIntentDiagnostic(record: interrupted))
        XCTAssertEqual(bridgeDiagnostic.lastStage, .entered)
        XCTAssertEqual(bridgeDiagnostic.bridgePayload["lastStage"] as? String, "entered")
        XCTAssertNil(bridgeDiagnostic.bridgePayload["completionClass"])
        XCTAssertTrue(foregroundProcess.consumeInterruptedRuns().isEmpty)

        // Recreating the consumer with the same durable store still cannot
        // return the consumed run a second time.
        let secondConsumer = makeStore(processId: UUID())
        XCTAssertTrue(secondConsumer.consumeInterruptedRuns().isEmpty)
    }

    func testReactRootMarkerTouchesOnlyIncompleteRunsFromCurrentProcess() {
        let oldProcess = makeStore(processId: UUID())
        _ = oldProcess.begin(kind: .nextClimb)

        let currentProcess = makeStore(processId: UUID())
        _ = currentProcess.begin(kind: .reconnectBoard)
        let completed = currentProcess.begin(kind: .takeControl)
        completed.complete(.success)
        currentProcess.markReactRootMounted()

        let records = currentProcess.recordsSnapshot()
        XCTAssertFalse(records.first(where: { $0.intentKind == .nextClimb })?.reactRootMounted ?? true)
        XCTAssertTrue(records.first(where: { $0.intentKind == .reconnectBoard })?.reactRootMounted ?? false)
        XCTAssertFalse(records.first(where: { $0.intentKind == .takeControl })?.reactRootMounted ?? true)
    }

    func testTimeToLiveAndBuildValidationDiscardInsteadOfReport() {
        let oldBuild = makeStore(processId: UUID(), buildNumber: "480")
        _ = oldBuild.begin(kind: .nextClimb)
        clock.advance(by: 31)

        let newBuild = makeStore(processId: UUID(), buildNumber: "481")
        XCTAssertTrue(newBuild.consumeInterruptedRuns().isEmpty)
        XCTAssertTrue(newBuild.recordsSnapshot().isEmpty)

        let currentBuild = makeStore(processId: UUID(), timeToLive: 60)
        _ = currentBuild.begin(kind: .previousClimb)
        clock.advance(by: 61)
        let laterProcess = makeStore(processId: UUID(), timeToLive: 60)
        XCTAssertTrue(laterProcess.consumeInterruptedRuns().isEmpty)
        XCTAssertTrue(laterProcess.recordsSnapshot().isEmpty)
    }

    func testCorruptAndWrongSchemaPayloadsFailClosed() {
        defaults.set(Data("not-json".utf8), forKey: "intent-diagnostic-tests")
        let store = makeStore()
        XCTAssertTrue(store.consumeInterruptedRuns().isEmpty)
        XCTAssertTrue(store.recordsSnapshot().isEmpty)

        let wrongSchema = Data("{\"schemaVersion\":2,\"records\":[],\"consumed\":[]}".utf8)
        defaults.set(wrongSchema, forKey: "intent-diagnostic-tests")
        XCTAssertTrue(store.consumeInterruptedRuns().isEmpty)
        XCTAssertTrue(store.recordsSnapshot().isEmpty)
    }

    func testRingBufferKeepsOnlyNewestBoundedRecords() {
        let store = makeStore(maxRecords: 4)
        for index in 0..<10 {
            _ = store.begin(kind: index.isMultiple(of: 2) ? .nextClimb : .previousClimb)
            clock.advance(by: 1)
        }

        let records = store.recordsSnapshot()
        XCTAssertEqual(records.count, 4)
        XCTAssertEqual(Set(records.map(\.runId)).count, 4)
    }

    func testInterruptedStageProjectionCoversEveryNonCompletedStage() {
        let storedInterruptedStages = Set(
            LiveActivityIntentDiagnosticStage.allCases
                .filter { $0 != .completed }
                .map(\.rawValue)
        )
        let bridgeStages = Set(LiveActivityInterruptedIntentDiagnosticStage.allCases.map(\.rawValue))

        XCTAssertEqual(bridgeStages, storedInterruptedStages)
        for storedStage in LiveActivityIntentDiagnosticStage.allCases {
            let projected = LiveActivityInterruptedIntentDiagnosticStage(rawValue: storedStage.rawValue)
            if storedStage == .completed {
                XCTAssertNil(projected)
            } else {
                XCTAssertEqual(projected?.rawValue, storedStage.rawValue)
            }
        }
    }

    func testPersistedAndBridgedFieldsAreBoundedAndIdentifierFree() throws {
        let store = makeStore(
            appVersion: "2.0.0<script>alert(1)</script>",
            buildNumber: "481\nBearer secret"
        )
        _ = store.begin(kind: .reconnectBoard)
        let record = try XCTUnwrap(store.recordsSnapshot().single)

        XCTAssertEqual(record.appVersion, "2.0.0scriptalert1script")
        XCTAssertEqual(record.buildNumber, "481Bearersecret")
        XCTAssertLessThanOrEqual(record.appVersion.count, 64)
        XCTAssertNotNil(UUID(uuidString: record.runId))
        XCTAssertNotNil(UUID(uuidString: record.processId))

        let bridgeDiagnostic = try XCTUnwrap(LiveActivityInterruptedIntentDiagnostic(record: record))
        let bridgeJson = try JSONSerialization.data(withJSONObject: bridgeDiagnostic.bridgePayload)
        let bridgeText = try XCTUnwrap(String(data: bridgeJson, encoding: .utf8)).lowercased()
        for forbiddenKey in ["userid", "climb", "session", "server", "endpoint", "peripheral", "authtoken"] {
            XCTAssertFalse(bridgeText.contains(forbiddenKey), "unexpected identifier field: \(forbiddenKey)")
        }
    }
}

private extension Array {
    var single: Element? {
        count == 1 ? first : nil
    }
}
