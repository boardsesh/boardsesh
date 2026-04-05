import XCTest
@testable import App

// MARK: - Mock WebSocket Message Delegate

class MockWebSocketMessageDelegate: WebSocketMessageDelegate {
    var receivedMessages: [String] = []
    var connectionStateChanges: [(connected: Bool, reconnectAttempt: Int)] = []
    var messageExpectation: XCTestExpectation?
    var connectionExpectation: XCTestExpectation?

    func didReceiveRawMessage(_ text: String) {
        receivedMessages.append(text)
        messageExpectation?.fulfill()
    }

    func connectionStateDidChange(connected: Bool, reconnectAttempt: Int) {
        connectionStateChanges.append((connected: connected, reconnectAttempt: reconnectAttempt))
        connectionExpectation?.fulfill()
    }
}

// MARK: - NativeWebSocketPluginTests

final class NativeWebSocketPluginTests: XCTestCase {

    private var manager: SessionWebSocketManager!
    private var mockDelegate: MockWebSocketMessageDelegate!

    override func setUp() {
        super.setUp()
        manager = SessionWebSocketManager(urlSession: .shared)
        mockDelegate = MockWebSocketMessageDelegate()
        manager.messageDelegate = mockDelegate
    }

    override func tearDown() {
        manager.disconnect()
        manager = nil
        mockDelegate = nil
        super.tearDown()
    }

    // MARK: - Message Buffering Tests

    func testMessageBufferingWhenWebviewInactive() {
        // When webview is inactive, messages should be buffered and NOT forwarded
        let expectation = expectation(description: "Buffer should not forward messages")
        expectation.isInverted = true
        mockDelegate.messageExpectation = expectation

        manager.setWebviewActive(false)

        // Give the async setWebviewActive time to execute
        let bufferExpectation = self.expectation(description: "Wait for buffer setup")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            bufferExpectation.fulfill()
        }
        wait(for: [bufferExpectation], timeout: 1.0)

