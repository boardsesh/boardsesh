// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "web_server.h"

// Global instance
BoardWebServer boardWebServer;

BoardWebServer::BoardWebServer() : server(WEB_SERVER_PORT) {}

bool BoardWebServer::begin() {
    Serial.println("[Web] Starting web server...");

    // Set up routes
    server.on("/", HTTP_GET, [this]() { handleRoot(); });
    server.on("/api/status", HTTP_GET, [this]() { handleGetStatus(); });
    server.on("/api/config", HTTP_POST, [this]() { handlePostConfig(); });
    server.on("/api/test-led", HTTP_POST, [this]() { handleTestLed(); });
    server.on("/api/reset", HTTP_POST, [this]() { handleReset(); });

    // Proxy mode routes
    server.on("/api/scan-boards", HTTP_POST, [this]() { handleScanBoards(); });
    server.on("/api/connect-board", HTTP_POST, [this]() { handleConnectBoard(); });
    server.on("/api/disconnect-board", HTTP_POST, [this]() { handleDisconnectBoard(); });

    server.onNotFound([this]() { handleNotFound(); });

    server.begin();
    Serial.printf("[Web] Web server started on port %d\n", WEB_SERVER_PORT);

    return true;
}

void BoardWebServer::handleClient() {
    server.handleClient();
}

void BoardWebServer::handleRoot() {
    server.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    server.sendHeader("Pragma", "no-cache");
    server.sendHeader("Expires", "0");
    server.send(200, "text/html", getConfigPageHtml());
}

void BoardWebServer::handleGetStatus() {
    server.send(200, "application/json", getStatusJson());
}

void BoardWebServer::handlePostConfig() {
    if (!server.hasArg("plain")) {
        server.send(400, "application/json", "{\"error\":\"No body\"}");
        return;
    }

    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, server.arg("plain"));

    if (error) {
        server.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
        return;
    }

    // Update configuration
    bool needsReconnect = false;

    if (doc.containsKey("apiKey")) {
        String apiKey = doc["apiKey"].as<String>();
        if (apiKey.length() > 0) {
            configManager.setApiKey(apiKey);
            needsReconnect = true;
        }
    }

    if (doc.containsKey("sessionId")) {
        String sessionId = doc["sessionId"].as<String>();
        configManager.setSessionId(sessionId);
        wsClient.setSessionId(sessionId);
        needsReconnect = true;
    }

    if (doc.containsKey("backendUrl")) {
        String url = doc["backendUrl"].as<String>();
        if (url.length() > 0) {
            configManager.setBackendUrl(url);
            needsReconnect = true;
        }
    }

    if (doc.containsKey("ledPin")) {
        int pin = doc["ledPin"].as<int>();
        ledController.updateConfig(pin, -1);
    }

    if (doc.containsKey("ledCount")) {
        int count = doc["ledCount"].as<int>();
        ledController.updateConfig(-1, count);
    }

    if (doc.containsKey("brightness")) {
        int brightness = doc["brightness"].as<int>();
        ledController.setBrightness(brightness);
    }

    if (doc.containsKey("analyticsEnabled")) {
        bool enabled = doc["analyticsEnabled"].as<bool>();
        configManager.setAnalyticsEnabled(enabled);
    }

    // Handle controller mode change (requires restart to take effect)
    if (doc.containsKey("controllerMode")) {
        String mode = doc["controllerMode"].as<String>();
        if (mode == "proxy") {
            configManager.setControllerMode(ControllerMode::PROXY);
        } else {
            configManager.setControllerMode(ControllerMode::DIRECT);
        }
    }

    // Handle target board MAC for proxy mode
    if (doc.containsKey("targetBoardMac")) {
        String mac = doc["targetBoardMac"].as<String>();
        configManager.setTargetBoardMac(mac);
    }

    // Start or reconnect WebSocket if needed
    if (needsReconnect) {
        if (wsClient.isConnected()) {
            wsClient.reconnect();
        } else if (configManager.hasApiKey() && configManager.getSessionId().length() > 0) {
            // First time connection after config
            Serial.println("[Web] Starting WebSocket connection with new config...");
            wsClient.begin();
        }
    }

    server.send(200, "application/json", "{\"success\":true}");
}

void BoardWebServer::handleTestLed() {
    ledController.testPattern();
    server.send(200, "application/json", "{\"success\":true}");
}

void BoardWebServer::handleReset() {
    server.send(200, "application/json", "{\"success\":true,\"message\":\"Resetting...\"}");
    delay(100);

    // Clear all settings
    configManager.factoryReset();
    boardWiFiManager.resetSettings();

    // Restart
    ESP.restart();
}

