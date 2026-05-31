#include <Arduino.h>
#include <ArduinoJson.h>

#include <config_manager.h>
#include <esp_web_server.h>
#include <led_controller.h>
#include <log_buffer.h>
#include <moonboard_uart_ble.h>
#include <wifi_utils.h>

#include "config/board_config.h"

namespace {

constexpr const char* CONFIG_KEY_LAYOUT_ID = "mb_layout_id";
constexpr const char* CONFIG_KEY_SIZE_ID = "mb_size_id";
constexpr const char* CONFIG_KEY_SET_IDS = "mb_set_ids";
constexpr const char* CONFIG_KEY_DEVICE_NAME = "device_name";

struct SetOption {
    int id;
    const char* name;
};

struct LayoutOption {
    int id;
    const char* name;
    const SetOption* sets;
    size_t setCount;
};

const SetOption LAYOUT_2010_SETS[] = {
    {1, "Original School Holds"},
};

const SetOption LAYOUT_2016_SETS[] = {
    {2, "Hold Set A"},
    {3, "Hold Set B"},
    {4, "Original School Holds"},
};

const SetOption LAYOUT_2024_SETS[] = {
    {5, "Hold Set D"},
    {6, "Hold Set E"},
    {7, "Hold Set F"},
    {8, "Wooden Holds"},
    {9, "Wooden Holds B"},
    {10, "Wooden Holds C"},
};

const SetOption LAYOUT_MASTERS_2017_SETS[] = {
    {11, "Hold Set A"},
    {12, "Hold Set B"},
    {13, "Hold Set C"},
    {14, "Original School Holds"},
    {15, "Screw-on Feet"},
    {16, "Wooden Holds"},
};

const SetOption LAYOUT_MASTERS_2019_SETS[] = {
    {17, "Hold Set A"},
    {18, "Hold Set B"},
    {19, "Original School Holds"},
    {20, "Screw-on Feet"},
    {21, "Wooden Holds"},
    {22, "Wooden Holds B"},
    {23, "Wooden Holds C"},
};

const LayoutOption AVAILABLE_LAYOUTS[] = {
    {1, "MoonBoard 2010", LAYOUT_2010_SETS, sizeof(LAYOUT_2010_SETS) / sizeof(SetOption)},
    {2, "MoonBoard 2016", LAYOUT_2016_SETS, sizeof(LAYOUT_2016_SETS) / sizeof(SetOption)},
    {3, "MoonBoard 2024", LAYOUT_2024_SETS, sizeof(LAYOUT_2024_SETS) / sizeof(SetOption)},
    {4, "MoonBoard Masters 2017", LAYOUT_MASTERS_2017_SETS, sizeof(LAYOUT_MASTERS_2017_SETS) / sizeof(SetOption)},
    {5, "MoonBoard Masters 2019", LAYOUT_MASTERS_2019_SETS, sizeof(LAYOUT_MASTERS_2019_SETS) / sizeof(SetOption)},
};

struct MoonBoardUiConfig {
    int layoutId;
    int sizeId;
    String setIdsCsv;
    String deviceName;
};

bool g_wifiConnected = false;
bool g_bleConnected = false;
unsigned long g_problemRevision = 0;
unsigned long g_lastProblemUpdateMs = 0;
MoonBoardDecodedProblem g_lastProblem;

const LayoutOption* findLayoutOption(int layoutId) {
    for (const LayoutOption& layout : AVAILABLE_LAYOUTS) {
        if (layout.id == layoutId) {
            return &layout;
        }
    }
    return nullptr;
}

String buildDefaultSetIdsCsv(int layoutId) {
    const LayoutOption* layout = findLayoutOption(layoutId);
    if (!layout || layout->setCount == 0) {
        return DEFAULT_SET_IDS;
    }

    String result;
    for (size_t i = 0; i < layout->setCount; i++) {
        if (i > 0) {
            result += ",";
        }
        result += String(layout->sets[i].id);
    }
    return result;
}

bool layoutAllowsSetId(const LayoutOption* layout, int setId) {
    if (!layout) {
        return false;
    }

    for (size_t i = 0; i < layout->setCount; i++) {
        if (layout->sets[i].id == setId) {
            return true;
        }
    }

    return false;
}

String sanitizeSetIdsCsv(int layoutId, const String& requestedCsv) {
    const LayoutOption* layout = findLayoutOption(layoutId);
    if (!layout) {
        return buildDefaultSetIdsCsv(DEFAULT_LAYOUT_ID);
    }

    String sanitized;
    bool usedIds[32] = {false};
    int tokenStart = 0;

    while (tokenStart <= requestedCsv.length()) {
        int tokenEnd = requestedCsv.indexOf(',', tokenStart);
        if (tokenEnd < 0) {
            tokenEnd = requestedCsv.length();
        }

        if (tokenEnd > tokenStart) {
            const int setId = requestedCsv.substring(tokenStart, tokenEnd).toInt();
            if (setId > 0 && setId < 32 && !usedIds[setId] && layoutAllowsSetId(layout, setId)) {
                if (sanitized.length() > 0) {
                    sanitized += ",";
                }
                sanitized += String(setId);
                usedIds[setId] = true;
            }
        }

        tokenStart = tokenEnd + 1;
    }

    if (sanitized.length() == 0) {
        return buildDefaultSetIdsCsv(layoutId);
    }

    return sanitized;
}

MoonBoardUiConfig loadMoonBoardConfig() {
    MoonBoardUiConfig config;
    config.layoutId = Config.getInt(CONFIG_KEY_LAYOUT_ID, DEFAULT_LAYOUT_ID);
    if (!findLayoutOption(config.layoutId)) {
        config.layoutId = DEFAULT_LAYOUT_ID;
    }
    config.sizeId = Config.getInt(CONFIG_KEY_SIZE_ID, DEFAULT_SIZE_ID);
    config.setIdsCsv = sanitizeSetIdsCsv(
        config.layoutId,
        Config.getString(CONFIG_KEY_SET_IDS, buildDefaultSetIdsCsv(config.layoutId))
    );
    config.deviceName = Config.getString(CONFIG_KEY_DEVICE_NAME, DEFAULT_BLE_DEVICE_NAME);
    if (config.deviceName.length() == 0) {
        config.deviceName = DEFAULT_BLE_DEVICE_NAME;
    }
    return config;
}

void storeMoonBoardConfig(const MoonBoardUiConfig& config) {
    Config.setInt(CONFIG_KEY_LAYOUT_ID, config.layoutId);
    Config.setInt(CONFIG_KEY_SIZE_ID, config.sizeId);
    Config.setString(CONFIG_KEY_SET_IDS, config.setIdsCsv);
    Config.setString(CONFIG_KEY_DEVICE_NAME, config.deviceName);
}

void onWiFiStateChange(WiFiConnectionState state) {
    g_wifiConnected = state == WiFiConnectionState::CONNECTED;
}

void onBleConnect(bool connected) {
    g_bleConnected = connected;
}

void onMoonBoardProblem(const MoonBoardDecodedProblem& problem) {
    g_lastProblem = problem;
    g_problemRevision++;
    g_lastProblemUpdateMs = millis();
}

void handleMoonBoardPage(WebServer& server) {
    server.send(200, "text/html", R"rawliteral(
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MoonBoard Dev Server</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #101820; color: #f1f5f9; }
    main { max-width: 1100px; margin: 0 auto; padding: 24px 18px 40px; }
    h1 { margin: 0 0 6px; color: #ffe066; }
    .subtitle { color: #9fb3c8; margin: 0 0 24px; }
    .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
    .card { background: #17212b; border: 1px solid #243241; border-radius: 16px; padding: 18px; }
    .card h2 { margin-top: 0; color: #ffe066; font-size: 1rem; }
    label { display: block; font-size: 0.88rem; color: #b8cadc; margin-bottom: 6px; }
    select, input, button { width: 100%; border-radius: 10px; border: 1px solid #314557; padding: 11px 12px; font-size: 15px; }
    select, input { background: #0f1720; color: #f1f5f9; margin-bottom: 14px; }
    button { background: #ffe066; color: #101820; font-weight: 700; cursor: pointer; }
    button.secondary { background: #243241; color: #f1f5f9; }
    .status-row { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
    .pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 8px 12px; font-size: 0.88rem; border: 1px solid #314557; background: #101820; }
    .pill.on { border-color: #1fb36a; color: #9df0c1; }
    .pill.off { border-color: #8a3d4f; color: #f0a5b6; }
    .sets { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 14px; }
    .set-option { background: #0f1720; border: 1px solid #314557; border-radius: 10px; padding: 10px; display: flex; align-items: center; gap: 8px; }
    .set-option input { width: auto; margin: 0; }
    .preview-wrap { background: linear-gradient(180deg, #1f2933 0%, #0b1117 100%); border-radius: 16px; min-height: 320px; display: flex; align-items: center; justify-content: center; overflow: hidden; border: 1px solid #243241; }
    .preview-wrap img { width: 100%; height: auto; display: block; }
    pre { background: #0f1720; border: 1px solid #243241; border-radius: 12px; padding: 12px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
    .meta { color: #9fb3c8; font-size: 0.85rem; }
    .actions { display: flex; gap: 10px; }
    .actions > * { flex: 1; }
    .msg { display: none; margin-top: 10px; padding: 10px 12px; border-radius: 10px; }
    .msg.show { display: block; }
    .msg.ok { background: rgba(31, 179, 106, 0.18); border: 1px solid #1fb36a; }
    .msg.error { background: rgba(211, 73, 110, 0.18); border: 1px solid #d3496e; }
    a { color: #8fd3ff; }
    @media (max-width: 700px) { .actions { flex-direction: column; } }
  </style>
</head>
<body>
  <main>
    <h1>MoonBoard Dev Server</h1>
    <p class="subtitle">Live BLE decode, local diagnostics, and remote Boardsesh preview rendering.</p>

    <div class="grid">
      <section class="card">
        <h2>Controller State</h2>
        <div class="status-row">
          <div id="bleStatus" class="pill off">BLE disconnected</div>
          <div id="wifiStatus" class="pill off">WiFi disconnected</div>
        </div>
        <div class="meta" id="updateMeta">Waiting for payload</div>
      </section>

      <section class="card">
        <h2>Board Preview Config</h2>
        <label for="deviceName">BLE device name</label>
        <input id="deviceName" type="text" placeholder="MoonBoard A">

        <label for="layoutId">Layout</label>
        <select id="layoutId"></select>

        <label for="sizeId">Size</label>
        <select id="sizeId">
          <option value="1">Standard</option>
        </select>

        <label>Hold sets</label>
        <div id="setOptions" class="sets"></div>

        <div class="actions">
          <button id="saveBtn">Save Preview Config</button>
          <button id="refreshBtn" class="secondary">Refresh State</button>
        </div>
        <div id="message" class="msg"></div>
        <p class="meta">Preview requests are fetched directly from <code>www.boardsesh.com</code>. BLE name changes take effect after restart.</p>
      </section>
    </div>

    <section class="card" style="margin-top: 18px;">
      <h2>Rendered Board</h2>
      <div class="preview-wrap">
        <img id="previewImage" alt="MoonBoard preview" style="display:none;">
        <div id="previewPlaceholder" class="meta">Waiting for a decoded payload.</div>
      </div>
    </section>

    <div class="grid" style="margin-top: 18px;">
      <section class="card">
        <h2>Frames</h2>
        <pre id="framesOutput"></pre>
      </section>
      <section class="card">
        <h2>Raw Payload</h2>
        <pre id="payloadOutput"></pre>
      </section>
    </div>

    <section class="card" style="margin-top: 18px;">
      <h2>Links</h2>
      <p class="meta"><a href="/">Open the generic controller config page</a></p>
    </section>
  </main>

  <script>
    const LAYOUTS = [
      { id: 1, name: 'MoonBoard 2010', sets: [{ id: 1, name: 'Original School Holds' }] },
      { id: 2, name: 'MoonBoard 2016', sets: [{ id: 2, name: 'Hold Set A' }, { id: 3, name: 'Hold Set B' }, { id: 4, name: 'Original School Holds' }] },
      { id: 3, name: 'MoonBoard 2024', sets: [{ id: 5, name: 'Hold Set D' }, { id: 6, name: 'Hold Set E' }, { id: 7, name: 'Hold Set F' }, { id: 8, name: 'Wooden Holds' }, { id: 9, name: 'Wooden Holds B' }, { id: 10, name: 'Wooden Holds C' }] },
      { id: 4, name: 'MoonBoard Masters 2017', sets: [{ id: 11, name: 'Hold Set A' }, { id: 12, name: 'Hold Set B' }, { id: 13, name: 'Hold Set C' }, { id: 14, name: 'Original School Holds' }, { id: 15, name: 'Screw-on Feet' }, { id: 16, name: 'Wooden Holds' }] },
      { id: 5, name: 'MoonBoard Masters 2019', sets: [{ id: 17, name: 'Hold Set A' }, { id: 18, name: 'Hold Set B' }, { id: 19, name: 'Original School Holds' }, { id: 20, name: 'Screw-on Feet' }, { id: 21, name: 'Wooden Holds' }, { id: 22, name: 'Wooden Holds B' }, { id: 23, name: 'Wooden Holds C' }] },
    ];

    let currentConfig = null;
    let currentState = null;

    const layoutSelect = document.getElementById('layoutId');
    const sizeSelect = document.getElementById('sizeId');
    const deviceNameInput = document.getElementById('deviceName');
    const setOptions = document.getElementById('setOptions');
    const bleStatus = document.getElementById('bleStatus');
    const wifiStatus = document.getElementById('wifiStatus');
    const updateMeta = document.getElementById('updateMeta');
    const previewImage = document.getElementById('previewImage');
    const previewPlaceholder = document.getElementById('previewPlaceholder');
    const framesOutput = document.getElementById('framesOutput');
    const payloadOutput = document.getElementById('payloadOutput');
    const message = document.getElementById('message');

    function showMessage(text, isError = false) {
      message.textContent = text;
      message.className = `msg show ${isError ? 'error' : 'ok'}`;
      clearTimeout(showMessage._timer);
      showMessage._timer = setTimeout(() => {
        message.className = 'msg';
      }, 4000);
    }

    function renderLayoutOptions(selectedLayoutId) {
      layoutSelect.innerHTML = '';
      LAYOUTS.forEach((layout) => {
        const option = document.createElement('option');
        option.value = String(layout.id);
        option.textContent = layout.name;
        option.selected = layout.id === selectedLayoutId;
        layoutSelect.appendChild(option);
      });
    }

    function getSelectedSetIds() {
      return Array.from(document.querySelectorAll('input[name="setId"]:checked')).map((input) => Number(input.value));
    }

    function renderSetOptions(layoutId, selectedSetIds) {
      const layout = LAYOUTS.find((entry) => entry.id === layoutId) || LAYOUTS[0];
      setOptions.innerHTML = '';
      layout.sets.forEach((set) => {
        const label = document.createElement('label');
        label.className = 'set-option';
        label.innerHTML = `<input type="checkbox" name="setId" value="${set.id}"><span>${set.name}</span>`;
        label.querySelector('input').checked = selectedSetIds.length ? selectedSetIds.includes(set.id) : true;
        setOptions.appendChild(label);
      });
    }

    function buildPreviewUrl() {
      if (!currentConfig || !currentState || !currentState.frames) {
        return null;
      }

      const params = new URLSearchParams({
        board_name: 'moonboard',
        layout_id: String(currentConfig.layout_id),
        size_id: String(currentConfig.size_id),
        set_ids: currentConfig.set_ids.join(','),
        frames: currentState.frames,
        thumbnail: '1',
        include_background: '1',
        revision: String(currentState.revision || 0),
      });

      return `https://www.boardsesh.com/api/internal/board-render?${params.toString()}`;
    }

    function syncPreview() {
      const previewUrl = buildPreviewUrl();
      framesOutput.textContent = currentState?.frames || 'No payload decoded yet.';
      payloadOutput.textContent = currentState?.raw_payload || 'No payload decoded yet.';

      if (!previewUrl) {
        previewImage.style.display = 'none';
        previewPlaceholder.style.display = 'block';
        previewPlaceholder.textContent = 'Waiting for a decoded payload.';
        return;
      }

      previewImage.src = previewUrl;
      previewImage.style.display = 'block';
      previewPlaceholder.style.display = 'none';
    }

    function syncStatus() {
      if (!currentState) {
        return;
      }

      bleStatus.textContent = currentState.ble_connected ? 'BLE connected' : 'BLE disconnected';
      bleStatus.className = `pill ${currentState.ble_connected ? 'on' : 'off'}`;

      const mdnsHost = currentState.mdns_hostname ? `${currentState.mdns_hostname}.local` : null;
      const wifiText = currentState.ap_mode
        ? `AP mode · ${currentState.ip || '192.168.4.1'}`
        : currentState.wifi_connected
          ? `WiFi connected · ${mdnsHost || currentState.ip || 'no IP'}`
          : 'WiFi disconnected';
      wifiStatus.textContent = wifiText;
      wifiStatus.className = `pill ${(currentState.ap_mode || currentState.wifi_connected) ? 'on' : 'off'}`;

      if (currentState.last_update_ms) {
        updateMeta.textContent = `Last payload revision ${currentState.revision} at ${currentState.last_update_ms} ms`;
      } else {
        updateMeta.textContent = 'Waiting for payload';
      }
    }

    async function loadConfig() {
      const response = await fetch('/api/moonboard/config');
      currentConfig = await response.json();
      deviceNameInput.value = currentConfig.device_name || '';
      renderLayoutOptions(currentConfig.layout_id);
      sizeSelect.value = String(currentConfig.size_id || 1);
      renderSetOptions(currentConfig.layout_id, currentConfig.set_ids || []);
    }

    async function loadState() {
      const response = await fetch('/api/moonboard/state');
      currentState = await response.json();
      syncStatus();
      syncPreview();
    }

    async function saveConfig() {
      const nextConfig = {
        device_name: deviceNameInput.value.trim(),
        layout_id: Number(layoutSelect.value),
        size_id: Number(sizeSelect.value),
        set_ids: getSelectedSetIds(),
      };

      if (nextConfig.set_ids.length === 0) {
        showMessage('Select at least one hold set.', true);
        return;
      }

      const response = await fetch('/api/moonboard/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextConfig),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: 'Failed to save config' }));
        showMessage(body.error || 'Failed to save config', true);
        return;
      }

      await loadConfig();
      syncPreview();
      showMessage('Preview config saved.');
    }

    layoutSelect.addEventListener('change', () => {
      const layoutId = Number(layoutSelect.value);
      renderSetOptions(layoutId, []);
    });

    document.getElementById('saveBtn').addEventListener('click', saveConfig);
    document.getElementById('refreshBtn').addEventListener('click', loadState);

    Promise.all([loadConfig(), loadState()]).catch((error) => {
      console.error(error);
      showMessage('Failed to load MoonBoard page data.', true);
    });

    setInterval(loadState, 1500);
  </script>
</body>
</html>
)rawliteral");
}

void handleGetMoonBoardConfig(WebServer& server) {
    const MoonBoardUiConfig config = loadMoonBoardConfig();

    JsonDocument doc;
    doc["layout_id"] = config.layoutId;
    doc["size_id"] = config.sizeId;
    doc["device_name"] = config.deviceName;
    JsonArray setIds = doc["set_ids"].to<JsonArray>();

    int tokenStart = 0;
    while (tokenStart <= config.setIdsCsv.length()) {
        int tokenEnd = config.setIdsCsv.indexOf(',', tokenStart);
        if (tokenEnd < 0) {
            tokenEnd = config.setIdsCsv.length();
        }
        if (tokenEnd > tokenStart) {
            setIds.add(config.setIdsCsv.substring(tokenStart, tokenEnd).toInt());
        }
        tokenStart = tokenEnd + 1;
    }

    String response;
    serializeJson(doc, response);
    server.send(200, "application/json", response);
}

void handleSetMoonBoardConfig(WebServer& server) {
    if (!server.hasArg("plain")) {
        server.send(400, "application/json", "{\"error\":\"No body provided\"}");
        return;
    }

    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, server.arg("plain"));
    if (error) {
        server.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
        return;
    }

    MoonBoardUiConfig config = loadMoonBoardConfig();
    if (doc["layout_id"].is<int>()) {
        const int layoutId = doc["layout_id"].as<int>();
        if (findLayoutOption(layoutId)) {
            config.layoutId = layoutId;
        }
    }

    if (doc["size_id"].is<int>()) {
        config.sizeId = doc["size_id"].as<int>();
    }

    if (doc["device_name"].is<const char*>()) {
        config.deviceName = doc["device_name"].as<const char*>();
        if (config.deviceName.length() == 0) {
            config.deviceName = DEFAULT_BLE_DEVICE_NAME;
        }
    }

    if (doc["set_ids"].is<JsonArray>()) {
        String setIdsCsv;
        bool first = true;
        for (JsonVariant setIdValue : doc["set_ids"].as<JsonArray>()) {
            const int setId = setIdValue.as<int>();
            if (setId <= 0) {
                continue;
            }
            if (!first) {
                setIdsCsv += ",";
            }
            setIdsCsv += String(setId);
            first = false;
        }
        config.setIdsCsv = sanitizeSetIdsCsv(config.layoutId, setIdsCsv);
    } else if (doc["set_ids"].is<const char*>()) {
        config.setIdsCsv = sanitizeSetIdsCsv(config.layoutId, doc["set_ids"].as<const char*>());
    } else {
        config.setIdsCsv = sanitizeSetIdsCsv(config.layoutId, config.setIdsCsv);
    }

    storeMoonBoardConfig(config);
    WiFiMgr.configureMdns(config.deviceName.c_str(), "boardsesh", WEB_SERVER_PORT, "moonboard-dev");
    server.send(200, "application/json", "{\"success\":true}");
}

void handleGetMoonBoardState(WebServer& server) {
    const MoonBoardUiConfig config = loadMoonBoardConfig();

    JsonDocument doc;
    doc["device_name"] = config.deviceName;
    doc["layout_id"] = config.layoutId;
    doc["size_id"] = config.sizeId;
    JsonArray setIds = doc["set_ids"].to<JsonArray>();
    int tokenStart = 0;
    while (tokenStart <= config.setIdsCsv.length()) {
        int tokenEnd = config.setIdsCsv.indexOf(',', tokenStart);
        if (tokenEnd < 0) {
            tokenEnd = config.setIdsCsv.length();
        }
        if (tokenEnd > tokenStart) {
            setIds.add(config.setIdsCsv.substring(tokenStart, tokenEnd).toInt());
        }
        tokenStart = tokenEnd + 1;
    }

    doc["ble_connected"] = g_bleConnected;
    doc["wifi_connected"] = g_wifiConnected;
    doc["ap_mode"] = WiFiMgr.isAPMode();
    doc["ip"] = WiFiMgr.isAPMode() ? WiFiMgr.getAPIP() : WiFiMgr.getIP();
    doc["mdns_hostname"] = WiFiMgr.getMdnsHostName();
    doc["revision"] = static_cast<uint32_t>(g_problemRevision);
    doc["last_update_ms"] = static_cast<uint32_t>(g_lastProblemUpdateMs);
    doc["frames"] = g_lastProblem.frames;
    doc["raw_payload"] = g_lastProblem.rawPayload;
    doc["problem_payload"] = g_lastProblem.problemPayload;
    doc["lights_above_holds"] = g_lastProblem.lightsAboveHolds;
    doc["hold_count"] = static_cast<uint32_t>(g_lastProblem.holds.size());

    String response;
    serializeJson(doc, response);
    server.send(200, "application/json", response);
}

void registerRoutes() {
    WebConfig.on("/moonboard", HTTP_GET, handleMoonBoardPage);
    WebConfig.on("/api/moonboard/config", HTTP_GET, handleGetMoonBoardConfig);
    WebConfig.on("/api/moonboard/config", HTTP_POST, handleSetMoonBoardConfig);
    WebConfig.on("/api/moonboard/state", HTTP_GET, handleGetMoonBoardState);
}

}  // namespace

void setup() {
    Serial.begin(115200);
    delay(1500);

    Logger.logln("=================================");
    Logger.logln("%s v%s", DEVICE_NAME, FIRMWARE_VERSION);
    Logger.logln("=================================");

    Config.begin();

    LEDs.begin(LED_PIN, NUM_LEDS);
    LEDs.setBrightness(Config.getInt("brightness", DEFAULT_BRIGHTNESS));
    LEDs.clear();
    LEDs.show();

    const MoonBoardUiConfig config = loadMoonBoardConfig();

    MoonBLE.begin(config.deviceName.c_str(), true);
    MoonBLE.setConnectCallback(onBleConnect);
    MoonBLE.setProblemCallback(onMoonBoardProblem);

    WiFiMgr.configureMdns(config.deviceName.c_str(), "boardsesh", WEB_SERVER_PORT, "moonboard-dev");
    WiFiMgr.begin();
    WiFiMgr.setStateCallback(onWiFiStateChange);
    if (!WiFiMgr.connectSaved()) {
        WiFiMgr.startAP();
    }

    WebConfig.begin();
    registerRoutes();

    Logger.logln("MoonBoard dev server ready");
}

void loop() {
    WiFiMgr.loop();
    MoonBLE.loop();
    WebConfig.loop();
}
