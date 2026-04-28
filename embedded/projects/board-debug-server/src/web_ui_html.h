#ifndef BOARD_DEBUG_WEB_UI_HTML_H
#define BOARD_DEBUG_WEB_UI_HTML_H

#include <pgmspace.h>

namespace board_debug {

// Single-page debug UI. Hydrates dropdowns from /api/options, posts to
// /api/config, polls /api/status. Plain HTML/CSS/JS — no frameworks. The page
// is intentionally functional, not pretty: this is a developer-only test rig.
const char DEBUG_INDEX_HTML[] PROGMEM = R"raw(<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Boardsesh Debug Rig</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: #0c1118; color: #e2ecf5; }
  main { max-width: 880px; margin: 0 auto; padding: 24px 18px 60px; }
  h1 { margin: 0 0 4px; color: #ffe066; font-size: 1.4rem; }
  p.lede { margin: 0 0 24px; color: #93a8bd; font-size: 0.92rem; }
  section.card { background: #131c26; border: 1px solid #25313f; border-radius: 14px;
                 padding: 18px; margin-bottom: 16px; }
  section.card h2 { margin: 0 0 12px; font-size: 1rem; color: #ffe066; }
  label { display: block; font-size: 0.82rem; color: #94a8bb; margin: 10px 0 4px; }
  select, input[type=text], input[type=number] {
    width: 100%; background: #0a121a; color: #e2ecf5; border: 1px solid #2c3a4a;
    border-radius: 8px; padding: 10px 11px; font-size: 14px;
  }
  .grid2 { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
  .pills { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px;
          border-radius: 999px; border: 1px solid #2c3a4a; background: #0a121a;
          font-size: 0.82rem; color: #93a8bd; }
  .pill.on { border-color: #1fb36a; color: #9df0c1; }
  .pill.off { border-color: #8a3d4f; color: #f0a5b6; }
  .sets { display: grid; grid-template-columns: repeat(auto-fit,minmax(150px,1fr));
          gap: 6px; margin-top: 6px; }
  .sets label { display: flex; align-items: center; gap: 6px; padding: 6px 8px;
                background: #0a121a; border: 1px solid #2c3a4a; border-radius: 8px;
                margin: 0; font-size: 0.84rem; color: #cad7e3; }
  .sets input { width: auto; }
  button { background: #ffe066; color: #0c1118; font-weight: 700; border: 0;
           border-radius: 10px; padding: 10px 14px; cursor: pointer; }
  button.secondary { background: #25313f; color: #e2ecf5; }
  .actions { display: flex; gap: 10px; margin-top: 16px; }
  pre { background: #0a121a; border: 1px solid #25313f; border-radius: 10px; padding: 10px;
        white-space: pre-wrap; word-break: break-all; font-size: 12px; color: #cad7e3; }
  .msg { display: none; margin-top: 10px; padding: 10px 12px; border-radius: 10px; }
  .msg.show { display: block; }
  .msg.ok { background: rgba(31,179,106,0.15); border: 1px solid #1fb36a; color: #b6f1cf; }
  .msg.err { background: rgba(211,73,110,0.15); border: 1px solid #d3496e; color: #f4b1c1; }
  .meta { color: #94a8bb; font-size: 0.84rem; }
  a { color: #8fd3ff; }
</style>
</head>
<body>
<main>
  <h1>Boardsesh Debug Rig</h1>
  <p class="lede">Pretend-board for testing the phone apps. Pick a board, save, then connect from the app.</p>

  <section class="card">
    <h2>Status</h2>
    <div class="pills">
      <span id="pillWifi" class="pill off">WiFi …</span>
      <span id="pillBle" class="pill off">BLE …</span>
      <span id="pillRender" class="pill">Render: idle</span>
    </div>
    <div class="meta" id="metaLine">Waiting for the app to connect.</div>
  </section>

  <section class="card">
    <h2>Board configuration</h2>
    <div class="grid2">
      <div>
        <label for="board">Board</label>
        <select id="board"></select>
      </div>
      <div>
        <label for="layout">Layout</label>
        <select id="layout"></select>
      </div>
      <div>
        <label for="size">Size</label>
        <select id="size"></select>
      </div>
      <div>
        <label for="angle">Angle</label>
        <input id="angle" type="number" min="0" max="70" step="5" />
      </div>
    </div>
    <label>Sets</label>
    <div id="sets" class="sets"></div>

    <label for="deviceName">BLE device name (advertised to the phone)</label>
    <input id="deviceName" type="text" placeholder="Kilter A1" />

    <label for="apiLevel">Aurora API level</label>
    <select id="apiLevel">
      <option value="3">v3 (default)</option>
      <option value="2">v2 (legacy)</option>
    </select>

    <div class="actions">
      <button id="save">Save &amp; restart BLE</button>
      <button id="restart" class="secondary">Restart device</button>
    </div>
    <div id="msg" class="msg"></div>
  </section>

  <section class="card">
    <h2>Last payload</h2>
    <div class="meta" id="lastMeta">No frames received yet.</div>
    <pre id="lastFrames"></pre>
    <div class="meta">Render URL:</div>
    <pre id="lastUrl"></pre>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
let CATALOG = null;
let CFG = null;

async function loadOptions() {
  const r = await fetch('/api/options');
  CATALOG = await r.json();
}

async function loadConfig() {
  const r = await fetch('/api/config');
  CFG = await r.json();
}

function findBoard(name) { return CATALOG.boards.find((b) => b.name === name); }
function findLayout(board, id) { return board.layouts.find((l) => l.id === id); }
function findSize(layout, id) { return layout.sizes.find((s) => s.id === id); }

function render() {
  const boardSel = $('board');
  boardSel.innerHTML = '';
  for (const b of CATALOG.boards) {
    const o = document.createElement('option');
    o.value = b.name; o.textContent = b.name;
    if (b.name === CFG.board) o.selected = true;
    boardSel.appendChild(o);
  }
  renderLayouts();
}

function renderLayouts() {
  const board = findBoard($('board').value);
  const layoutSel = $('layout');
  layoutSel.innerHTML = '';
  for (const l of board.layouts) {
    const o = document.createElement('option');
    o.value = String(l.id); o.textContent = l.name + ' (#' + l.id + ')';
    if (l.id === CFG.layout_id) o.selected = true;
    layoutSel.appendChild(o);
  }
  if (!board.layouts.find((l) => l.id === CFG.layout_id) && board.layouts[0]) {
    CFG.layout_id = board.layouts[0].id;
    layoutSel.value = String(CFG.layout_id);
  }
  renderSizes();
}

function renderSizes() {
  const board = findBoard($('board').value);
  const layout = findLayout(board, Number($('layout').value));
  const sizeSel = $('size');
  sizeSel.innerHTML = '';
  for (const s of layout.sizes) {
    const o = document.createElement('option');
    o.value = String(s.id);
    o.textContent = s.name + (s.description ? ' — ' + s.description : '') + ' (#' + s.id + ')';
    if (s.id === CFG.size_id) o.selected = true;
    sizeSel.appendChild(o);
  }
  if (!layout.sizes.find((s) => s.id === CFG.size_id) && layout.sizes[0]) {
    CFG.size_id = layout.sizes[0].id;
    sizeSel.value = String(CFG.size_id);
  }
  renderSets();
}

function renderSets() {
  const board = findBoard($('board').value);
  const layout = findLayout(board, Number($('layout').value));
  const size = findSize(layout, Number($('size').value));
  const wrap = $('sets');
  wrap.innerHTML = '';
  const selected = new Set(CFG.set_ids || []);
  for (const s of size.sets) {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = String(s.id);
    cb.checked = selected.has(s.id) || selected.size === 0;
    lbl.appendChild(cb);
    const txt = document.createElement('span');
    txt.textContent = s.name + ' (#' + s.id + ')';
    lbl.appendChild(txt);
    wrap.appendChild(lbl);
  }
}

function collectSelectedSets() {
  return [...document.querySelectorAll('#sets input:checked')].map((el) => Number(el.value));
}

async function save() {
  const body = {
    board: $('board').value,
    layout_id: Number($('layout').value),
    size_id: Number($('size').value),
    set_ids: collectSelectedSets(),
    angle: Number($('angle').value),
    device_name: $('deviceName').value.trim(),
    api_level: Number($('apiLevel').value),
  };
  const r = await fetch('/api/config', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  const m = $('msg');
  if (r.ok) {
    m.className = 'msg show ok';
    m.textContent = 'Saved. Restarting BLE so the phone sees the new device name.';
  } else {
    const err = await r.text();
    m.className = 'msg show err';
    m.textContent = 'Save failed: ' + err;
  }
  setTimeout(() => { m.className = 'msg'; }, 5000);
  await loadConfig();
}

async function refreshStatus() {
  try {
    const r = await fetch('/api/status');
    const s = await r.json();
    const wifi = $('pillWifi');
    wifi.textContent = s.wifi_connected ? ('WiFi ' + (s.ip || '?')) : (s.ap_mode ? 'AP mode' : 'WiFi off');
    wifi.className = 'pill ' + (s.wifi_connected ? 'on' : 'off');
    const ble = $('pillBle');
    ble.textContent = s.ble_connected ? 'BLE connected' : 'BLE waiting';
    ble.className = 'pill ' + (s.ble_connected ? 'on' : 'off');
    const ren = $('pillRender');
    ren.textContent = 'Render: ' + (s.last_render_outcome || 'idle');
    ren.className = 'pill ' + (s.last_render_outcome === 'ok' ? 'on' : (s.last_render_outcome && s.last_render_outcome !== 'none' ? 'off' : ''));
    $('metaLine').textContent = s.connected_mac ? ('Connected to ' + s.connected_mac) : 'Waiting for the app to connect.';
    $('lastFrames').textContent = s.last_frames || '(none)';
    $('lastUrl').textContent = s.last_render_url || '(none)';
    $('lastMeta').textContent = s.last_frames_at_ms
      ? ('Frames received ' + Math.max(0, Math.floor((Date.now() - s.now + s.last_frames_at_ms))) + 'ms ago, render: ' + (s.last_render_outcome || 'pending'))
      : 'No frames received yet.';
  } catch (e) {
    // network blip; try again next tick.
  }
}

async function main() {
  await loadOptions();
  await loadConfig();
  $('deviceName').value = CFG.device_name || '';
  $('angle').value = String(CFG.angle ?? 40);
  $('apiLevel').value = String(CFG.api_level || 3);
  render();
  $('board').addEventListener('change', () => { CFG.layout_id = -1; renderLayouts(); });
  $('layout').addEventListener('change', () => { CFG.size_id = -1; renderSizes(); });
  $('size').addEventListener('change', renderSets);
  $('save').addEventListener('click', save);
  $('restart').addEventListener('click', async () => {
    await fetch('/api/restart', { method: 'POST' });
  });
  refreshStatus();
  setInterval(refreshStatus, 2000);
}
main();
</script>
</body>
</html>)raw";

}  // namespace board_debug

#endif