void BoardWebServer::handleNotFound() {
    server.send(404, "text/plain", "Not Found");
}

void BoardWebServer::handleScanBoards() {
    Serial.println("[Web] Starting BLE scan for Kilter boards...");

    // Perform BLE scan
    std::vector<ScannedBoard> boards = bleClient.scan(BLE_SCAN_DURATION_SECONDS);

    // Build response JSON
    JsonDocument doc;
    JsonArray boardsArray = doc["boards"].to<JsonArray>();

    for (const auto& board : boards) {
        JsonObject boardObj = boardsArray.add<JsonObject>();
        boardObj["address"] = board.address;
        boardObj["name"] = board.name;
        boardObj["rssi"] = board.rssi;
    }

    doc["count"] = boards.size();

    String output;
    serializeJson(doc, output);
    server.send(200, "application/json", output);
}

// Validate BLE MAC address format (XX:XX:XX:XX:XX:XX)
static bool isValidMacAddress(const String& mac) {
    if (mac.length() != 17) return false;

    for (int i = 0; i < 17; i++) {
        if (i % 3 == 2) {
            // Expect colon at positions 2, 5, 8, 11, 14
            if (mac[i] != ':') return false;
        } else {
            // Expect hex digit
            char c = mac[i];
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) {
                return false;
            }
        }
    }
    return true;
}

void BoardWebServer::handleConnectBoard() {
    if (!server.hasArg("plain")) {
        server.send(400, "application/json", "{\"error\":\"No body\"}");
        return;
    }

    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, server.arg("plain"));

    if (error) {
        server.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
        return;
    }

    if (!doc.containsKey("address")) {
        server.send(400, "application/json", "{\"error\":\"Missing address\"}");
        return;
    }

    String address = doc["address"].as<String>();

    // Validate MAC address format
    if (!isValidMacAddress(address)) {
        server.send(400, "application/json", "{\"error\":\"Invalid MAC address format. Expected XX:XX:XX:XX:XX:XX\"}");
        return;
    }

    Serial.printf("[Web] Connecting to board: %s\n", address.c_str());

    // Save as target board
    configManager.setTargetBoardMac(address);

    // Attempt connection
    bool connected = bleClient.connect(address);

    JsonDocument response;
    response["success"] = connected;
    response["address"] = address;
    if (connected) {
        response["message"] = "Connected to board";
    } else {
        response["message"] = "Failed to connect to board";
    }

    String output;
    serializeJson(response, output);
    server.send(connected ? 200 : 500, "application/json", output);
}

void BoardWebServer::handleDisconnectBoard() {
    Serial.println("[Web] Disconnecting from board...");

    bleClient.disconnect();

    server.send(200, "application/json", "{\"success\":true,\"message\":\"Disconnected\"}");
}

String BoardWebServer::getStatusJson() {
    JsonDocument doc;

    // Controller mode
    bool isProxy = configManager.isProxyMode();
    doc["mode"]["current"] = isProxy ? "proxy" : "direct";
    doc["mode"]["name"] = isProxy ? "Proxy" : "Direct LED Control";

    // WiFi status
    doc["wifi"]["connected"] = boardWiFiManager.isConnected();
    doc["wifi"]["ssid"] = WiFi.SSID();
    doc["wifi"]["ip"] = boardWiFiManager.getIPAddress();
    doc["wifi"]["rssi"] = boardWiFiManager.getSignalStrength();

    // WebSocket status
    doc["websocket"]["connected"] = wsClient.isConnected();
    doc["websocket"]["subscribed"] = wsClient.isSubscribed();
    doc["websocket"]["sessionId"] = wsClient.getSessionId();

    // BLE server status
    doc["bluetooth"]["serverConnected"] = bleServer.isConnected();

    // BLE client status (proxy mode)
    doc["bluetooth"]["clientConnected"] = bleClient.isConnected();
    doc["bluetooth"]["targetBoard"] = configManager.getTargetBoardMac();
    doc["bluetooth"]["connectedBoard"] = bleClient.getConnectedAddress();

    // LED status
    doc["led"]["pin"] = ledController.getLedPin();
    doc["led"]["count"] = ledController.getLedCount();
    doc["led"]["brightness"] = ledController.getBrightness();
    doc["led"]["initialized"] = ledController.isInitialized();

    // Config status
    doc["config"]["hasApiKey"] = configManager.hasApiKey();
    doc["config"]["backendUrl"] = configManager.getBackendUrl();
    doc["config"]["analyticsEnabled"] = configManager.isAnalyticsEnabled();
    doc["config"]["controllerMode"] = isProxy ? "proxy" : "direct";
    doc["config"]["targetBoardMac"] = configManager.getTargetBoardMac();

    String output;
    serializeJson(doc, output);
    return output;
}

