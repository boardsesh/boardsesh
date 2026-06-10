/**
 * BLE Client Connection Implementation
 *
 * This module uses a singleton pattern with a global instance pointer for
 * ESP32/NimBLE callback compatibility. The NimBLE library requires C-style
 * callback functions for notifications, which cannot directly call member
 * functions. The static instance pointer allows the static callback wrapper
 * to forward data to the singleton instance.
 */

#include "ble_client.h"

#include <log_buffer.h>

BLEClientConnection BoardClient;
BLEClientConnection* BLEClientConnection::instance = nullptr;

BLEClientConnection::BLEClientConnection()
    : pClient(nullptr), pRxChar(nullptr), pTxChar(nullptr), state(BLEClientState::IDLE), targetAddress(),
      reconnectTime(0), connectCallback(nullptr), dataCallback(nullptr) {
    instance = this;
}

bool BLEClientConnection::connect(NimBLEAddress address) {
    if (state == BLEClientState::CONNECTED || state == BLEClientState::CONNECTING) {
        Logger.logln("BLEClient: Already connecting");
        return false;
    }

    targetAddress = address;
    state = BLEClientState::CONNECTING;

    // Log address details
    uint8_t addrType = address.getType();
    Logger.logln("BLEClient: Target addr: %s", address.toString().c_str());
    Logger.logln("BLEClient: Addr type: %d (0=pub, 1=rand)", addrType);

    // Create client if needed
    if (!pClient) {
        pClient = NimBLEDevice::createClient();
        pClient->setClientCallbacks(this, false);
        pClient->setConnectionParams(12, 12, 0, 51);
        pClient->setConnectTimeout(5);  // 5 seconds - connections should be fast
    }

    Logger.logln("BLEClient: Calling connect()...");

    // Attempt connection with explicit address type
    if (!pClient->connect(address, true)) {
        Logger.logln("BLEClient: connect() returned false");
        state = BLEClientState::DISCONNECTED;
        reconnectTime = millis() + CLIENT_RECONNECT_DELAY_MS;
        // Notify callback of connection failure so proxy can update state
        if (connectCallback) {
            connectCallback(false);
        }
        return false;
    }

    Logger.logln("BLEClient: connect() returned true");
    return true;
}

void BLEClientConnection::disconnect() {
    if (pClient && pClient->isConnected()) {
        Logger.logln("BLEClient: Disconnecting");
        pClient->disconnect();
    }
    state = BLEClientState::IDLE;
    reconnectTime = 0;
}

void BLEClientConnection::loop() {
    // Handle reconnection
    if (state == BLEClientState::DISCONNECTED || state == BLEClientState::RECONNECTING) {
        if (reconnectTime > 0 && millis() > reconnectTime) {
            Logger.logln("BLEClient: Attempting reconnection");
            state = BLEClientState::RECONNECTING;
            connect(targetAddress);
        }
    }
}

bool BLEClientConnection::isConnected() const {
    return state == BLEClientState::CONNECTED && pClient && pClient->isConnected();
}

BLEClientState BLEClientConnection::getState() const {
    return state;
}

bool BLEClientConnection::send(const uint8_t* data, size_t len) {
    if (!isConnected() || !pRxChar) {
        return false;
    }

    // Write to the RX characteristic (board receives this)
    bool success = pRxChar->writeValue(data, len, false);  // No response needed
    if (!success) {
        Logger.logln("BLEClient: Write failed");
    }
    return success;
}

String BLEClientConnection::getConnectedAddress() const {
    if (pClient && pClient->isConnected()) {
        return targetAddress.toString().c_str();
    }
    return "";
}

void BLEClientConnection::setConnectCallback(ClientConnectCallback callback) {
    connectCallback = callback;
}

void BLEClientConnection::setDataCallback(ClientDataCallback callback) {
    dataCallback = callback;
}

void BLEClientConnection::onConnect(NimBLEClient* client) {
    Logger.logln("BLEClient: Connected to board");

    // Set up the service and characteristics
    if (setupService()) {
        state = BLEClientState::CONNECTED;
        reconnectTime = 0;
        if (connectCallback) {
            connectCallback(true);
        }
    } else {
        Logger.logln("BLEClient: Failed to set up service, disconnecting");
        client->disconnect();
    }
}

void BLEClientConnection::onDisconnect(NimBLEClient* client, int reason) {
    (void)reason;

    Logger.logln("BLEClient: Disconnected from board");

    pRxChar = nullptr;
    pTxChar = nullptr;

    if (state != BLEClientState::IDLE) {
        state = BLEClientState::DISCONNECTED;
        reconnectTime = millis() + CLIENT_RECONNECT_DELAY_MS;
    }

    if (connectCallback) {
        connectCallback(false);
    }
}

bool BLEClientConnection::setupService() {
    if (!pClient)
        return false;

    // Get Nordic UART Service
    NimBLERemoteService* pService = pClient->getService(NUS_SERVICE_UUID);
    if (!pService) {
        Logger.logln("BLEClient: Nordic UART Service not found");
        return false;
    }

    // Get RX characteristic (we write to this)
    pRxChar = pService->getCharacteristic(NUS_RX_CHARACTERISTIC);
    if (!pRxChar) {
        Logger.logln("BLEClient: RX characteristic not found");
        return false;
    }

    // Get TX characteristic (we receive from this)
    pTxChar = pService->getCharacteristic(NUS_TX_CHARACTERISTIC);
    if (!pTxChar) {
        Logger.logln("BLEClient: TX characteristic not found");
        return false;
    }

    // Subscribe to TX notifications
    if (pTxChar->canNotify()) {
        if (!pTxChar->subscribe(true, notifyCallback)) {
            Logger.logln("BLEClient: Failed to subscribe to TX");
            return false;
        }
        Logger.logln("BLEClient: Subscribed to board TX notifications");
    }

    Logger.logln("BLEClient: Service setup complete");
    return true;
}

void BLEClientConnection::notifyCallback(NimBLERemoteCharacteristic* pChar, uint8_t* pData, size_t length,
                                         bool isNotify) {
    if (instance && instance->dataCallback) {
        instance->dataCallback(pData, length);
    }
}
