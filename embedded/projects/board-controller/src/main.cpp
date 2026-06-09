#include <Arduino.h>

// Shared libraries
#include <esp_web_server.h>
#include <wifi_utils.h>

#include <aurora_protocol.h>
#include <config_manager.h>
#include <graphql_ws_client.h>
#include <led_controller.h>
#include <log_buffer.h>
#include <nordic_uart_ble.h>

// Conditional libraries for display and proxy modes
#ifdef ENABLE_BLE_PROXY
#include <ble_proxy.h>

#include <climb_history.h>
#endif

// Display support - include the right display driver
#ifdef ENABLE_WAVESHARE_DISPLAY
#include <waveshare_display.h>
#ifdef ENABLE_BOARD_IMAGE
#include <board_hold_data.h>
#endif
#elif defined(ENABLE_WAVESHARE_AMOLED_DISPLAY)
#include <waveshare_amoled_display.h>
#elif defined(ENABLE_DISPLAY)
#include <lilygo_display.h>
#endif

#ifdef ENABLE_REMOTE_THUMBNAIL
#include <thumbnail_client.h>

#include <utility>
#endif

// Unified macro for code that works with any display
#if defined(ENABLE_WAVESHARE_DISPLAY) || defined(ENABLE_WAVESHARE_AMOLED_DISPLAY) || defined(ENABLE_DISPLAY)
#define HAS_DISPLAY 1
#endif

// Project-specific config
#include "config/board_config.h"
#include "config/led_placement_map.h"

// State
bool wifiConnected = false;
bool backendConnected = false;
bool bleInitialized = false;

#ifdef HAS_DISPLAY
// Navigation mutation debounce - wait for rapid presses to stop before sending mutation
const unsigned long G_MUTATION_DEBOUNCE_MS = 100;  // Wait 100ms after last press before sending mutation
unsigned long g_pendingMutationTime = 0;           // When to send the debounced mutation (0 = none pending)
bool g_mutationPending = false;                    // Flag indicating a mutation is waiting to be sent
char g_pendingMutationUuid[64] = "";               // UUID of the queue item to navigate to
#endif

#ifdef HAS_DISPLAY
// Queue/climb state for display
String currentQueueItemUuid = "";
String currentGradeColor = "";
String currentClimbUuid = "";
String currentClimbName = "";
String currentGrade = "";
String boardType = "kilter";
bool hasCurrentClimb = false;

// Static buffer for queue sync to avoid heap fragmentation
// LocalQueueItem is ~88 bytes each, so 150 items = ~13KB
static LocalQueueItem g_queueSyncBuffer[MAX_QUEUE_SIZE];

#if defined(ENABLE_WAVESHARE_AMOLED_DISPLAY) && defined(ENABLE_REMOTE_THUMBNAIL)
static ThumbnailClient g_thumbnailClient;
static String currentThumbnailCacheKey = "";
#endif

#if defined(ENABLE_WAVESHARE_DISPLAY) && defined(ENABLE_BOARD_IMAGE)
// Board image config lookup state
const BoardConfig* currentBoardConfig = nullptr;
String currentBoardConfigKey = "";

/**
 * Extract config key from boardPath, stripping the angle segment.
 * "kilter/1/7/1,20/40" -> "kilter/1/7/1,20"
 * Also sorts set_ids numerically for consistent matching.
 */
String extractConfigKey(const char* boardPath) {
    if (!boardPath) return "";

    String bp = boardPath;
    // Find segments: board_name/layout_id/size_id/set_ids/angle
    int slash1 = bp.indexOf('/');
    if (slash1 < 0) return "";
    int slash2 = bp.indexOf('/', slash1 + 1);
    if (slash2 < 0) return "";
    int slash3 = bp.indexOf('/', slash2 + 1);
    if (slash3 < 0) return "";
    int slash4 = bp.indexOf('/', slash3 + 1);

    // Extract set_ids part and sort numerically
    String setIdsPart;
    if (slash4 > 0) {
        setIdsPart = bp.substring(slash3 + 1, slash4);
    } else {
        setIdsPart = bp.substring(slash3 + 1);
    }

    // Parse and sort set IDs (max 8 sets per board config in practice)
    static const int MAX_SET_IDS = 16;
    int setIds[MAX_SET_IDS];
    int setCount = 0;
    int start = 0;
    for (int i = 0; i <= (int)setIdsPart.length(); i++) {
        if (i == (int)setIdsPart.length() || setIdsPart[i] == ',') {
            if (i > start && setCount < MAX_SET_IDS) {
                setIds[setCount++] = setIdsPart.substring(start, i).toInt();
            }
            start = i + 1;
        }
    }
    if (setCount == 0) return "";

    // Simple insertion sort
    for (int i = 1; i < setCount; i++) {
        int key = setIds[i];
        int j = i - 1;
        while (j >= 0 && setIds[j] > key) {
            setIds[j + 1] = setIds[j];
            j--;
        }
        setIds[j + 1] = key;
    }

    // Rebuild sorted set_ids string
    String sortedSetIds;
    for (int i = 0; i < setCount; i++) {
        if (i > 0) sortedSetIds += ",";
        sortedSetIds += String(setIds[i]);
    }

    // Build config key: board_name/layout_id/size_id/sorted_set_ids
    return bp.substring(0, slash3 + 1) + sortedSetIds;
}
#endif

/**
 * Convert hex color string to RGB565 without String allocations
 * @param hex Color string in format "#RRGGBB"
 * @return RGB565 color value, or 0xFFFF (white) if invalid
 */