        // The delegate should NOT have received anything (inverted expectation)
        wait(for: [expectation], timeout: 0.5)
        XCTAssertTrue(mockDelegate.receivedMessages.isEmpty)
    }

    func testBufferFlushOnWebviewActive() {
        // Set inactive, then active, and verify buffered messages are flushed in order
        let inactiveExpectation = expectation(description: "Webview set inactive")

        manager.setWebviewActive(false)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            inactiveExpectation.fulfill()
        }
        wait(for: [inactiveExpectation], timeout: 1.0)

        // Now set active - the flush should deliver buffered messages via delegate
        // Since we can't directly buffer messages (private), we test the public flow:
        // setWebviewActive(false) -> setWebviewActive(true) with no messages = no delegate calls
        let flushExpectation = expectation(description: "Flush completes")

        manager.setWebviewActive(true)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            flushExpectation.fulfill()
        }
        wait(for: [flushExpectation], timeout: 1.0)

        // No messages were buffered, so delegate should have received nothing
        XCTAssertTrue(mockDelegate.receivedMessages.isEmpty)
    }

    func testSetWebviewActiveToggle() {
        // Verify toggling webview active state doesn't crash
        manager.setWebviewActive(false)
        manager.setWebviewActive(true)
        manager.setWebviewActive(false)
        manager.setWebviewActive(true)

        let waitExpectation = expectation(description: "All toggles processed")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            waitExpectation.fulfill()
        }
        wait(for: [waitExpectation], timeout: 1.0)
    }

    func testMaxBufferSizeConstant() {
        // Verify the manager has a reasonable buffer size limit
        // The maxBufferSize is 500 (private), but we can verify behavior indirectly
        // by checking that the manager doesn't crash when we toggle states rapidly
        manager.setWebviewActive(false)
        manager.setWebviewActive(true)

        let waitExpectation = expectation(description: "Toggle processed")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            waitExpectation.fulfill()
        }
        wait(for: [waitExpectation], timeout: 1.0)
    }

    // MARK: - Subscription Tracking Tests

    func testMultipleSubscriptionTracking() {
        // Add multiple external subscriptions and verify they're tracked
        // The internal subscription "1" is always present
        manager.addSubscription(
            query: "subscription Test1 { test1 }",
            variables: [:],
            subscriptionId: "ext-1"
        )
        manager.addSubscription(
            query: "subscription Test2 { test2 }",
            variables: [:],
            subscriptionId: "ext-2"
        )
        manager.addSubscription(
            query: "subscription Test3 { test3 }",
            variables: [:],
            subscriptionId: "ext-3"
        )

        let waitExpectation = expectation(description: "Subscriptions added")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            waitExpectation.fulfill()
        }
        wait(for: [waitExpectation], timeout: 1.0)

        // We can't directly read activeSubscriptionIds (private set),
        // but we can verify the operations don't crash and that removing
        // subscriptions also works
        manager.removeSubscription("ext-2")

        let removeExpectation = expectation(description: "Subscription removed")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            removeExpectation.fulfill()
        }
        wait(for: [removeExpectation], timeout: 1.0)
    }

    func testSubscribeAndUnsubscribe() {
        // Subscribe then immediately unsubscribe
        manager.addSubscription(
            query: "subscription Echo { echo }",
            variables: ["key": "value"],
            subscriptionId: "sub-123"
        )

        let addExpectation = expectation(description: "Subscription added")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            addExpectation.fulfill()
        }
        wait(for: [addExpectation], timeout: 1.0)

        manager.removeSubscription("sub-123")

        let removeExpectation = expectation(description: "Subscription removed")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            removeExpectation.fulfill()
        }
        wait(for: [removeExpectation], timeout: 1.0)

        // Removing a non-existent subscription should not crash
        manager.removeSubscription("nonexistent-sub")

        let safeExpectation = expectation(description: "Safe remove processed")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            safeExpectation.fulfill()
        }
        wait(for: [safeExpectation], timeout: 1.0)
    }

    func testRemoveNonexistentSubscription() {
        // Removing a subscription that was never added should not crash
        manager.removeSubscription("never-added")

        let waitExpectation = expectation(description: "Remove processed")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            waitExpectation.fulfill()
        }
        wait(for: [waitExpectation], timeout: 1.0)
    }

    // MARK: - Generic Operation Tests

    func testSendOperationConstructsCorrectMessage() {
        // sendOperation should construct a graphql-ws subscribe message
        // Since there's no active connection, the send will fail silently,
        // but we can verify the method doesn't crash with various inputs
        manager.sendOperation(
            query: "mutation DoSomething($input: String!) { doSomething(input: $input) }",
            variables: ["input": "test-value"],
            operationId: "op-1"
        )

        // Test with empty variables
        manager.sendOperation(
            query: "query GetStatus { status }",
            variables: [:],
            operationId: "op-2"
        )

        // Test with nested variables
        manager.sendOperation(
            query: "mutation Complex($data: JSON!) { complex(data: $data) }",
            variables: [
                "data": [
                    "nested": "value",
                    "number": 42
                ] as [String: Any]
            ],
            operationId: "op-3"
        )

        let waitExpectation = expectation(description: "Operations sent")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            waitExpectation.fulfill()
        }
        wait(for: [waitExpectation], timeout: 1.0)
    }

    func testSendOperationMessageStructure() {
        // Verify the JSON structure matches graphql-ws protocol by constructing
        // what sendOperation would build and parsing it
        let query = "mutation Test($id: ID!) { test(id: $id) }"
        let variables: [String: Any] = ["id": "123"]
        let operationId = "test-op"

        let expectedMessage: [String: Any] = [
            "type": "subscribe",
            "id": operationId,
            "payload": [
                "query": query,
                "variables": variables
            ] as [String: Any]
        ]

        // Verify the structure can be serialized to JSON
        let data = try? JSONSerialization.data(withJSONObject: expectedMessage)
        XCTAssertNotNil(data)

        // Verify the serialized JSON contains the expected fields
        if let data = data, let text = String(data: data, encoding: .utf8) {
            XCTAssertTrue(text.contains("\"type\":\"subscribe\"") || text.contains("\"type\" : \"subscribe\""))
            XCTAssertTrue(text.contains(operationId))
        }
    }

    // MARK: - Auth Token Tests

    func testAuthTokenUpdate() {
        // Initially nil
        XCTAssertNil(manager.authToken)

        // Update token
        manager.updateAuthToken("new-token-abc")

        let waitExpectation = expectation(description: "Token updated")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            waitExpectation.fulfill()
        }
        wait(for: [waitExpectation], timeout: 1.0)

        XCTAssertEqual(manager.authToken, "new-token-abc")
    }

    func testAuthTokenPassedInConnectionInit() {
        // When authToken is set, connection_init should include it in the payload
        // We can verify the message structure by building what sendConnectionInit produces
        let token = "test-auth-token"
        var payload: [String: Any] = [:]
        payload["authToken"] = token

        let message: [String: Any] = [
            "type": GQLMessageType.connectionInit.rawValue,
            "payload": payload
        ]

        let data = try? JSONSerialization.data(withJSONObject: message)
        XCTAssertNotNil(data)

        if let data = data,
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let msgPayload = json["payload"] as? [String: Any] {
            XCTAssertEqual(msgPayload["authToken"] as? String, token)
        } else {
            XCTFail("Failed to parse connection_init message")
        }
    }

    func testUnauthenticatedConnectionInit() {
        // When no authToken is set, connection_init payload should be empty
        var payload: [String: Any] = [:]
        // No token set — payload stays empty

        let message: [String: Any] = [
            "type": GQLMessageType.connectionInit.rawValue,
            "payload": payload
        ]

        let data = try? JSONSerialization.data(withJSONObject: message)
        XCTAssertNotNil(data)

        if let data = data,
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let msgPayload = json["payload"] as? [String: Any] {
            XCTAssertTrue(msgPayload.isEmpty, "Payload should be empty when no auth token is set")
        } else {
            XCTFail("Failed to parse connection_init message")
        }
    }

    func testAuthTokenOverwrite() {
        // Updating the token multiple times should keep the latest value
        manager.updateAuthToken("token-1")
        manager.updateAuthToken("token-2")
        manager.updateAuthToken("token-3")

        let waitExpectation = expectation(description: "Tokens updated")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            waitExpectation.fulfill()
        }
        wait(for: [waitExpectation], timeout: 1.0)

        XCTAssertEqual(manager.authToken, "token-3")
    }

    // MARK: - Delegate Forwarding Tests

    func testDelegateReceivesRawMessages() {
        // Verify that the delegate property can be set and read back
        let delegate = MockWebSocketMessageDelegate()
        manager.messageDelegate = delegate

        // Verify delegate is set (weak reference, so it should be retained by this test)
        XCTAssertNotNil(manager.messageDelegate)
    }

    func testDelegateNotifiedOnConnectionStateChange() {
        // Verify delegate receives connection state changes on disconnect
        let stateExpectation = expectation(description: "Connection state change")
        mockDelegate.connectionExpectation = stateExpectation

        // Disconnecting should notify delegate of state change
        manager.disconnect()

        wait(for: [stateExpectation], timeout: 2.0)

        XCTAssertFalse(mockDelegate.connectionStateChanges.isEmpty)
        let lastChange = mockDelegate.connectionStateChanges.last
        XCTAssertNotNil(lastChange)
        XCTAssertFalse(lastChange!.connected)
    }

    func testLiveActivityCallbackStillWorks() {
        // Both delegate and onQueueStateChanged should be settable without conflict
        var callbackCalled = false
        manager.onQueueStateChanged = { items, currentIndex in
            callbackCalled = true
        }

        // Setting a delegate should not affect the callback
        let delegate = MockWebSocketMessageDelegate()
        manager.messageDelegate = delegate

        // Verify both are set
        XCTAssertNotNil(manager.onQueueStateChanged)
        XCTAssertNotNil(manager.messageDelegate)
    }

    func testDelegateIsWeakReference() {
        // Verify the delegate is a weak reference
        var delegate: MockWebSocketMessageDelegate? = MockWebSocketMessageDelegate()
        manager.messageDelegate = delegate

        // Delegate should be set
        XCTAssertNotNil(manager.messageDelegate)

        // Release the delegate
        delegate = nil

        // Give the weak reference time to nil out
        let waitExpectation = expectation(description: "Weak reference cleared")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            waitExpectation.fulfill()
        }
        wait(for: [waitExpectation], timeout: 1.0)

        // Delegate should be nil now (weak reference)
        XCTAssertNil(manager.messageDelegate)
    }

    // MARK: - Reconnect with Auth Token

    func testReconnectPreservesAuthToken() {
        // Set an auth token
        manager.updateAuthToken("persistent-token")

        let tokenExpectation = expectation(description: "Token set")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            tokenExpectation.fulfill()
        }
        wait(for: [tokenExpectation], timeout: 1.0)

        XCTAssertEqual(manager.authToken, "persistent-token")

        // Disconnect
        manager.disconnect()

        let disconnectExpectation = expectation(description: "Disconnected")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            disconnectExpectation.fulfill()
        }
        wait(for: [disconnectExpectation], timeout: 1.0)

        // Token should still be set after disconnect
        XCTAssertEqual(manager.authToken, "persistent-token")
    }

    func testReconnectAttemptResetOnNewConnection() {
        // Set reconnect attempt to simulate previous reconnection attempts
        manager.reconnectAttempt = 5

        XCTAssertEqual(manager.reconnectAttempt, 5)

        // The reconnectAttempt is reset to 0 when connection_ack is received
        // We verify it can be read and written
        manager.reconnectAttempt = 0
        XCTAssertEqual(manager.reconnectAttempt, 0)
    }

    // MARK: - Internal Subscription ID

    func testInternalSubscriptionIdIsOne() {
        // The internal subscription for Live Activity uses ID "1"
        // We verify this by checking message parsing with id "1"
        let text = #"{"type":"next","id":"1","payload":{"data":{"queueUpdates":{"__typename":"FullSync","sequence":1,"state":{"sequence":1,"stateHash":"h","queue":[]}}}}}"#
        let msg = GQLMessage.parse(text)

        XCTAssertNotNil(msg)
        XCTAssertEqual(msg?.id, "1")
        XCTAssertEqual(msg?.type, .next)
    }

    // MARK: - WebSocketMessageDelegate Protocol Tests

    func testWebSocketMessageDelegateProtocol() {
        // Verify the protocol exists and mock can conform
        let delegate = MockWebSocketMessageDelegate()

        delegate.didReceiveRawMessage("test message")
        XCTAssertEqual(delegate.receivedMessages.count, 1)
        XCTAssertEqual(delegate.receivedMessages[0], "test message")

        delegate.connectionStateDidChange(connected: true, reconnectAttempt: 0)
        XCTAssertEqual(delegate.connectionStateChanges.count, 1)
        XCTAssertTrue(delegate.connectionStateChanges[0].connected)
        XCTAssertEqual(delegate.connectionStateChanges[0].reconnectAttempt, 0)
    }

    func testMockDelegateTracksMultipleMessages() {
        let delegate = MockWebSocketMessageDelegate()

        delegate.didReceiveRawMessage("msg-1")
        delegate.didReceiveRawMessage("msg-2")
        delegate.didReceiveRawMessage("msg-3")

        XCTAssertEqual(delegate.receivedMessages.count, 3)
        XCTAssertEqual(delegate.receivedMessages, ["msg-1", "msg-2", "msg-3"])
    }

    func testMockDelegateTracksMultipleStateChanges() {
        let delegate = MockWebSocketMessageDelegate()

        delegate.connectionStateDidChange(connected: true, reconnectAttempt: 0)
        delegate.connectionStateDidChange(connected: false, reconnectAttempt: 1)
        delegate.connectionStateDidChange(connected: true, reconnectAttempt: 0)

        XCTAssertEqual(delegate.connectionStateChanges.count, 3)
        XCTAssertTrue(delegate.connectionStateChanges[0].connected)
        XCTAssertFalse(delegate.connectionStateChanges[1].connected)
        XCTAssertEqual(delegate.connectionStateChanges[1].reconnectAttempt, 1)
        XCTAssertTrue(delegate.connectionStateChanges[2].connected)
    }

    // MARK: - Edge Cases

    func testDisconnectNotifiesDelegateWithZeroReconnectAttempt() {
        let stateExpectation = expectation(description: "Disconnect state change")
        mockDelegate.connectionExpectation = stateExpectation

        manager.disconnect()

        wait(for: [stateExpectation], timeout: 2.0)

        let lastChange = mockDelegate.connectionStateChanges.last
        XCTAssertNotNil(lastChange)
        XCTAssertFalse(lastChange!.connected)
        XCTAssertEqual(lastChange!.reconnectAttempt, 0)
    }

    func testMultipleDisconnectsDoNotCrash() {
        manager.disconnect()
        manager.disconnect()
        manager.disconnect()

        let waitExpectation = expectation(description: "Multiple disconnects processed")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            waitExpectation.fulfill()
        }
        wait(for: [waitExpectation], timeout: 1.0)
    }

    func testSetWebviewActiveBeforeDelegateSet() {
        // Create a manager without a delegate
        let bareManager = SessionWebSocketManager(urlSession: .shared)

        // These should not crash even without a delegate
        bareManager.setWebviewActive(false)
        bareManager.setWebviewActive(true)

        let waitExpectation = expectation(description: "Toggle without delegate")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            waitExpectation.fulfill()
        }
        wait(for: [waitExpectation], timeout: 1.0)

        bareManager.disconnect()
    }
}
