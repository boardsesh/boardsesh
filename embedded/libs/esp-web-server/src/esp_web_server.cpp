#include "esp_web_server.h"

#include <config/board_config.h>

// Firmware version macros - provided by build flags or version.h in the project
#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "dev"
#endif

#ifndef FIRMWARE_BUILD_ENV
#define FIRMWARE_BUILD_ENV "unknown"
#endif

namespace {

String getConfigStringOrDefault(const char* key, const char* defaultValue) {
    String value = Config.getString(key);
    value.trim();
    return value.length() == 0 ? String(defaultValue) : value;
}

}  // namespace

ESPWebServer WebConfig;

ESPWebServer::ESPWebServer() : server(WEB_SERVER_PORT), running(false), statusProvider(nullptr) {}

void ESPWebServer::begin() {
    setupRoutes();
    server.begin();
    running = true;
}

void ESPWebServer::loop() {
    if (running) {
        server.handleClient();
    }
}

void ESPWebServer::stop() {
    server.stop();
    running = false;
}

void ESPWebServer::on(const char* path, HTTPMethod method, WebServerRouteHandler handler) {
    server.on(path, method, [this, handler]() {
        setCorsHeaders();
        handler(server);
    });
}

void ESPWebServer::setStatusProvider(WebServerStatusProvider provider) {
    statusProvider = provider;
}

void ESPWebServer::sendJson(int code, JsonDocument& doc) {
    String response;
    serializeJson(doc, response);
    server.send(code, "application/json", response);
}

void ESPWebServer::sendJson(int code, const char* json) {
    server.send(code, "application/json", json);
}

void ESPWebServer::sendError(int code, const char* message) {
    JsonDocument doc;
    doc["error"] = message;
    sendJson(code, doc);
}

WebServer& ESPWebServer::getServer() {
    return server;
}

void ESPWebServer::setupRoutes() {
    server.on("/", HTTP_GET, [this]() { handleRoot(); });
    server.on("/api/config", HTTP_GET, [this]() { handleGetConfig(); });
    server.on("/api/config", HTTP_POST, [this]() { handleSetConfig(); });
    server.on("/api/status", HTTP_GET, [this]() { handleGetStatus(); });
    server.on("/api/wifi/scan", HTTP_GET, [this]() { handleWiFiScan(); });
    server.on("/api/wifi/connect", HTTP_POST, [this]() { handleWiFiConnect(); });
    server.on("/api/wifi/status", HTTP_GET, [this]() { handleWiFiStatus(); });
    server.on("/api/restart", HTTP_POST, [this]() { handleRestart(); });

    // Firmware version endpoint
    server.on("/api/firmware/version", HTTP_GET, [this]() { handleFirmwareVersion(); });

    // Firmware upload - uses the two-callback pattern for file upload handling
    server.on("/api/firmware/upload", HTTP_POST,
        [this]() { handleFirmwareUploadComplete(); },
        [this]() { handleFirmwareUploadData(); }
    );

    // Captive portal detection endpoints (redirect to config page in AP mode)
    server.on("/generate_204", HTTP_GET, [this]() { handleCaptivePortal(); });       // Android
    server.on("/hotspot-detect.html", HTTP_GET, [this]() { handleCaptivePortal(); }); // Apple
    server.on("/connecttest.txt", HTTP_GET, [this]() { handleCaptivePortal(); });     // Windows
    server.on("/redirect", HTTP_GET, [this]() { handleCaptivePortal(); });            // Windows
    server.on("/fwlink", HTTP_GET, [this]() { handleCaptivePortal(); });              // Windows

    server.onNotFound([this]() { handleNotFound(); });
}