static uint16_t hexToRgb565Fast(const char* hex) {
    if (!hex || hex[0] != '#' || strlen(hex) < 7) {
        return 0xFFFF;  // White default
    }

    // Parse hex digits directly without String objects
    char buf[3] = {0, 0, 0};

    buf[0] = hex[1]; buf[1] = hex[2];
    uint8_t r = strtol(buf, NULL, 16);

    buf[0] = hex[3]; buf[1] = hex[4];
    uint8_t g = strtol(buf, NULL, 16);

    buf[0] = hex[5]; buf[1] = hex[6];
    uint8_t b = strtol(buf, NULL, 16);

    // Convert to RGB565: 5 bits red, 6 bits green, 5 bits blue
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

#if defined(ENABLE_WAVESHARE_AMOLED_DISPLAY) && defined(ENABLE_REMOTE_THUMBNAIL)
// Returns true when this function has left the display in the intended state:
// fetched thumbnail, preserved duplicate thumbnail, or restored text-only UI
// after fetch failure. Returns false only when the caller should render fallback UI.
bool fetchAndDisplayRemoteThumbnail(const char* boardPath,
                                    const char* frames,
                                    const char* climbName,
                                    const char* climbGrade,
                                    const char* gradeColor,
                                    int angle,
                                    const char* climbUuid,
                                    const char* boardTypeName) {
    String renderBaseUrl = Config.getString(THUMBNAIL_RENDER_BASE_KEY, DEFAULT_RENDER_BASE_URL);
    RemoteThumbnailDisplayRequest request = {
        renderBaseUrl.c_str(),
        boardPath,
        frames,
        climbName,
        climbGrade,
        gradeColor,
        angle,
        climbUuid,
        boardTypeName,
    };
    RemoteThumbnailDisplayHooks hooks = {
        nullptr,
        [](void*) { Display.clearThumbnail(); },
        [](void*,
           const char* requestClimbName,
           const char* requestClimbGrade,
           const char* requestGradeColor,
           int requestAngle,
           const char* requestClimbUuid,
           const char* requestBoardTypeName) {
            Display.showClimb(requestClimbName,
                              requestClimbGrade,
                              requestGradeColor,
                              requestAngle,
                              requestClimbUuid,
                              requestBoardTypeName);
        },
        [](void*) { Display.showThumbnailLoading(); },
        [](void*, std::vector<uint8_t>&& data, const char* cacheKey) {
            Display.setThumbnailJpeg(std::move(data), cacheKey);
        },
        [](void*, const char* url, std::vector<uint8_t>& output) {
            return g_thumbnailClient.fetchJpeg(url, output);
        },
    };

    RemoteThumbnailDisplayResult result = handleRemoteThumbnailDisplay(request, hooks, currentThumbnailCacheKey);
    return result != RemoteThumbnailDisplayResult::FALLBACK_REQUIRED;
}
#endif
#endif

// Forward declarations
void onWiFiStateChange(WiFiConnectionState state);
void onBLEConnect(bool connected);
void onBLEData(const uint8_t* data, size_t len);
void onBLELedData(const LedCommand* commands, int count, int angle);
void onGraphQLStateChange(GraphQLConnectionState state);
void onGraphQLMessage(JsonDocument& doc);
void initializeBLE();
#ifdef HAS_DISPLAY
void handleLedUpdateExtended(JsonObject& data);
void onQueueSync(const ControllerQueueSyncData& data);
void navigatePrevious();
void navigateNext();
void navigateToIndex(int index);
void sendNavigationMutation(const char* queueItemUuid);
#endif
void startupAnimation();
#ifdef ENABLE_WAVESHARE_DISPLAY
void updateSettingsDisplay(bool proxyEnabled);
#endif

#ifdef ENABLE_BLE_PROXY
void onBLERawForward(const uint8_t* data, size_t len);
void onProxyStateChange(BLEProxyState state);
void onWebSocketLedUpdate(const LedCommand* commands, int count);

// Function to send data to app via BLE (used by proxy)
void sendToAppViaBLE(const uint8_t* data, size_t len) {
    BLE.send(data, len);
}
#endif

/**
 * Initialize BLE - called after WiFi is configured
 * This is deferred until WiFi is set up so we don't waste resources
 * scanning for boards when we can't connect to the backend anyway
 */
void initializeBLE() {
    if (bleInitialized) {
        return;  // Already initialized
    }

    Logger.logln("Initializing BLE as '%s'...", BLE_DEVICE_NAME);
    BLE.begin(BLE_DEVICE_NAME, true);
    BLE.setConnectCallback(onBLEConnect);
    BLE.setDataCallback(onBLEData);
    BLE.setLedDataCallback(onBLELedData);

#ifdef ENABLE_BLE_PROXY
    // Set up raw data forwarding for proxy mode
    BLE.setRawForwardCallback(onBLERawForward);

    // Initialize proxy
    String targetMac = Config.getString("proxy_mac");
    Proxy.begin(targetMac);
    Proxy.setStateCallback(onProxyStateChange);
    Proxy.setSendToAppCallback(sendToAppViaBLE);
#endif

#ifdef HAS_DISPLAY
    Display.setBleStatus(true, false);  // BLE enabled, not connected
#endif

    bleInitialized = true;
    Logger.logln("BLE initialization complete");
}

void setup() {
    Serial.begin(115200);
    delay(3000);  // Longer delay to ensure serial monitor catches boot messages

    Logger.logln("=================================");
    Logger.logln("%s v%s", DEVICE_NAME, FIRMWARE_VERSION);
    Logger.logln("LED_PIN = %d", LED_PIN);
#ifdef ENABLE_BLE_PROXY
    Logger.logln("BLE Proxy: Enabled");
#endif
#ifdef HAS_DISPLAY
    Logger.logln("Display: Enabled");
#endif
#ifdef ENABLE_REMOTE_THUMBNAIL
    Logger.logln("Remote thumbnails: Enabled");
#endif
    Logger.logln("=================================");

    // Initialize config manager
    Config.begin();

#ifdef HAS_DISPLAY
    // Initialize display first (before LEDs for visual feedback)
    Logger.logln("Initializing display...");
    if (!Display.begin()) {
        Logger.logln("ERROR: Display initialization failed!");
    } else {
        Logger.logln("Display.begin() returned true");
    }
    Logger.logln("Setting WiFi status...");
    Display.setWiFiStatus(false);
    Logger.logln("Setting BLE status...");
    Display.setBleStatus(false, false);
    Logger.logln("Showing connecting screen...");
    Display.showConnecting();
    Logger.logln("Display initialization complete");
#else
    Logger.logln("Display is NOT enabled");
#endif

    // Initialize LEDs
    Logger.logln("Initializing LEDs on pin %d...", LED_PIN);
    LEDs.begin(LED_PIN, NUM_LEDS);
    LEDs.setBrightness(Config.getInt("brightness", DEFAULT_BRIGHTNESS));

    // Startup animation (brief to confirm LEDs working)
    startupAnimation();

    // Initialize WiFi
    Logger.logln("Initializing WiFi...");
    WiFiMgr.begin();
    WiFiMgr.setStateCallback(onWiFiStateChange);

#ifdef HAS_DISPLAY
    Display.setWiFiStatus(false);
#endif

    // Try to connect to saved WiFi
    if (!WiFiMgr.connectSaved()) {
        Logger.logln("No saved WiFi credentials - starting AP mode");
#ifdef HAS_DISPLAY
        // Start AP mode for WiFi configuration
        if (WiFiMgr.startAP()) {
            Logger.logln("AP mode started: %s", DEFAULT_AP_NAME);
            Display.showSetupScreen(DEFAULT_AP_NAME);
        } else {
            Logger.logln("Failed to start AP mode");
            Display.showError("AP Failed");
        }
#else
        // Without display, just start AP mode silently
        WiFiMgr.startAP();
#endif
        // Don't initialize BLE yet - wait for WiFi to be configured
    } else {
        // We have saved WiFi credentials, initialize BLE now
        initializeBLE();
    }

    // Initialize button pins for LilyGo navigation (Waveshare uses touch instead)
#if defined(ENABLE_DISPLAY) && !defined(ENABLE_WAVESHARE_DISPLAY)
    pinMode(BUTTON_1_PIN, INPUT_PULLUP);
    pinMode(BUTTON_2_PIN, INPUT_PULLUP);
#endif

    // Initialize web config server
    Logger.logln("Starting web server...");
    WebConfig.begin();

    Logger.logln("Setup complete!");
    if (WiFiMgr.isAPMode()) {
        Logger.logln("AP IP: %s", WiFiMgr.getAPIP().c_str());
    } else {
        Logger.logln("IP: %s", WiFiMgr.getIP().c_str());
    }

    // Green blink to indicate ready
    LEDs.blink(0, 255, 0, 3, 100);

    // Don't refresh display if in AP mode - keep showing setup screen
#ifdef HAS_DISPLAY
    if (!WiFiMgr.isAPMode()) {
        Display.refresh();
    }
#endif
}

#ifdef ENABLE_WAVESHARE_DISPLAY
/**
 * Update the settings display with current WiFi/proxy state.
 * Centralizes the IP retrieval logic to avoid duplication.
 */
void updateSettingsDisplay(bool proxyEnabled) {
    const char* ssid = WiFiMgr.isConnected() ? WiFiMgr.getSSID().c_str() : "";
    const char* ip = WiFiMgr.isConnected() ? WiFiMgr.getIP().c_str()
                     : WiFiMgr.isAPMode()   ? WiFiMgr.getAPIP().c_str()
                                             : "";
    Display.setSettingsData(ssid, ip, proxyEnabled);
}
#endif

void loop() {
    // Process WiFi
    WiFiMgr.loop();

    // Process BLE (only if initialized - deferred until WiFi configured)
    if (bleInitialized) {
        BLE.loop();

#ifdef ENABLE_BLE_PROXY
        // Process BLE proxy
        Proxy.loop();
#endif
    }

    // Process WebSocket if WiFi connected
    if (wifiConnected) {
        GraphQL.loop();
    }

    // Process web server
    WebConfig.loop();

#ifdef HAS_DISPLAY
    // Process debounced navigation mutation (shared across all display types)
    if (g_mutationPending && millis() >= g_pendingMutationTime) {
        // If a mutation is already in flight, extend the debounce timer
        if (GraphQL.isMutationInFlight()) {
            g_pendingMutationTime = millis() + G_MUTATION_DEBOUNCE_MS;
            // Don't clear g_mutationPending - wait for current mutation to complete
        } else {
            g_mutationPending = false;
            if (g_pendingMutationUuid[0] != '\0' && backendConnected) {
                Logger.logln("Navigation: Sending debounced mutation (uuid: %s)", g_pendingMutationUuid);
                sendNavigationMutation(g_pendingMutationUuid);
            }
            g_pendingMutationUuid[0] = '\0';  // Clear after sending
        }
    }
#endif

#ifdef ENABLE_WAVESHARE_DISPLAY
    // Handle touch input for Waveshare display
    TouchEvent touchEvent = Display.pollTouch();
    switch (touchEvent.action) {
        case TouchAction::NAVIGATE_PREVIOUS:
            Logger.logln("Touch: navigate previous");
            navigatePrevious();
            break;
        case TouchAction::NAVIGATE_NEXT:
            Logger.logln("Touch: navigate next");
            navigateNext();
            break;
        case TouchAction::OPEN_SETTINGS:
            Logger.logln("Touch: open settings");
            updateSettingsDisplay(Config.getBool("proxy_en", false));
            Display.showSettingsScreen();
            break;
        case TouchAction::SETTINGS_BACK:
            Logger.logln("Touch: settings back");
            Display.hideSettingsScreen();
            break;
        case TouchAction::SETTINGS_RESET_WIFI: {
            Logger.logln("Touch: reset WiFi");
            bool wifiResetOk = Config.setString("wifi_ssid", "")
                            && Config.setString("wifi_pass", "");
            if (!wifiResetOk) {
                Logger.logln("WARNING: Failed to persist WiFi reset");
            }
            WiFiMgr.disconnect();
            Display.hideSettingsScreen();
            if (WiFiMgr.startAP()) {
                Display.showSetupScreen(DEFAULT_AP_NAME);
            }
            break;
        }
        case TouchAction::SETTINGS_TOGGLE_PROXY: {
            Logger.logln("Touch: toggle BLE proxy");
            bool newProxyState = !Config.getBool("proxy_en", false);
            if (!Config.setBool("proxy_en", newProxyState)) {
                Logger.logln("WARNING: Failed to persist proxy toggle");
            }
#ifdef ENABLE_BLE_PROXY
            Proxy.setEnabled(newProxyState);
#endif
            updateSettingsDisplay(newProxyState);
            Display.showSettingsScreen();
            break;
        }
        case TouchAction::SETTINGS_TOGGLE_DISPLAY_MODE: {
            Logger.logln("Touch: toggle display mode");
            int currentMode = Config.getInt("disp_mode", 0);
            int newMode = (currentMode == 0) ? 1 : 0;
            Config.setInt("disp_mode", newMode);
            // Clear settings state and show restarting message
            Display.hideSettingsScreen();
            Display.getDisplay().fillScreen(COLOR_BACKGROUND);
            Display.getDisplay().setFont(&fonts::FreeSansBold18pt7b);
            Display.getDisplay().setTextColor(COLOR_TEXT);
            Display.getDisplay().setTextDatum(lgfx::middle_center);
            Display.getDisplay().drawString("Restarting...",
                Display.screenWidth() / 2, Display.screenHeight() / 2);
            Display.getDisplay().setTextDatum(lgfx::top_left);
            delay(1000);
            esp_restart();
            break;
        }
        case TouchAction::NAVIGATE_TO_INDEX:
            Logger.logln("Touch: navigate to index %d", touchEvent.targetIndex);
            navigateToIndex(touchEvent.targetIndex);
            break;
        case TouchAction::NONE:
        default:
            break;
    }
#elif defined(ENABLE_DISPLAY)
    // Handle button presses with debouncing (LilyGo T-Display-S3)
    static bool lastButton1 = HIGH;
    static bool lastButton2 = HIGH;
    static unsigned long button1PressTime = 0;
    static unsigned long button2PressTime = 0;
    static bool button1LongPressTriggered = false;
    static const unsigned long DEBOUNCE_MS = 50;
    static const unsigned long LONG_PRESS_MS = 3000;
    static const unsigned long SHORT_PRESS_MAX_MS = 500;

    bool button1 = digitalRead(BUTTON_1_PIN);
    bool button2 = digitalRead(BUTTON_2_PIN);
    unsigned long now = millis();

    // Button 1: Short press = previous, Long press (3s) = reset config
    if (button1 == LOW && lastButton1 == HIGH) {
        // Button just pressed
        button1PressTime = now;
        button1LongPressTriggered = false;
    } else if (button1 == LOW && button1PressTime > 0) {
        // Button held down - check for long press
        if (!button1LongPressTriggered && now - button1PressTime > LONG_PRESS_MS) {
            Logger.logln("Button 1 long press - resetting configuration...");
            Display.showError("Resetting...");
            button1LongPressTriggered = true;

            bool resetOk = Config.setString("wifi_ssid", "")
                        && Config.setString("wifi_pass", "")
                        && Config.setString("api_key", "")
                        && Config.setString("session_id", "");
            if (!resetOk) {
                Logger.logln("WARNING: Failed to persist config reset");
            }

            delay(1000);
            ESP.restart();
        }
    } else if (button1 == HIGH && lastButton1 == LOW) {
        // Button just released - check for short press (navigate previous)
        if (!button1LongPressTriggered && button1PressTime > 0) {
            unsigned long pressDuration = now - button1PressTime;
            if (pressDuration > DEBOUNCE_MS && pressDuration < SHORT_PRESS_MAX_MS) {
                Logger.logln("Button 1 short press - navigate previous");
                navigatePrevious();
            }
        }
        button1PressTime = 0;
    }
    lastButton1 = button1;

    // Button 2: Short press = next
    if (button2 == LOW && lastButton2 == HIGH) {
        // Button just pressed
        button2PressTime = now;
    } else if (button2 == HIGH && lastButton2 == LOW) {
        // Button just released - check for short press (navigate next)
        if (button2PressTime > 0) {
            unsigned long pressDuration = now - button2PressTime;
            if (pressDuration > DEBOUNCE_MS && pressDuration < SHORT_PRESS_MAX_MS) {
                Logger.logln("Button 2 short press - navigate next");
                navigateNext();
            }
        }
        button2PressTime = 0;
    }
    lastButton2 = button2;
#endif
}

void onWiFiStateChange(WiFiConnectionState state) {
    switch (state) {
        case WiFiConnectionState::CONNECTED: {
            Logger.logln("WiFi connected: %s", WiFiMgr.getIP().c_str());
            wifiConnected = true;

#ifdef HAS_DISPLAY
            Display.setWiFiStatus(true);
            // Show normal UI now that we're connected
            Display.showNoClimb();
#endif

            // Initialize BLE now that WiFi is connected (if not already done)
            initializeBLE();

            // Get backend config
            String host = Config.getString("backend_host", DEFAULT_BACKEND_HOST);
            int port = Config.getInt("backend_port", DEFAULT_BACKEND_PORT);
            String path = Config.getString("backend_path", DEFAULT_BACKEND_PATH);
            String apiKey = Config.getString("api_key");

            if (apiKey.length() == 0) {
                Logger.logln("No API key configured - skipping backend connection");
                break;
            }

            // Note: Device MAC address is automatically used for clientId comparison
            // (set during connection_init in graphql_ws_client.cpp)

            Logger.logln("Connecting to backend: %s:%d%s", host.c_str(), port, path.c_str());
            GraphQL.setStateCallback(onGraphQLStateChange);
            GraphQL.setMessageCallback(onGraphQLMessage);
#ifdef ENABLE_BLE_PROXY
            // Set up LED update callback for proxy forwarding
            GraphQL.setLedUpdateCallback(onWebSocketLedUpdate);
#endif
            GraphQL.begin(host.c_str(), port, path.c_str(), apiKey.c_str());
            break;
        }

        case WiFiConnectionState::DISCONNECTED:
            Logger.logln("WiFi disconnected");
            wifiConnected = false;
            backendConnected = false;
#ifdef HAS_DISPLAY
            Display.setWiFiStatus(false);
#endif
            break;

        case WiFiConnectionState::CONNECTING:
            Logger.logln("WiFi connecting...");
#ifdef HAS_DISPLAY
            Display.setWiFiStatus(false);
#endif
            break;

        case WiFiConnectionState::CONNECTION_FAILED:
            Logger.logln("WiFi connection failed");
#ifdef HAS_DISPLAY
            Display.setWiFiStatus(false);
#endif
            // If connection failed and we don't have saved credentials, start AP mode
            if (!WiFiMgr.hasSavedCredentials()) {
                Logger.logln("No saved credentials - starting AP mode for configuration");
                if (WiFiMgr.startAP()) {
#ifdef HAS_DISPLAY
                    Display.showSetupScreen(DEFAULT_AP_NAME);
#endif
                }
            }
            break;

        case WiFiConnectionState::AP_MODE:
            Logger.logln("WiFi in AP mode: %s", WiFiMgr.getAPIP().c_str());
#ifdef HAS_DISPLAY
            Display.setWiFiStatus(false);
#endif
            break;
    }
}

void onBLEConnect(bool connected) {
    if (connected) {
        Logger.logln("BLE client connected");
#ifdef HAS_DISPLAY
        Display.setBleStatus(true, true);
#endif
    } else {
        Logger.logln("BLE client disconnected");
#ifdef HAS_DISPLAY
        Display.setBleStatus(true, false);
#endif
    }
}

void onBLEData(const uint8_t* data, size_t len) {
    // Raw BLE data callback - Aurora parsing is handled by nordic_uart_ble library
}

#ifdef ENABLE_BLE_PROXY
void onBLERawForward(const uint8_t* data, size_t len) {
    // Forward raw BLE data to the actual board via proxy
    if (Proxy.isConnectedToBoard()) {
        Proxy.forwardToBoard(data, len);
    }
}

void onProxyStateChange(BLEProxyState state) {
#ifdef HAS_DISPLAY
    switch (state) {
        case BLEProxyState::CONNECTED:
            Display.setBleStatus(true, true);  // BLE enabled, proxy connected
            break;
        case BLEProxyState::SCANNING:
        case BLEProxyState::CONNECTING:
        case BLEProxyState::RECONNECTING:
            Display.setBleStatus(true, false);  // BLE enabled, not connected
            break;
        default:
            break;
    }
#endif
}

/**
 * Callback for LED updates received via WebSocket
 * Encodes LED commands into Aurora protocol and forwards to the real board
 */
void onWebSocketLedUpdate(const LedCommand* commands, int count) {
    if (!Proxy.isConnectedToBoard()) {
        Logger.logln("Proxy: Cannot forward LED update - not connected to board");
        return;
    }

    Logger.logln("Proxy: Forwarding %d LEDs to board via BLE", count);

    // Encode LED commands into Aurora protocol packets
    std::vector<std::vector<uint8_t>> packets;
    AuroraProtocol::encodeLedCommands(commands, count, packets);

    // BLE max write size is 20 bytes (matches TypeScript MAX_BLUETOOTH_MESSAGE_SIZE)
    const size_t MAX_BLE_CHUNK_SIZE = 20;
    int totalChunks = 0;

    // Send each protocol packet, split into 20-byte BLE chunks
    for (const auto& packet : packets) {
        // Split packet into 20-byte chunks
        for (size_t offset = 0; offset < packet.size(); offset += MAX_BLE_CHUNK_SIZE) {
            size_t chunkSize = min(MAX_BLE_CHUNK_SIZE, packet.size() - offset);
            Proxy.forwardToBoard(packet.data() + offset, chunkSize);
            totalChunks++;

            // Small delay between chunks to avoid overwhelming the BLE connection
            delay(10);
        }
    }

    Logger.logln("Proxy: Sent %d chunks (%zu protocol packets) to board", totalChunks, packets.size());
}
#endif

/**
 * Callback when LED data is received via Bluetooth from official app
 * Forward the climb to the BoardSesh session so it can be matched
 */
void onBLELedData(const LedCommand* commands, int count, int angle) {
    Logger.logln("Main: Bluetooth LED data received: %d LEDs, angle: %d", count, angle);

    // Forward to backend via WebSocket to match climb
    if (GraphQL.isSubscribed()) {
        GraphQL.sendLedPositions(commands, count, angle);
    } else {
        Logger.logln("Main: Cannot forward LED data - not subscribed to backend");
    }
}

void onGraphQLStateChange(GraphQLConnectionState state) {
    switch (state) {
        case GraphQLConnectionState::CONNECTION_ACK: {
            Logger.logln("Backend connected!");
            backendConnected = true;

            // Get session ID for subscription (API key is passed via connectionParams)
            String sessionId = Config.getString("session_id");

            if (sessionId.length() == 0) {
                Logger.logln("No session ID configured - skipping subscription");
                break;
            }

#ifdef HAS_DISPLAY
            // Pass session ID to display for QR code generation
            Display.setSessionId(sessionId.c_str());
#endif

            // Build variables JSON (apiKey is in connectionParams, not here)
            String variables = "{\"sessionId\":\"" + sessionId + "\"}";

            // Subscribe to controller events (full subscription with navigation and queue sync)
            // clientId is included so ESP32 can decide whether to disconnect BLE client
            GraphQL.subscribe("controller-events",
                              "subscription ControllerEvents($sessionId: ID!) { "
                              "controllerEvents(sessionId: $sessionId) { "
                              "... on LedUpdate { __typename commands { position r g b } queueItemUuid climbUuid climbName "
                              "climbGrade gradeColor boardPath angle "
#ifdef ENABLE_REMOTE_THUMBNAIL
                              "frames "
#endif
                              "clientId "
                              "navigation { previousClimbs { name grade gradeColor } "
                              "nextClimb { name grade gradeColor } currentIndex totalCount } } "
                              "... on ControllerQueueSync { __typename queue { uuid climbUuid name grade gradeColor } currentIndex } "
                              "... on ControllerPing { __typename timestamp } "
                              "} }",
                              variables.c_str());

#ifdef HAS_DISPLAY
            // Set queue sync callback for display builds
            GraphQL.setQueueSyncCallback(onQueueSync);
            hasCurrentClimb = false;
            Display.showNoClimb();
#endif
            break;
        }

        case GraphQLConnectionState::DISCONNECTED:
            Logger.logln("Backend disconnected");
            backendConnected = false;
            break;

        default:
            break;
    }
}

void onGraphQLMessage(JsonDocument& doc) {
#ifdef HAS_DISPLAY
    // Handle extended LedUpdate data (for display)
    JsonObject payloadObj = doc["payload"];
    if (payloadObj["data"].is<JsonObject>()) {
        JsonObject data = payloadObj["data"];
        if (data["controllerEvents"].is<JsonObject>()) {
            JsonObject event = data["controllerEvents"];
            const char* typename_ = event["__typename"];

            if (typename_ && strcmp(typename_, "LedUpdate") == 0) {
                handleLedUpdateExtended(event);
            }
        }
    }
#else
    (void)doc;  // Suppress unused parameter warning
#endif
}

#ifdef HAS_DISPLAY
/**
 * Handle queue sync event from backend
 * Uses static buffer to avoid heap fragmentation from repeated allocations
 */
void onQueueSync(const ControllerQueueSyncData& data) {
    Logger.logln("Queue sync: %d items, currentIndex: %d", data.count, data.currentIndex);

    // Use static buffer to avoid heap fragmentation
    int itemCount = min(data.count, MAX_QUEUE_SIZE);

    for (int i = 0; i < itemCount; i++) {
        strncpy(g_queueSyncBuffer[i].uuid, data.items[i].uuid, sizeof(g_queueSyncBuffer[i].uuid) - 1);
        g_queueSyncBuffer[i].uuid[sizeof(g_queueSyncBuffer[i].uuid) - 1] = '\0';

        strncpy(g_queueSyncBuffer[i].climbUuid, data.items[i].climbUuid, sizeof(g_queueSyncBuffer[i].climbUuid) - 1);
        g_queueSyncBuffer[i].climbUuid[sizeof(g_queueSyncBuffer[i].climbUuid) - 1] = '\0';

        strncpy(g_queueSyncBuffer[i].name, data.items[i].name, sizeof(g_queueSyncBuffer[i].name) - 1);
        g_queueSyncBuffer[i].name[sizeof(g_queueSyncBuffer[i].name) - 1] = '\0';

        strncpy(g_queueSyncBuffer[i].grade, data.items[i].grade, sizeof(g_queueSyncBuffer[i].grade) - 1);
        g_queueSyncBuffer[i].grade[sizeof(g_queueSyncBuffer[i].grade) - 1] = '\0';

        // Convert hex color to RGB565 using fast helper (no String allocations)
        g_queueSyncBuffer[i].gradeColorRgb = hexToRgb565Fast(data.items[i].gradeColor);
    }

    // Update display queue state (no delete needed - using static buffer)
    Display.setQueueFromSync(g_queueSyncBuffer, itemCount, data.currentIndex);

    Logger.logln("Queue sync complete: stored %d items, index %d", Display.getQueueCount(),
                 Display.getCurrentQueueIndex());
}

/**
 * Handle extended LedUpdate data for display
 * This is called in addition to GraphQL.handleLedUpdate (which handles LED control)
 */
void handleLedUpdateExtended(JsonObject& data) {
    const char* queueItemUuid = data["queueItemUuid"];
    const char* climbUuid = data["climbUuid"];
    const char* climbName = data["climbName"];
    const char* climbGrade = data["climbGrade"];
    const char* gradeColor = data["gradeColor"];
    const char* boardPath = data["boardPath"];
    const char* frames = data["frames"];
    int angle = data["angle"] | 0;

    JsonArray commands = data["commands"];
    int count = commands.isNull() ? 0 : commands.size();

    Logger.logln("LED Update: %s [%s] @ %d degrees (%d holds), queueItemUuid: %s", climbName ? climbName : "(none)",
                 climbGrade ? climbGrade : "?", angle, count, queueItemUuid ? queueItemUuid : "(none)");

    // Check if this confirms a pending navigation
    if (Display.hasPendingNavigation() && queueItemUuid) {
        const char* pendingUuid = Display.getPendingQueueItemUuid();
        if (pendingUuid && strcmp(queueItemUuid, pendingUuid) == 0) {
            Logger.logln("LED Update confirms pending navigation to %s", queueItemUuid);
            Display.clearPendingNavigation();
        } else {
            Logger.logln("LED Update conflicts with pending navigation (expected %s, got %s)", pendingUuid,
                         queueItemUuid);
            Display.clearPendingNavigation();
        }
    }

    // Handle clear/unknown climb command
    if (commands.isNull() || count == 0) {
        // Check if this is an "Unknown Climb" scenario (BLE loaded a climb not in database)
        if (climbName && strcmp(climbName, "Unknown Climb") == 0) {
            Logger.logln("LED Update: Unknown climb from BLE - displaying with navigation context");

            // Update state for unknown climb
            hasCurrentClimb = true;
            currentQueueItemUuid = "";
            currentClimbUuid = "";
            currentClimbName = climbName;
            currentGrade = climbGrade ? climbGrade : "?";
            currentGradeColor = gradeColor ? gradeColor : "#888888";

            if (boardPath) {
                String bp = boardPath;
                int slashPos = bp.indexOf('/');
                if (slashPos > 0) {
                    boardType = bp.substring(0, slashPos);
                }
            }

            // Parse navigation context if present (allows navigating back to known climbs)
            if (data["navigation"].is<JsonObject>()) {
                JsonObject nav = data["navigation"];
                int currentIndex = nav["currentIndex"] | -1;
                int totalCount = nav["totalCount"] | 0;

                // Parse previous climb (first in previousClimbs array = immediate previous)
                QueueNavigationItem prevClimb;
                if (nav["previousClimbs"].is<JsonArray>()) {
                    JsonArray prevArray = nav["previousClimbs"];
                    if (prevArray.size() > 0) {
                        JsonObject prev = prevArray[0];
                        prevClimb = QueueNavigationItem(prev["name"] | "", prev["grade"] | "", prev["gradeColor"] | "");
                    }
                }

                // Parse next climb
                QueueNavigationItem nextClimb;
                if (nav["nextClimb"].is<JsonObject>()) {
                    JsonObject next = nav["nextClimb"];
                    nextClimb = QueueNavigationItem(next["name"] | "", next["grade"] | "", next["gradeColor"] | "");
                }

                Display.setNavigationContext(prevClimb, nextClimb, currentIndex, totalCount);
            } else {
                Display.clearNavigationContext();
            }

#if defined(ENABLE_WAVESHARE_AMOLED_DISPLAY) && defined(ENABLE_REMOTE_THUMBNAIL)
            if (fetchAndDisplayRemoteThumbnail(boardPath,
                                               frames,
                                               climbName,
                                               currentGrade.c_str(),
                                               currentGradeColor.c_str(),
                                               angle,
                                               "",
                                               boardType.c_str())) {
                return;
            }
#endif

            // Show unknown climb on display
            Display.showClimb(climbName, currentGrade.c_str(), currentGradeColor.c_str(), angle, "", boardType.c_str());
            return;
        }

        // Normal clear - no climb selected
        if (hasCurrentClimb && currentClimbName.length() > 0) {
            Display.addToHistory(currentClimbName.c_str(), currentGrade.c_str(), currentGradeColor.c_str());
        }

        hasCurrentClimb = false;
        currentQueueItemUuid = "";
        currentClimbUuid = "";
        currentClimbName = "";
        currentGrade = "";
        currentGradeColor = "";
#if defined(ENABLE_WAVESHARE_AMOLED_DISPLAY) && defined(ENABLE_REMOTE_THUMBNAIL)
        currentThumbnailCacheKey = "";
        Display.clearThumbnail();
#endif

        Display.showNoClimb();
        return;
    }

    // Add previous climb to history if different
    if (hasCurrentClimb && currentClimbUuid.length() > 0 && climbUuid && String(climbUuid) != currentClimbUuid) {
        Display.addToHistory(currentClimbName.c_str(), currentGrade.c_str(), currentGradeColor.c_str());
    }

    // Extract board type from boardPath (e.g., "kilter/1/12/1,2,3/40" -> "kilter")
    if (boardPath) {
        String bp = boardPath;
        int slashPos = bp.indexOf('/');
        if (slashPos > 0) {
            boardType = bp.substring(0, slashPos);
        }
    }

#if defined(ENABLE_WAVESHARE_DISPLAY) && defined(ENABLE_BOARD_IMAGE)
    // Look up board image config from boardPath
    if (boardPath) {
        String configKey = extractConfigKey(boardPath);
        if (configKey.length() > 0 && configKey != currentBoardConfigKey) {
            currentBoardConfigKey = configKey;
            currentBoardConfig = findBoardConfig(configKey.c_str());
            if (currentBoardConfig) {
                Display.setBoardConfig(currentBoardConfig);
                Logger.logln("Board image: loaded config '%s' (%dx%d, %d holds)",
                             configKey.c_str(), currentBoardConfig->imageWidth,
                             currentBoardConfig->imageHeight, currentBoardConfig->holdCount);
            } else {
                Display.setBoardConfig(nullptr);
                Logger.logln("Board image: no config found for '%s'", configKey.c_str());
            }
        }
    }

    // Pass LED commands to display for hold overlay rendering
    if (!commands.isNull() && count > 0 && currentBoardConfig) {
        WaveshareDisplay::LedCmd ledCmds[512];
        int cmdCount = min(count, 512);
        int idx = 0;
        for (JsonObject cmd : commands) {
            if (idx >= cmdCount) break;
            ledCmds[idx].position = cmd["position"] | 0;
            ledCmds[idx].r = cmd["r"] | 0;
            ledCmds[idx].g = cmd["g"] | 0;
            ledCmds[idx].b = cmd["b"] | 0;
            idx++;
        }
        Display.setLedCommands(ledCmds, idx);
    }
#endif

    // Update state
    currentQueueItemUuid = queueItemUuid ? queueItemUuid : "";
    currentClimbUuid = climbUuid ? climbUuid : "";
    currentClimbName = climbName ? climbName : "";
    currentGrade = climbGrade ? climbGrade : "";
    currentGradeColor = gradeColor ? gradeColor : "";
    hasCurrentClimb = true;

    // Sync local queue index with backend if we have queueItemUuid
    // BUT: Skip sync if there's a pending navigation mutation - the user is
    // rapidly pressing buttons and we don't want incoming LED updates to undo
    // their optimistic navigation
    if (queueItemUuid && Display.getQueueCount() > 0 && !g_mutationPending) {
        for (int i = 0; i < Display.getQueueCount(); i++) {
            const LocalQueueItem* item = Display.getQueueItem(i);
            if (item && strcmp(item->uuid, queueItemUuid) == 0) {
                Display.setCurrentQueueIndex(i);
                Logger.logln("LED Update: Synced local queue index to %d", i);
                break;
            }
        }
    } else if (g_mutationPending && queueItemUuid) {
        Logger.logln("LED Update: Skipping index sync - mutation pending");
    }

    // Parse navigation context if present
    if (data["navigation"].is<JsonObject>()) {
        JsonObject nav = data["navigation"];
        int currentIndex = nav["currentIndex"] | -1;
        int totalCount = nav["totalCount"] | 0;

        // Parse previous climb (first in previousClimbs array = immediate previous)
        QueueNavigationItem prevClimb;
        if (nav["previousClimbs"].is<JsonArray>()) {
            JsonArray prevArray = nav["previousClimbs"];
            if (prevArray.size() > 0) {
                JsonObject prev = prevArray[0];
                prevClimb = QueueNavigationItem(prev["name"] | "", prev["grade"] | "", prev["gradeColor"] | "");
            }
        }

        // Parse next climb
        QueueNavigationItem nextClimb;
        if (nav["nextClimb"].is<JsonObject>()) {
            JsonObject next = nav["nextClimb"];
            nextClimb = QueueNavigationItem(next["name"] | "", next["grade"] | "", next["gradeColor"] | "");
        }

        Display.setNavigationContext(prevClimb, nextClimb, currentIndex, totalCount);
        Logger.logln("Navigation: index %d/%d, prev: %s, next: %s", currentIndex + 1, totalCount,
                     prevClimb.isValid ? "yes" : "no", nextClimb.isValid ? "yes" : "no");
    } else {
        Display.clearNavigationContext();
    }

#if defined(ENABLE_WAVESHARE_AMOLED_DISPLAY) && defined(ENABLE_REMOTE_THUMBNAIL)
    if (fetchAndDisplayRemoteThumbnail(boardPath,
                                       frames,
                                       climbName,
                                       climbGrade,
                                       currentGradeColor.c_str(),
                                       angle,
                                       climbUuid,
                                       boardType.c_str())) {
        return;
    }
#endif

    // Update display with gradeColor
    // Note: We always update the display even during rapid navigation.
    // The index sync skip above prevents the queue position from jumping back,
    // but we still show whatever climb data arrives. This prevents blank screens.
    Display.showClimb(climbName, climbGrade ? climbGrade : "", currentGradeColor.c_str(), angle,
                      climbUuid ? climbUuid : "", boardType.c_str());
}

/**
 * Send navigation mutation to backend
 */
void sendNavigationMutation(const char* queueItemUuid) {
    String sessionId = Config.getString("session_id");
    if (sessionId.length() == 0) {
        Logger.logln("Navigation: No session ID configured");
        return;
    }

    // Use queueItemUuid for direct navigation (most reliable)
    String vars = "{\"sessionId\":\"" + sessionId + "\",\"direction\":\"next\"";
    vars += ",\"queueItemUuid\":\"" + String(queueItemUuid) + "\"";
    vars += "}";

    GraphQL.sendMutation("nav-direct",
                         "mutation NavDirect($sessionId: ID!, $direction: String!, $queueItemUuid: String) { "
                         "navigateQueue(sessionId: $sessionId, direction: $direction, queueItemUuid: $queueItemUuid) { "
                         "uuid climb { name difficulty } } }",
                         vars.c_str());

    Logger.logln("Navigation: Sent navigate request to queueItemUuid: %s", queueItemUuid);
}

/**
 * Navigate to previous climb in queue
 * Uses debounced mutation - UI updates immediately, but mutation is delayed
 * to coalesce rapid button presses into a single backend call
 */
void navigatePrevious() {
    if (!backendConnected) {
        Logger.logln("Navigation: Cannot navigate - not connected to backend");
        return;
    }

    if (Display.getQueueCount() == 0) {
        Logger.logln("Navigation: No queue state - cannot navigate");
        return;
    }

    if (!Display.canNavigatePrevious()) {
        Logger.logln("Navigation: Already at start of queue");
        return;
    }

    // Optimistic update - immediately show previous climb info (no board image redraw)
    if (Display.navigateToPrevious()) {
        const LocalQueueItem* newCurrent = Display.getCurrentQueueItem();
        if (newCurrent) {
            Logger.logln("Navigation: Optimistic update to previous - %s (uuid: %s)", newCurrent->name,
                         newCurrent->uuid);

#if defined(ENABLE_WAVESHARE_DISPLAY) && defined(ENABLE_BOARD_IMAGE)
            // Clear LED commands so stale holds aren't drawn if a full refresh happens
            Display.setLedCommands(nullptr, 0);
#endif
            // Update display info only (skips expensive board image redraw)
            Display.showClimbInfoOnly(newCurrent->name, newCurrent->grade, "", 0, newCurrent->climbUuid, boardType.c_str());

            // Schedule debounced mutation (will be sent after MUTATION_DEBOUNCE_MS of inactivity)
            // Store the UUID so it persists even if Display state changes from incoming updates
            strncpy(g_pendingMutationUuid, newCurrent->uuid, sizeof(g_pendingMutationUuid) - 1);
            g_pendingMutationUuid[sizeof(g_pendingMutationUuid) - 1] = '\0';
            g_pendingMutationTime = millis() + G_MUTATION_DEBOUNCE_MS;
            g_mutationPending = true;
        }
    }
}

/**
 * Navigate to next climb in queue
 * Uses debounced mutation - UI updates immediately, but mutation is delayed
 * to coalesce rapid button presses into a single backend call
 */
void navigateNext() {
    if (!backendConnected) {
        Logger.logln("Navigation: Cannot navigate - not connected to backend");
        return;
    }

    if (Display.getQueueCount() == 0) {
        Logger.logln("Navigation: No queue state - cannot navigate");
        return;
    }

    if (!Display.canNavigateNext()) {
        Logger.logln("Navigation: Already at end of queue");
        return;
    }

    // Optimistic update - immediately show next climb info (no board image redraw)
    if (Display.navigateToNext()) {
        const LocalQueueItem* newCurrent = Display.getCurrentQueueItem();
        if (newCurrent) {
            Logger.logln("Navigation: Optimistic update to next - %s (uuid: %s)", newCurrent->name, newCurrent->uuid);

#if defined(ENABLE_WAVESHARE_DISPLAY) && defined(ENABLE_BOARD_IMAGE)
            // Clear LED commands so stale holds aren't drawn if a full refresh happens
            Display.setLedCommands(nullptr, 0);
#endif
            // Update display info only (skips expensive board image redraw)
            Display.showClimbInfoOnly(newCurrent->name, newCurrent->grade, "", 0, newCurrent->climbUuid, boardType.c_str());

            // Schedule debounced mutation (will be sent after MUTATION_DEBOUNCE_MS of inactivity)
            // Store the UUID so it persists even if Display state changes from incoming updates
            strncpy(g_pendingMutationUuid, newCurrent->uuid, sizeof(g_pendingMutationUuid) - 1);
            g_pendingMutationUuid[sizeof(g_pendingMutationUuid) - 1] = '\0';
            g_pendingMutationTime = millis() + G_MUTATION_DEBOUNCE_MS;
            g_mutationPending = true;
        }
    }
}

/**
 * Navigate to a specific index in the queue
 * Used by landscape mode queue list tap
 */
void navigateToIndex(int index) {
    if (!backendConnected) {
        Logger.logln("Navigation: Cannot navigate - not connected to backend");
        return;
    }

    if (Display.getQueueCount() == 0) {
        Logger.logln("Navigation: No queue state - cannot navigate");
        return;
    }

    if (!Display.canNavigateToIndex(index)) {
        Logger.logln("Navigation: Invalid index %d", index);
        return;
    }

    if (Display.navigateToIndex(index)) {
        const LocalQueueItem* newCurrent = Display.getCurrentQueueItem();
        if (newCurrent) {
            Logger.logln("Navigation: Optimistic update to index %d - %s (uuid: %s)",
                         index, newCurrent->name, newCurrent->uuid);

#if defined(ENABLE_WAVESHARE_DISPLAY) && defined(ENABLE_BOARD_IMAGE)
            Display.setLedCommands(nullptr, 0);
#endif
            Display.showClimbInfoOnly(newCurrent->name, newCurrent->grade, "", 0, newCurrent->climbUuid, boardType.c_str());

            strncpy(g_pendingMutationUuid, newCurrent->uuid, sizeof(g_pendingMutationUuid) - 1);
            g_pendingMutationUuid[sizeof(g_pendingMutationUuid) - 1] = '\0';
            g_pendingMutationTime = millis() + G_MUTATION_DEBOUNCE_MS;
            g_mutationPending = true;
        }
    }
}
#endif  // HAS_DISPLAY

void startupAnimation() {
    // Simple chase animation to verify LED wiring
    for (int i = 0; i < NUM_LEDS; i++) {
        LEDs.clear();
        LEDs.setLed(i, 0, 255, 0);  // Green
        LEDs.show();
        delay(10);
    }

    // Flash all LEDs briefly
    LEDs.clear();
    for (int i = 0; i < NUM_LEDS; i++) {
        LEDs.setLed(i, 0, 0, 255);  // Blue
    }
    LEDs.show();
    delay(200);

    LEDs.clear();
    LEDs.show();
}
