#ifndef BLE_CLIENT_H
#define BLE_CLIENT_H

#include <Arduino.h>
#include <NimBLEDevice.h>

// Nordic UART Service UUIDs
#define NUS_SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_RX_CHARACTERISTIC "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_TX_CHARACTERISTIC "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

// Connection timing
#define CLIENT_CONNECT_TIMEOUT_MS 5000   // 5 second timeout (connections should be fast)
#define CLIENT_RECONNECT_DELAY_MS 3000

enum class BLEClientState { IDLE, CONNECTING, CONNECTED, RECONNECTING, DISCONNECTED };

typedef void (*ClientConnectCallback)(bool connected);
typedef void (*ClientDataCallback)(const uint8_t* data, size_t len);

/**
 * BLEClientConnection connects to an Aurora board and handles Nordic UART communication.
 *
 * Features:
 * - Connects to Nordic UART Service on target board
 * - Writes to RX characteristic (sends data to board)
 * - Receives from TX characteristic via notify (receives data from board)
 * - Auto-reconnects on connection loss
 */
class BLEClientConnection : public NimBLEClientCallbacks {
  public:
    BLEClientConnection();

    /**
     * Connect to a target board by address.
     * @param address Target board's BLE address
     * @return true if connection attempt started
     */
    bool connect(NimBLEAddress address);

    /**
     * Disconnect from the current board.
     */
    void disconnect();

    /**
     * Process client state (call from loop).
     */
    void loop();

    /**
     * Check if connected to a board.
     */
    bool isConnected() const;

    /**
     * Get current connection state.
     */
    BLEClientState getState() const;

    /**
     * Send data to the connected board.
     * @param data Data bytes to send
     * @param len Length of data
     * @return true if sent successfully
     */
    bool send(const uint8_t* data, size_t len);

    /**
     * Get the address of the connected board.
     */
    String getConnectedAddress() const;

    /**
     * Set callback for connection state changes.
     */
    void setConnectCallback(ClientConnectCallback callback);

    /**
     * Set callback for received data from board.
     */
    void setDataCallback(ClientDataCallback callback);

    // NimBLE client callbacks
    void onConnect(NimBLEClient* pClient) override;
    void onDisconnect(NimBLEClient* pClient, int reason) override;

  private:
    NimBLEClient* pClient;
    NimBLERemoteCharacteristic* pRxChar;  // We write to this
    NimBLERemoteCharacteristic* pTxChar;  // We receive from this

    BLEClientState state;
    NimBLEAddress targetAddress;
    unsigned long reconnectTime;

    ClientConnectCallback connectCallback;
    ClientDataCallback dataCallback;

    bool setupService();
    static void notifyCallback(NimBLERemoteCharacteristic* pChar, uint8_t* pData, size_t length, bool isNotify);
    static BLEClientConnection* instance;
};

extern BLEClientConnection BoardClient;

#endif