void ESPWebServer::setCorsHeaders() {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

void ESPWebServer::handleRoot() {
    setCorsHeaders();
    server.send(200, "text/html", R"rawliteral(
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Boardsesh Controller</title>
    <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #1a1a2e; color: #eee; }
        h1 { color: #00d9ff; margin-bottom: 5px; }
        .subtitle { color: #888; margin-bottom: 20px; }
        .card { background: #16213e; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        h2 { margin-top: 0; color: #00d9ff; font-size: 1.1em; border-bottom: 1px solid #0f3460; padding-bottom: 10px; }
        label { display: block; margin-bottom: 5px; color: #aaa; font-size: 0.9em; }
        input, select { width: 100%; padding: 12px; border: 1px solid #0f3460; border-radius: 8px; background: #0f3460; color: #fff; margin-bottom: 15px; font-size: 16px; }
        input:focus, select:focus { outline: none; border-color: #00d9ff; }
        button { background: #00d9ff; color: #1a1a2e; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 1em; width: 100%; }
        button:hover { background: #00b8d4; }
        button:disabled { background: #555; cursor: not-allowed; }
        .btn-secondary { background: #0f3460; color: #fff; }
        .btn-secondary:hover { background: #1a4a7a; }
        .btn-danger { background: #e94560; }
        .btn-danger:hover { background: #c73e54; }
        .status { padding: 10px; border-radius: 8px; margin-bottom: 15px; }
        .status.connected { background: rgba(0, 217, 100, 0.2); border: 1px solid #00d964; }
        .status.disconnected { background: rgba(233, 69, 96, 0.2); border: 1px solid #e94560; }
        .network-list { max-height: 200px; overflow-y: auto; }
        .network { padding: 12px; background: #0f3460; border-radius: 8px; margin-bottom: 8px; cursor: pointer; display: flex; justify-content: space-between; }
        .network:hover { background: #1a4a7a; }
        .network.selected { border: 2px solid #00d9ff; }
        .signal { color: #888; }
        .row { display: flex; gap: 10px; }
        .row > * { flex: 1; }
        .slider-container { display: flex; align-items: center; gap: 15px; }
        .slider-container input[type="range"] { flex: 1; }
        .slider-value { min-width: 40px; text-align: center; }
        input[type="range"] { -webkit-appearance: none; height: 8px; border-radius: 4px; }
        input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; background: #00d9ff; border-radius: 50%; cursor: pointer; }
        .loading { opacity: 0.5; pointer-events: none; }
        .msg { padding: 10px; border-radius: 8px; margin-bottom: 15px; display: none; }
        .msg.success { display: block; background: rgba(0, 217, 100, 0.2); border: 1px solid #00d964; }
        .msg.error { display: block; background: rgba(233, 69, 96, 0.2); border: 1px solid #e94560; }
        .progress-bar { width: 100%; height: 20px; background: #0f3460; border-radius: 10px; overflow: hidden; margin: 10px 0; display: none; }
        .progress-bar-fill { height: 100%; background: #00d9ff; border-radius: 10px; transition: width 0.3s; width: 0%; }
        .firmware-info { color: #888; font-size: 0.9em; margin-bottom: 15px; }
        .status-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .status-item { background: #0f3460; border-radius: 8px; padding: 10px; min-height: 58px; }
        .status-label { display: block; color: #888; font-size: 0.78em; margin-bottom: 5px; }
        .status-value { color: #fff; font-weight: 600; overflow-wrap: anywhere; }
        .hint { color: #888; font-size: 0.85em; line-height: 1.4; margin-top: -4px; }
    </style>
</head>
<body>
    <h1>Boardsesh</h1>
    <p class="subtitle">Board Controller Configuration</p>

    <div class="card">
        <h2>WiFi Status</h2>
        <div id="wifiStatus" class="status disconnected">Checking...</div>
        <button onclick="scanNetworks()" class="btn-secondary" id="scanBtn">Scan Networks</button>
    </div>

    <div class="card">
        <h2>Controller Status</h2>
        <div class="status-grid">
            <div class="status-item"><span class="status-label">Backend</span><span class="status-value" id="backendStatus">Checking...</span></div>
            <div class="status-item"><span class="status-label">Session</span><span class="status-value" id="sessionStatus">Checking...</span></div>
            <div class="status-item"><span class="status-label">BLE</span><span class="status-value" id="bleStatus">Checking...</span></div>
            <div class="status-item"><span class="status-label">Preview Board</span><span class="status-value" id="previewBoardStatus">Checking...</span></div>
            <div class="status-item"><span class="status-label">Last BLE Payload</span><span class="status-value" id="lastBlePayload">None</span></div>
            <div class="status-item"><span class="status-label">Thumbnail</span><span class="status-value" id="thumbnailStatus">None</span></div>
            <div class="status-item"><span class="status-label">Render Host</span><span class="status-value" id="renderStatus">Checking...</span></div>
        </div>
    </div>

    <div class="card" id="networkCard" style="display:none;">
        <h2>Available Networks</h2>
        <div id="networkList" class="network-list"></div>
        <div id="passwordSection" style="display:none; margin-top: 15px;">
            <label>Password</label>
            <input type="password" id="wifiPassword" placeholder="Enter WiFi password">
            <button onclick="connectWifi()">Connect</button>
        </div>
    </div>

    <div class="card">
        <h2>Device Settings</h2>
        <label>Device Name</label>
        <input type="text" id="deviceName" placeholder="Boardsesh Controller">
        <label>LED Brightness</label>
        <div class="slider-container">
            <input type="range" id="brightness" min="0" max="255" value="128">
            <span class="slider-value" id="brightnessValue">128</span>
        </div>
        <label>Display Brightness</label>
        <div class="slider-container">
            <input type="range" id="displayBrightness" min="0" max="255" value="128">
            <span class="slider-value" id="displayBrightnessValue">128</span>
        </div>
        <label>Display Mode</label>
        <select id="displayMode">
            <option value="0">Portrait (480x800)</option>
            <option value="1">Landscape (800x480)</option>
        </select>
    </div>

    <div class="card">
        <h2>BLE Proxy Mode</h2>
        <p style="color: #888; font-size: 0.9em; margin-bottom: 15px;">
            Enable proxy mode to forward data from official Kilter/Tension app to a nearby board.
            This lets you use the official app while also showing climb info on this device.
        </p>
        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
            <input type="checkbox" id="proxyEnabled" style="width: auto; margin: 0;">
            <span>Enable BLE Proxy</span>
        </label>
        <div id="proxyMacSection" style="display: none; margin-top: 15px;">
            <label>Target Board MAC (optional)</label>
            <input type="text" id="proxyMac" placeholder="Auto-detect nearest board">
            <p style="color: #888; font-size: 0.8em; margin-top: -10px;">
                Leave empty to connect to the nearest Aurora board
            </p>
        </div>
    </div>

    <div class="card">
        <h2>Boardsesh Session</h2>
        <p class="hint">
            Session sync is optional. Leave it off when this controller is only previewing BLE payloads.
        </p>
        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
            <input type="checkbox" id="backendSyncEnabled" style="width: auto; margin: 0;">
            <span>Enable backend session sync</span>
        </label>
        <label>Session ID</label>
        <input type="text" id="sessionId" placeholder="Enter session ID from Boardsesh app">
        <label>API Key</label>
        <input type="password" id="apiKey" placeholder="Enter API key">
    </div>

    <div class="card">
        <h2>BLE Preview Board</h2>
        <p class="hint">
            Incoming Bluetooth payloads use this board config to render a preview from the web app. No session ID is required.
        </p>
        <label>Board</label>
        <select id="previewBoardName">
            <option value="kilter">Kilter</option>
            <option value="tension">Tension</option>
        </select>
        <div class="row">
            <div>
                <label>Layout ID</label>
                <input type="number" id="previewLayoutId" placeholder="8">
            </div>
            <div>
                <label>Size ID</label>
                <input type="number" id="previewSizeId" placeholder="25">
            </div>
        </div>
        <label>Set IDs</label>
        <input type="text" id="previewSetIds" placeholder="26,27,28,29">
    </div>

    <div class="card">
        <h2>Backend Connection</h2>
        <label>Host</label>
        <input type="text" id="backendHost" placeholder="ws.boardsesh.com">
        <div class="row">
            <div>
                <label>Port</label>
                <input type="number" id="backendPort" placeholder="443">
            </div>
            <div>
                <label>Path</label>
                <input type="text" id="backendPath" placeholder="/graphql">
            </div>
        </div>
        <label>Render URL</label>
        <input type="text" id="renderBaseUrl" placeholder="https://www.boardsesh.com">
        <p class="hint">
            Keep this as the web app host. The board image comes from /api/internal/board-render, not the WebSocket host.
        </p>
    </div>

    <div class="card">
        <h2>Firmware Update</h2>
        <div class="firmware-info">
            <span>Version: </span><strong id="fwVersion">Loading...</strong><br>
            <span>Build: </span><strong id="fwBuildEnv">Loading...</strong>
        </div>
        <label>Select firmware file (.bin)</label>
        <input type="file" id="fwFile" accept=".bin">
        <div class="progress-bar" id="fwProgress">
            <div class="progress-bar-fill" id="fwProgressFill"></div>
        </div>
        <div id="fwStatus" style="margin-bottom: 15px;"></div>
        <button onclick="uploadFirmware()" id="fwUploadBtn" disabled class="btn-danger">Upload Firmware</button>
    </div>

    <div id="message" class="msg"></div>

    <button onclick="saveConfig()">Save Configuration</button>
    <br><br>
    <button onclick="restart()" class="btn-danger">Restart Device</button>

    <script>
        let selectedNetwork = null;

        async function loadConfig() {
            try {
                const res = await fetch('/api/config');
                const cfg = await res.json();
                document.getElementById('deviceName').value = cfg.device_name || '';
                document.getElementById('brightness').value = cfg.brightness || 128;
                document.getElementById('brightnessValue').textContent = cfg.brightness || 128;
                document.getElementById('displayBrightness').value = cfg.display_brightness || 128;
                document.getElementById('displayBrightnessValue').textContent = cfg.display_brightness || 128;
                document.getElementById('displayMode').value = cfg.display_mode || 0;
                document.getElementById('backendSyncEnabled').checked = cfg.backend_sync_enabled || false;
                document.getElementById('sessionId').value = cfg.session_id || '';
                document.getElementById('apiKey').value = cfg.api_key || '';
                document.getElementById('previewBoardName').value = cfg.preview_board_name || 'kilter';
                document.getElementById('previewLayoutId').value = cfg.preview_layout_id || 8;
                document.getElementById('previewSizeId').value = cfg.preview_size_id || 25;
                document.getElementById('previewSetIds').value = cfg.preview_set_ids || '26,27,28,29';
                document.getElementById('backendHost').value = cfg.backend_host || '';
                document.getElementById('backendPort').value = cfg.backend_port || 443;
                document.getElementById('backendPath').value = cfg.backend_path || '/graphql';
                document.getElementById('renderBaseUrl').value = cfg.render_base_url || 'https://www.boardsesh.com';
                document.getElementById('proxyEnabled').checked = cfg.proxy_enabled || false;
                document.getElementById('proxyMac').value = cfg.proxy_mac || '';
                document.getElementById('proxyMacSection').style.display = cfg.proxy_enabled ? 'block' : 'none';
            } catch (e) { console.error('Failed to load config:', e); }
        }

        async function loadWifiStatus() {
            try {
                const res = await fetch('/api/wifi/status');
                const status = await res.json();
                const el = document.getElementById('wifiStatus');
                if (status.connected) {
                    el.className = 'status connected';
                    el.innerHTML = 'Connected to <strong>' + status.ssid + '</strong><br>IP: ' + status.ip + ' | Signal: ' + status.rssi + ' dBm';
                } else if (status.ap_mode) {
                    el.className = 'status disconnected';
                    el.innerHTML = 'Access Point Mode<br>IP: ' + status.ip + '<br><small>Connect to a WiFi network below</small>';
                } else {
                    el.className = 'status disconnected';
                    el.textContent = 'Not connected';
                }
            } catch (e) { console.error('Failed to load wifi status:', e); }
        }

        function yesNo(value) {
            return value ? 'Yes' : 'No';
        }

        function ageText(ageMs) {
            if (ageMs < 0) return '';
            if (ageMs < 1000) return ' just now';
            return ' ' + Math.round(ageMs / 1000) + 's ago';
        }

        async function loadControllerStatus() {
            try {
                const res = await fetch('/api/status');
                const status = await res.json();
                const backendText = status.backend_connected
                    ? 'Connected (' + status.backend_state + ')'
                    : 'Disconnected (' + status.backend_state + ')';
                document.getElementById('backendStatus').textContent = backendText;

                const sessionText = status.backend_subscribed
                    ? 'Subscribed'
                    : 'API key: ' + yesNo(status.api_key_configured) + ', session: ' + yesNo(status.session_id_configured);
                document.getElementById('sessionStatus').textContent = sessionText;

                const bleText = status.ble_initialized
                    ? (status.ble_connected ? 'Connected' : (status.ble_advertising ? 'Advertising' : 'Ready'))
                    : 'Waiting for WiFi';
                document.getElementById('bleStatus').textContent = bleText;

                document.getElementById('previewBoardStatus').textContent =
                    (status.preview_board_name || 'kilter') + ' / ' +
                    (status.preview_layout_id || 8) + ' / ' +
                    (status.preview_size_id || 25) + ' / ' +
                    (status.preview_set_ids || '26,27,28,29');

                const lastBleText = status.last_ble_payload_seen
                    ? status.last_ble_led_count + ' LEDs @ ' + status.last_ble_angle + ' deg' + ageText(status.last_ble_age_ms)
                    : 'None';
                document.getElementById('lastBlePayload').textContent = lastBleText;

                const thumbnailText = status.thumbnail_fetch_seen
                    ? status.thumbnail_status + ' HTTP ' + status.thumbnail_http_status + ' (' + status.thumbnail_bytes + ' bytes)'
                    : 'None';
                document.getElementById('thumbnailStatus').textContent = thumbnailText;
                document.getElementById('renderStatus').textContent = status.render_base_url || 'https://www.boardsesh.com';
            } catch (e) { console.error('Failed to load controller status:', e); }
        }

        async function scanNetworks() {
            const btn = document.getElementById('scanBtn');
            btn.disabled = true;
            btn.textContent = 'Scanning...';
            try {
                const res = await fetch('/api/wifi/scan');
                const data = await res.json();
                const list = document.getElementById('networkList');
                list.innerHTML = '';
                data.networks.sort((a, b) => b.rssi - a.rssi).forEach(n => {
                    const div = document.createElement('div');
                    div.className = 'network';
                    div.innerHTML = '<span>' + n.ssid + (n.secure ? ' 🔒' : '') + '</span><span class="signal">' + n.rssi + ' dBm</span>';
                    div.onclick = () => selectNetwork(n.ssid, div);
                    list.appendChild(div);
                });
                document.getElementById('networkCard').style.display = 'block';
            } catch (e) { showMessage('Failed to scan networks', true); }
            btn.disabled = false;
            btn.textContent = 'Scan Networks';
        }

        function selectNetwork(ssid, el) {
            document.querySelectorAll('.network').forEach(n => n.classList.remove('selected'));
            el.classList.add('selected');
            selectedNetwork = ssid;
            document.getElementById('passwordSection').style.display = 'block';
        }

        async function connectWifi() {
            if (!selectedNetwork) return;
            const password = document.getElementById('wifiPassword').value;
            try {
                await fetch('/api/wifi/connect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ssid: selectedNetwork, password })
                });
                showMessage('Connecting to ' + selectedNetwork + '...');
                setTimeout(loadWifiStatus, 5000);
            } catch (e) { showMessage('Failed to connect', true); }
        }

        async function saveConfig() {
            const config = {
                device_name: document.getElementById('deviceName').value,
                brightness: parseInt(document.getElementById('brightness').value),
                display_brightness: parseInt(document.getElementById('displayBrightness').value),
                display_mode: parseInt(document.getElementById('displayMode').value),
                backend_sync_enabled: document.getElementById('backendSyncEnabled').checked,
                session_id: document.getElementById('sessionId').value,
                api_key: document.getElementById('apiKey').value,
                preview_board_name: document.getElementById('previewBoardName').value,
                preview_layout_id: parseInt(document.getElementById('previewLayoutId').value),
                preview_size_id: parseInt(document.getElementById('previewSizeId').value),
                preview_set_ids: document.getElementById('previewSetIds').value,
                backend_host: document.getElementById('backendHost').value,
                backend_port: parseInt(document.getElementById('backendPort').value),
                backend_path: document.getElementById('backendPath').value,
                render_base_url: document.getElementById('renderBaseUrl').value,
                proxy_enabled: document.getElementById('proxyEnabled').checked,
                proxy_mac: document.getElementById('proxyMac').value
            };
            try {
                await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config)
                });
                showMessage('Configuration saved!');
            } catch (e) { showMessage('Failed to save configuration', true); }
        }

        async function restart() {
            if (!confirm('Restart the device?')) return;
            try {
                await fetch('/api/restart', { method: 'POST' });
                showMessage('Restarting...');
            } catch (e) {}
        }

        function showMessage(msg, isError = false) {
            const el = document.getElementById('message');
            el.textContent = msg;
            el.className = 'msg ' + (isError ? 'error' : 'success');
            setTimeout(() => { el.className = 'msg'; }, 3000);
        }

        async function loadFirmwareInfo() {
            try {
                const res = await fetch('/api/firmware/version');
                const data = await res.json();
                document.getElementById('fwVersion').textContent = data.version || 'Unknown';
                document.getElementById('fwBuildEnv').textContent = data.build_env || 'Unknown';
            } catch (e) {
                document.getElementById('fwVersion').textContent = 'Error';
                document.getElementById('fwBuildEnv').textContent = 'Error';
            }
        }

        document.getElementById('fwFile').onchange = function() {
            var btn = document.getElementById('fwUploadBtn');
            btn.disabled = !this.files.length;
        };

        function uploadFirmware() {
            var fileInput = document.getElementById('fwFile');
            if (!fileInput.files.length) return;

            var file = fileInput.files[0];
            if (!file.name.endsWith('.bin')) {
                showMessage('Please select a .bin firmware file', true);
                return;
            }

            if (!confirm('Upload firmware "' + file.name + '" (' + Math.round(file.size / 1024) + ' KB)? The device will reboot after upload.')) return;

            var xhr = new XMLHttpRequest();
            var formData = new FormData();
            formData.append('firmware', file, file.name);

            var progressBar = document.getElementById('fwProgress');
            var progressFill = document.getElementById('fwProgressFill');
            var statusEl = document.getElementById('fwStatus');
            var uploadBtn = document.getElementById('fwUploadBtn');

            progressBar.style.display = 'block';
            uploadBtn.disabled = true;
            statusEl.textContent = 'Uploading...';
            statusEl.style.color = '#aaa';

            xhr.upload.onprogress = function(e) {
                if (e.lengthComputable) {
                    var pct = Math.round((e.loaded / e.total) * 100);
                    progressFill.style.width = pct + '%';
                    statusEl.textContent = 'Uploading: ' + pct + '%';
                }
            };

            xhr.onload = function() {
                if (xhr.status === 200) {
                    progressFill.style.width = '100%';
                    statusEl.textContent = 'Upload complete! Rebooting device...';
                    statusEl.style.color = '#00d964';
                    setTimeout(function() {
                        statusEl.textContent = 'Reloading page...';
                        window.location.reload();
                    }, 10000);
                } else {
                    var msg = 'Upload failed';
                    try { msg = JSON.parse(xhr.responseText).error || msg; } catch(e) {}
                    statusEl.textContent = msg;
                    statusEl.style.color = '#e94560';
                    uploadBtn.disabled = false;
                }
            };

            xhr.onerror = function() {
                statusEl.textContent = 'Upload failed - connection error';
                statusEl.style.color = '#e94560';
                uploadBtn.disabled = false;
            };

            xhr.open('POST', '/api/firmware/upload');
            xhr.send(formData);
        }

        document.getElementById('brightness').oninput = function() {
            document.getElementById('brightnessValue').textContent = this.value;
        };

        document.getElementById('displayBrightness').oninput = function() {
            document.getElementById('displayBrightnessValue').textContent = this.value;
        };

        document.getElementById('proxyEnabled').onchange = function() {
            document.getElementById('proxyMacSection').style.display = this.checked ? 'block' : 'none';
        };

        loadConfig();
        loadWifiStatus();
        loadControllerStatus();
        loadFirmwareInfo();
        setInterval(loadWifiStatus, 10000);
        setInterval(loadControllerStatus, 5000);
    </script>
</body>
</html>
)rawliteral");
}

void ESPWebServer::handleCaptivePortal() {
    setCorsHeaders();
    server.sendHeader("Location", "http://192.168.4.1/");
    server.send(302, "text/plain", "");
}

void ESPWebServer::handleNotFound() {
    setCorsHeaders();
    // In AP mode, redirect all unknown URLs to root (captive portal behavior)
    if (WiFiMgr.isAPMode()) {
        server.sendHeader("Location", "http://192.168.4.1/");
        server.send(302, "text/plain", "");
        return;
    }
    sendError(404, "Not found");
}

void ESPWebServer::handleGetConfig() {
    setCorsHeaders();
    JsonDocument doc;

    doc["wifi_ssid"] = Config.getString(WiFiUtils::KEY_SSID);
    doc["backend_host"] = getConfigStringOrDefault("backend_host", DEFAULT_BACKEND_HOST);
    doc["backend_port"] = Config.getInt("backend_port", DEFAULT_BACKEND_PORT);
    doc["backend_path"] = getConfigStringOrDefault("backend_path", DEFAULT_BACKEND_PATH);
    doc["render_base_url"] = getConfigStringOrDefault("render_base_url", DEFAULT_RENDER_BASE_URL);
    doc["device_name"] = Config.getString("device_name", "Boardsesh Controller");
    doc["brightness"] = Config.getInt("brightness", 128);
    doc["display_brightness"] = Config.getInt("disp_br", 128);
    doc["display_mode"] = Config.getInt("disp_mode", 0);
    doc["backend_sync_enabled"] = Config.getBool("backend_sync", false);
    doc["session_id"] = Config.getString("session_id");
    doc["api_key"] = Config.getString("api_key");
    doc["preview_board_name"] = getConfigStringOrDefault("preview_board_name", DEFAULT_PREVIEW_BOARD_NAME);
    doc["preview_layout_id"] = Config.getInt("preview_layout_id", DEFAULT_PREVIEW_LAYOUT_ID);
    doc["preview_size_id"] = Config.getInt("preview_size_id", DEFAULT_PREVIEW_SIZE_ID);
    doc["preview_set_ids"] = getConfigStringOrDefault("preview_set_ids", DEFAULT_PREVIEW_SET_IDS);
    doc["proxy_enabled"] = Config.getBool("proxy_en", false);
    doc["proxy_mac"] = Config.getString("proxy_mac");

    sendJson(200, doc);
}

void ESPWebServer::handleGetStatus() {
    setCorsHeaders();
    JsonDocument doc;

    doc["configured_backend_host"] = getConfigStringOrDefault("backend_host", DEFAULT_BACKEND_HOST);
    doc["configured_backend_port"] = Config.getInt("backend_port", DEFAULT_BACKEND_PORT);
    doc["configured_backend_path"] = getConfigStringOrDefault("backend_path", DEFAULT_BACKEND_PATH);
    doc["render_base_url"] = getConfigStringOrDefault("render_base_url", DEFAULT_RENDER_BASE_URL);
    doc["backend_sync_enabled"] = Config.getBool("backend_sync", false);
    doc["preview_board_name"] = getConfigStringOrDefault("preview_board_name", DEFAULT_PREVIEW_BOARD_NAME);
    doc["preview_layout_id"] = Config.getInt("preview_layout_id", DEFAULT_PREVIEW_LAYOUT_ID);
    doc["preview_size_id"] = Config.getInt("preview_size_id", DEFAULT_PREVIEW_SIZE_ID);
    doc["preview_set_ids"] = getConfigStringOrDefault("preview_set_ids", DEFAULT_PREVIEW_SET_IDS);

    if (statusProvider) {
        statusProvider(doc);
    }

    sendJson(200, doc);
}

void ESPWebServer::handleSetConfig() {
    setCorsHeaders();

    if (!server.hasArg("plain")) {
        sendError(400, "No body provided");
        return;
    }

    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, server.arg("plain"));

    if (error) {
        sendError(400, "Invalid JSON");
        return;
    }

    if (doc["backend_host"].is<const char*>()) {
        String backendHost = doc["backend_host"].as<const char*>();
        backendHost.trim();
        if (backendHost.length() == 0) {
            Config.remove("backend_host");
        } else {
            Config.setString("backend_host", backendHost);
        }
    }
    if (doc["backend_port"].is<int>()) {
        int backendPort = doc["backend_port"].as<int>();
        if (backendPort <= 0) {
            Config.remove("backend_port");
        } else {
            Config.setInt("backend_port", backendPort);
        }
    }
    if (doc["backend_path"].is<const char*>()) {
        String backendPath = doc["backend_path"].as<const char*>();
        backendPath.trim();
        if (backendPath.length() == 0) {
            Config.remove("backend_path");
        } else {
            Config.setString("backend_path", backendPath);
        }
    }
    if (doc["render_base_url"].is<const char*>()) {
        String renderBaseUrl = doc["render_base_url"].as<const char*>();
        renderBaseUrl.trim();
        if (renderBaseUrl.length() == 0) {
            Config.remove("render_base_url");
        } else {
            Config.setString("render_base_url", renderBaseUrl);
        }
    }
    if (doc["device_name"].is<const char*>()) {
        Config.setString("device_name", doc["device_name"]);
    }
    if (doc["brightness"].is<int>()) {
        Config.setInt("brightness", doc["brightness"]);
    }
    if (doc["session_id"].is<const char*>()) {
        Config.setString("session_id", doc["session_id"]);
    }
    if (doc["api_key"].is<const char*>()) {
        Config.setString("api_key", doc["api_key"]);
    }
    if (doc["display_brightness"].is<int>()) {
        Config.setInt("disp_br", doc["display_brightness"]);
    }
    if (doc["display_mode"].is<int>()) {
        Config.setInt("disp_mode", doc["display_mode"]);
    }
    if (doc["backend_sync_enabled"].is<bool>()) {
        Config.setBool("backend_sync", doc["backend_sync_enabled"].as<bool>());
    }
    if (doc["preview_board_name"].is<const char*>()) {
        String previewBoardName = doc["preview_board_name"].as<const char*>();
        previewBoardName.trim();
        if (previewBoardName.length() == 0) {
            Config.remove("preview_board_name");
        } else {
            Config.setString("preview_board_name", previewBoardName);
        }
    }
    if (doc["preview_layout_id"].is<int>()) {
        int previewLayoutId = doc["preview_layout_id"].as<int>();
        if (previewLayoutId <= 0) {
            Config.remove("preview_layout_id");
        } else {
            Config.setInt("preview_layout_id", previewLayoutId);
        }
    }
    if (doc["preview_size_id"].is<int>()) {
        int previewSizeId = doc["preview_size_id"].as<int>();
        if (previewSizeId <= 0) {
            Config.remove("preview_size_id");
        } else {
            Config.setInt("preview_size_id", previewSizeId);
        }
    }
    if (doc["preview_set_ids"].is<const char*>()) {
        String previewSetIds = doc["preview_set_ids"].as<const char*>();
        previewSetIds.trim();
        if (previewSetIds.length() == 0) {
            Config.remove("preview_set_ids");
        } else {
            Config.setString("preview_set_ids", previewSetIds);
        }
    }
    if (doc["proxy_enabled"].is<bool>()) {
        Config.setBool("proxy_en", doc["proxy_enabled"].as<bool>());
    }
    if (doc["proxy_mac"].is<const char*>()) {
        Config.setString("proxy_mac", doc["proxy_mac"]);
    }

    sendJson(200, "{\"success\":true}");
}

void ESPWebServer::handleWiFiScan() {
    setCorsHeaders();

    int n = WiFi.scanNetworks();
    JsonDocument doc;
    JsonArray networks = doc["networks"].to<JsonArray>();

    for (int i = 0; i < n; i++) {
        JsonObject network = networks.add<JsonObject>();
        network["ssid"] = WiFi.SSID(i);
        network["rssi"] = WiFi.RSSI(i);
        network["secure"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
    }

    WiFi.scanDelete();
    sendJson(200, doc);
}

void ESPWebServer::handleWiFiConnect() {
    setCorsHeaders();

    if (!server.hasArg("plain")) {
        sendError(400, "No body provided");
        return;
    }

    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, server.arg("plain"));

    if (error) {
        sendError(400, "Invalid JSON");
        return;
    }

    if (!doc["ssid"].is<const char*>()) {
        sendError(400, "SSID required");
        return;
    }

    const char* ssid = doc["ssid"];
    const char* password = doc["password"] | "";

    // Stop AP mode if running before connecting to a new network
    if (WiFiMgr.isAPMode()) {
        WiFiMgr.stopAP();
    }

    WiFiMgr.connect(ssid, password);

    sendJson(200, "{\"success\":true,\"message\":\"Connecting...\"}");
}

void ESPWebServer::handleWiFiStatus() {
    setCorsHeaders();
    JsonDocument doc;

    doc["connected"] = WiFiMgr.isConnected();
    doc["ap_mode"] = WiFiMgr.isAPMode();
    doc["ssid"] = WiFiMgr.isAPMode() ? "" : WiFiMgr.getSSID();
    doc["ip"] = WiFiMgr.isAPMode() ? WiFiMgr.getAPIP() : WiFiMgr.getIP();
    doc["rssi"] = WiFiMgr.isAPMode() ? 0 : WiFiMgr.getRSSI();

    sendJson(200, doc);
}

void ESPWebServer::handleRestart() {
    setCorsHeaders();
    sendJson(200, "{\"success\":true,\"message\":\"Restarting...\"}");
    delay(500);
    ESP.restart();
}

void ESPWebServer::handleFirmwareVersion() {
    setCorsHeaders();
    JsonDocument doc;
    doc["version"] = FIRMWARE_VERSION;
    doc["build_env"] = FIRMWARE_BUILD_ENV;
    sendJson(200, doc);
}

void ESPWebServer::handleFirmwareUploadData() {
    HTTPUpload& upload = server.upload();

    switch (upload.status) {
        case UPLOAD_FILE_START: {
            Serial.printf("Firmware upload start: %s\n", upload.filename.c_str());
            _otaInProgress = true;
            _otaBytesWritten = 0;
            _otaError = false;
            _otaErrorMessage = "";

            // Server-side file extension validation
            String fname = upload.filename;
            if (fname.length() == 0) {
                _otaError = true;
                _otaErrorMessage = "No filename provided";
                Serial.println("Firmware upload rejected: empty filename");
                break;
            }
            if (fname.length() < 4 || fname.substring(fname.length() - 4) != ".bin") {
                _otaError = true;
                _otaErrorMessage = "Invalid file type: firmware must be a .bin file";
                Serial.println("Firmware upload rejected: not a .bin file");
                break;
            }

            // Use totalSize for upfront partition size validation when available
            size_t updateSize = upload.totalSize > 0 ? upload.totalSize : UPDATE_SIZE_UNKNOWN;
            if (!Update.begin(updateSize)) {
                _otaError = true;
                _otaErrorMessage = "Failed to begin update";
                Serial.println("Update.begin() failed");
            }
            break;
        }

        case UPLOAD_FILE_WRITE:
            if (!_otaError) {
                size_t written = Update.write(upload.buf, upload.currentSize);
                if (written != upload.currentSize) {
                    _otaError = true;
                    _otaErrorMessage = "Write failed";
                    Serial.printf("Update.write() failed: wrote %u of %u\n",
                                  (unsigned)written, (unsigned)upload.currentSize);
                } else {
                    _otaBytesWritten += written;
                }
            }
            break;

        case UPLOAD_FILE_END:
            if (!_otaError) {
                if (Update.end(true)) {
                    Serial.printf("Firmware upload complete: %u bytes\n", (unsigned)_otaBytesWritten);
                } else {
                    _otaError = true;
                    _otaErrorMessage = "Failed to finalize update";
                    Serial.println("Update.end() failed");
                }
            } else {
                // Clean up: abort the in-progress update to avoid resource leak
                Update.abort();
            }
            _otaInProgress = false;
            break;

        case UPLOAD_FILE_ABORTED:
            Update.abort();
            _otaError = true;
            _otaErrorMessage = "Upload aborted";
            _otaInProgress = false;
            Serial.println("Firmware upload aborted");
            break;
    }
}

void ESPWebServer::handleFirmwareUploadComplete() {
    setCorsHeaders();

    if (_otaError) {
        JsonDocument doc;
        doc["success"] = false;
        doc["error"] = _otaErrorMessage;
        sendJson(500, doc);
        return;
    }

    JsonDocument doc;
    doc["success"] = true;
    doc["bytes_written"] = (unsigned int)_otaBytesWritten;
    doc["message"] = "Firmware updated successfully. Rebooting...";
    sendJson(200, doc);

    delay(1000);
    ESP.restart();
}