String BoardWebServer::getConfigPageHtml() {
    String html = R"html(
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BoardSesh Controller</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #1a1a2e;
            color: #eee;
            padding: 20px;
            max-width: 600px;
            margin: 0 auto;
        }
        h1 { color: #00d9ff; margin-bottom: 20px; }
        h2 { color: #00d9ff; margin: 20px 0 10px; font-size: 1.1em; }
        .card {
            background: #16213e;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
        }
        .status-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #0f3460;
        }
        .status-row:last-child { border-bottom: none; }
        .status-label { color: #888; }
        .status-value { font-weight: 500; }
        .status-ok { color: #4ade80; }
        .status-error { color: #f87171; }
        label { display: block; margin-bottom: 5px; color: #888; font-size: 0.9em; }
        input, select {
            width: 100%;
            padding: 10px;
            border: 1px solid #0f3460;
            border-radius: 4px;
            background: #0f3460;
            color: #eee;
            margin-bottom: 15px;
            font-size: 16px;
        }
        input:focus { outline: none; border-color: #00d9ff; }
        .checkbox-row {
            display: flex;
            align-items: center;
            margin-bottom: 15px;
        }
        .checkbox-row input[type="checkbox"] {
            width: auto;
            margin-right: 10px;
            margin-bottom: 0;
        }
        .checkbox-row label {
            margin-bottom: 0;
            color: #eee;
        }
        button {
            background: #00d9ff;
            color: #1a1a2e;
            border: none;
            padding: 12px 24px;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 600;
            font-size: 16px;
            width: 100%;
            margin-bottom: 10px;
        }
        button:hover { background: #00b8d9; }
        button.secondary {
            background: #0f3460;
            color: #eee;
        }
        button.danger {
            background: #dc2626;
            color: #fff;
        }
        .info { font-size: 0.85em; color: #666; margin-top: -10px; margin-bottom: 15px; }
        .message {
            padding: 10px;
            border-radius: 4px;
            margin-bottom: 15px;
            display: none;
        }
        .message.success { background: #166534; display: block; }
        .message.error { background: #991b1b; display: block; }
    </style>
</head>
<body>
    <h1>BoardSesh Controller</h1>

    <div id="message" class="message"></div>

    <div class="card">
        <h2>Status</h2>
        <div id="status">Loading...</div>
    </div>

    <div class="card">
        <h2>Controller Mode</h2>
        <label for="controllerMode">Operating Mode</label>
        <select id="controllerMode" name="controllerMode">
            <option value="direct")html";
    if (!configManager.isProxyMode()) {
        html += " selected";
    }
    html += R"html(>Direct LED Control</option>
            <option value="proxy")html";
    if (configManager.isProxyMode()) {
        html += " selected";
    }
    html += R"html(>Proxy to Kilter Board</option>
        </select>
        <p class="info">Direct: Control LEDs directly (replaces official board). Proxy: Forward commands to official board via BLE.</p>
        <p class="info" style="color: #f87171;">Changing mode requires a restart to take effect.</p>
    </div>

    <div class="card" id="proxyCard" style="display: none;">
        <h2>Proxy Mode - Target Board</h2>
        <div id="proxyStatus">
            <div class="status-row">
                <span class="status-label">Target Board</span>
                <span class="status-value" id="targetBoardDisplay">Not configured</span>
            </div>
            <div class="status-row">
                <span class="status-label">Connection</span>
                <span class="status-value" id="proxyConnectionStatus">Disconnected</span>
            </div>
        </div>
        <button class="secondary" onclick="scanBoards()" id="scanBtn">Scan for Kilter Boards</button>
        <div id="scanResults" style="margin-top: 15px;"></div>
        <button class="secondary" onclick="disconnectBoard()" id="disconnectBtn" style="display: none;">Disconnect</button>
    </div>

    <div class="card">
        <h2>Configuration</h2>
        <form id="configForm">
            <label for="apiKey">API Key</label>
            <input type="password" id="apiKey" name="apiKey" placeholder="Enter your BoardSesh API key">
            <p class="info">Get your API key from BoardSesh settings</p>

            <label for="sessionId">Session ID</label>
            <input type="text" id="sessionId" name="sessionId" placeholder="Enter session ID to connect to">

            <label for="backendUrl">Backend URL</label>
            <input type="text" id="backendUrl" name="backendUrl" value=")html";
    html += DEFAULT_BACKEND_URL;
    html += R"html(">

            <div id="ledConfigSection">
                <label for="ledCount">LED Count</label>
                <input type="number" id="ledCount" name="ledCount" min="1" max="500" value=")html";
    html += String(configManager.getLedCount());
    html += R"html(">

                <label for="brightness">Brightness (0-255)</label>
                <input type="number" id="brightness" name="brightness" min="0" max="255" value=")html";
    html += String(configManager.getBrightness());
    html += R"html(">
            </div>

            <div class="checkbox-row">
                <input type="checkbox" id="analyticsEnabled" name="analyticsEnabled")html";
    if (configManager.isAnalyticsEnabled()) {
        html += " checked";
    }
    html += R"html(>
                <label for="analyticsEnabled">Send diagnostic logs to BoardSesh</label>
            </div>
            <p class="info">Helps improve the controller by sending anonymous usage data</p>

            <button type="submit">Save Configuration</button>
        </form>
    </div>

    <div class="card">
        <h2>Actions</h2>
        <button class="secondary" onclick="testLeds()" id="testLedsBtn">Test LEDs</button>
        <button class="danger" onclick="factoryReset()">Factory Reset</button>
    </div>

    <script>
        let initialLoadDone = false;

        function updateModeUI(mode) {
            const isProxy = mode === 'proxy';
            document.getElementById('proxyCard').style.display = isProxy ? 'block' : 'none';
            document.getElementById('ledConfigSection').style.display = isProxy ? 'none' : 'block';
            document.getElementById('testLedsBtn').style.display = isProxy ? 'none' : 'block';
        }

        document.getElementById('controllerMode').addEventListener('change', (e) => {
            updateModeUI(e.target.value);
        });

        async function loadStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                const isProxy = data.mode.current === 'proxy';

                let statusHtml = `
                    <div class="status-row">
                        <span class="status-label">Mode</span>
                        <span class="status-value">${data.mode.name}</span>
                    </div>
                    <div class="status-row">
                        <span class="status-label">WiFi</span>
                        <span class="status-value ${data.wifi.connected ? 'status-ok' : 'status-error'}">
                            ${data.wifi.connected ? 'Connected (' + data.wifi.ip + ')' : 'Disconnected'}
                        </span>
                    </div>
                    <div class="status-row">
                        <span class="status-label">WebSocket</span>
                        <span class="status-value ${data.websocket.subscribed ? 'status-ok' : 'status-error'}">
                            ${data.websocket.subscribed ? 'Subscribed' : data.websocket.connected ? 'Connected' : 'Disconnected'}
                        </span>
                    </div>`;

                if (isProxy) {
                    statusHtml += `
                    <div class="status-row">
                        <span class="status-label">Target Board</span>
                        <span class="status-value ${data.bluetooth.clientConnected ? 'status-ok' : 'status-error'}">
                            ${data.bluetooth.clientConnected ? 'Connected to ' + data.bluetooth.connectedBoard : 'Disconnected'}
                        </span>
                    </div>`;
                } else {
                    statusHtml += `
                    <div class="status-row">
                        <span class="status-label">Bluetooth</span>
                        <span class="status-value ${data.bluetooth.serverConnected ? 'status-ok' : ''}">
                            ${data.bluetooth.serverConnected ? 'Device Connected' : 'Waiting for connection'}
                        </span>
                    </div>
                    <div class="status-row">
                        <span class="status-label">LEDs</span>
                        <span class="status-value">${data.led.count} @ pin ${data.led.pin}</span>
                    </div>`;
                }

                statusHtml += `
                    <div class="status-row">
                        <span class="status-label">API Key</span>
                        <span class="status-value ${data.config.hasApiKey ? 'status-ok' : 'status-error'}">
                            ${data.config.hasApiKey ? 'Configured' : 'Not Set'}
                        </span>
                    </div>
                `;
                document.getElementById('status').innerHTML = statusHtml;

                // Update proxy mode UI
                updateModeUI(data.config.controllerMode);
                if (isProxy) {
                    document.getElementById('targetBoardDisplay').textContent =
                        data.bluetooth.targetBoard || 'Not configured';
                    document.getElementById('proxyConnectionStatus').className =
                        'status-value ' + (data.bluetooth.clientConnected ? 'status-ok' : 'status-error');
                    document.getElementById('proxyConnectionStatus').textContent =
                        data.bluetooth.clientConnected ? 'Connected' : 'Disconnected';
                    document.getElementById('disconnectBtn').style.display =
                        data.bluetooth.clientConnected ? 'block' : 'none';
                }

                // Only update form fields on initial load
                if (!initialLoadDone) {
                    if (data.websocket.sessionId) {
                        document.getElementById('sessionId').value = data.websocket.sessionId;
                    }
                    if (data.config.backendUrl) {
                        document.getElementById('backendUrl').value = data.config.backendUrl;
                    }
                    document.getElementById('ledCount').value = data.led.count;
                    document.getElementById('brightness').value = data.led.brightness;
                    document.getElementById('analyticsEnabled').checked = data.config.analyticsEnabled;
                    document.getElementById('controllerMode').value = data.config.controllerMode;
                    initialLoadDone = true;
                }
            } catch (e) {
                document.getElementById('status').innerHTML = '<span class="status-error">Failed to load status</span>';
            }
        }

        function showMessage(text, isError = false) {
            const msg = document.getElementById('message');
            msg.textContent = text;
            msg.className = 'message ' + (isError ? 'error' : 'success');
            setTimeout(() => msg.className = 'message', 3000);
        }

        document.getElementById('configForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            const data = {};
            formData.forEach((v, k) => { if (v) data[k] = v; });
            data.analyticsEnabled = document.getElementById('analyticsEnabled').checked;
            data.controllerMode = document.getElementById('controllerMode').value;

            try {
                const res = await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                if (res.ok) {
                    showMessage('Configuration saved!');
                    initialLoadDone = false;
                    loadStatus();
                } else {
                    showMessage('Failed to save', true);
                }
            } catch (e) {
                showMessage('Error: ' + e.message, true);
            }
        });

        async function scanBoards() {
            const btn = document.getElementById('scanBtn');
            const resultsDiv = document.getElementById('scanResults');
            btn.disabled = true;
            btn.textContent = 'Scanning...';
            resultsDiv.innerHTML = '<p style="color: #888;">Scanning for nearby Kilter boards...</p>';

            try {
                const res = await fetch('/api/scan-boards', { method: 'POST' });
                const data = await res.json();

                if (data.boards.length === 0) {
                    resultsDiv.innerHTML = '<p style="color: #888;">No Kilter boards found nearby.</p>';
                } else {
                    let html = '<p style="color: #888; margin-bottom: 10px;">Found ' + data.count + ' board(s):</p>';
                    data.boards.forEach(board => {
                        html += `<div class="status-row" style="cursor: pointer; padding: 10px; background: #0f3460; margin-bottom: 5px; border-radius: 4px;" onclick="connectToBoard('${board.address}')">
                            <span>${board.name || 'Unknown'}</span>
                            <span style="color: #888;">${board.address} (${board.rssi} dBm)</span>
                        </div>`;
                    });
                    resultsDiv.innerHTML = html;
                }
            } catch (e) {
                resultsDiv.innerHTML = '<p class="status-error">Scan failed: ' + e.message + '</p>';
            }

            btn.disabled = false;
            btn.textContent = 'Scan for Kilter Boards';
        }

        async function connectToBoard(address) {
            showMessage('Connecting to ' + address + '...');
            try {
                const res = await fetch('/api/connect-board', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ address })
                });
                const data = await res.json();
                if (data.success) {
                    showMessage('Connected to board!');
                    document.getElementById('scanResults').innerHTML = '';
                } else {
                    showMessage('Failed to connect: ' + data.message, true);
                }
                loadStatus();
            } catch (e) {
                showMessage('Error: ' + e.message, true);
            }
        }

        async function disconnectBoard() {
            try {
                await fetch('/api/disconnect-board', { method: 'POST' });
                showMessage('Disconnected from board');
                loadStatus();
            } catch (e) {
                showMessage('Error: ' + e.message, true);
            }
        }

        async function testLeds() {
            try {
                await fetch('/api/test-led', { method: 'POST' });
                showMessage('Running LED test...');
            } catch (e) {
                showMessage('Error: ' + e.message, true);
            }
        }

        async function factoryReset() {
            if (!confirm('This will erase all settings and restart the controller. Continue?')) return;
            try {
                await fetch('/api/reset', { method: 'POST' });
                showMessage('Resetting... Device will restart.');
            } catch (e) {
                showMessage('Error: ' + e.message, true);
            }
        }

        // Load status on page load and refresh every 5 seconds
        loadStatus();
        setInterval(loadStatus, 5000);
    </script>
</body>
</html>
)html";

    return html;
}
