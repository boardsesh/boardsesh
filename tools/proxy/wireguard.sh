#!/usr/bin/env bash
# Capture a PHYSICAL phone's traffic with mitmproxy in WireGuard mode.
#
# Why this and not start.sh (HTTP proxy)? Apps that don't honor the system HTTP
# proxy — Firebase Firestore (gRPC/HTTP2), Realtime Database (WebSocket), and most
# native SDKs — are invisible to an HTTP proxy. WireGuard mode intercepts at the IP
# layer, so EVERYTHING the phone sends is captured. No pfctl, no IP forwarding, no
# gateway hacks. The phone just needs the free WireGuard app.
#
# Usage:
#   ./tools/proxy/wireguard.sh start   # launch + write/open the client config & QR
#   ./tools/proxy/wireguard.sh qr      # re-open the QR for the running instance
#   ./tools/proxy/wireguard.sh stop    # stop it
#
# Web UI: http://localhost:9091 (save flows from there: toolbar → download).
#
# Deps: mitmproxy + qrencode (brew install mitmproxy qrencode).

set -euo pipefail

WG_PORT=51820                                   # UDP port the phone's WireGuard tunnel hits
WEB_PORT=9091                                   # mitmweb UI (localhost only)
KEYFILE="$HOME/.mitmproxy/wireguard.conf"       # server key material (auto-created)
CERT="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
LOG="/tmp/mitmweb-wg.log"
PIDFILE="/tmp/mitmweb-wg.pid"
CLIENT_CONF="/tmp/wg-client.conf"
QR_PNG="/tmp/wg-qr.png"

lan_ip() { ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "<your-mac-LAN-IP>"; }

# mitmweb does NOT print the WireGuard client config to the console (it only shows
# it in the web UI). mitmdump DOES. So we briefly run mitmdump against the same
# keyfile to capture the config, then rewrite its 0.0.0.0 Endpoint to our LAN IP.
build_client_conf() {
  local raw="/tmp/wg-raw.txt"
  mitmdump --mode "wireguard:$KEYFILE" --listen-host 0.0.0.0 --listen-port "$WG_PORT" >"$raw" 2>&1 &
  local md=$!
  sleep 4
  kill "$md" 2>/dev/null; wait "$md" 2>/dev/null || true

  # Extract the [Interface]...AllowedIPs/Endpoint block and fix the Endpoint host.
  awk '/^\[Interface\]/{f=1} f{print} /^Endpoint/{f=0}' "$raw" \
    | sed -E "s|^Endpoint = .*:|Endpoint = $(lan_ip):|" > "$CLIENT_CONF"

  # PersistentKeepalive keeps the tunnel alive through NAT/idle timeouts. Without it
  # iOS lets the tunnel lapse after a minute or two and won't re-handshake until you
  # manually toggle it — so the app's fresh auth calls silently never reach the proxy.
  if ! grep -q '^PersistentKeepalive' "$CLIENT_CONF"; then
    printf 'PersistentKeepalive = 25\n' >> "$CLIENT_CONF"
  fi

  if ! grep -q '^\[Interface\]' "$CLIENT_CONF"; then
    echo "ERROR: could not extract WireGuard client config from mitmdump output:" >&2
    cat "$raw" >&2
    exit 1
  fi
  qrencode -r "$CLIENT_CONF" -o "$QR_PNG" -s 8 -m 2
}

start() {
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "Already running (pid $(cat "$PIDFILE")). Use 'qr' to re-show, or 'stop' first."
    exit 0
  fi
  # Free a stale UDP bind from a crashed run
  pkill -f "mode wireguard" 2>/dev/null || true
  sleep 1

  if [[ ! -f "$CERT" ]]; then
    echo "Generating mitmproxy CA cert..."
    mitmdump -p 9090 --listen-host 127.0.0.1 >/dev/null 2>&1 &
    local tmp=$!; sleep 3; kill "$tmp" 2>/dev/null; wait "$tmp" 2>/dev/null || true
  fi

  echo "Building WireGuard client config + QR..."
  build_client_conf

  echo "Starting mitmweb in WireGuard mode (UDP $WG_PORT, web UI :$WEB_PORT)..."
  # Launch through a PTY (script -q) so mitmweb flushes its startup banner — incl. the
  # web UI token — to the log; under a plain nohup pipe it buffers and we never see it.
  # Leave http3 at its default (enabled). Disabling it makes some apps (the MoonBoard
  # Flutter app) fail outright instead of falling back to TCP — they QUIC-only certain
  # endpoints and won't downgrade, so mitmproxy must intercept HTTP/3 to see them.
  nohup script -q /dev/null mitmweb \
    --mode "wireguard:$KEYFILE" \
    --listen-host 0.0.0.0 \
    --listen-port "$WG_PORT" \
    --web-port "$WEB_PORT" \
    --web-host 127.0.0.1 \
    --no-web-open-browser \
    >"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  sleep 3

  qr
  local token
  token=$(grep -oaE 'token=[a-f0-9]+' "$LOG" | tail -1 | cut -d= -f2 || true)
  [[ -n "$token" ]] && echo " Web UI (with token): http://localhost:$WEB_PORT/?token=$token"
}

qr() {
  echo ""
  echo "=================================================================="
  echo " WireGuard client config (import into the WireGuard iPhone app):"
  echo "=================================================================="
  cat "$CLIENT_CONF"
  echo ""
  echo " Scan this QR (WireGuard app → + → Create from QR code):"
  qrencode -r "$CLIENT_CONF" -t ANSIUTF8
  open "$QR_PNG" 2>/dev/null || true
  echo "------------------------------------------------------------------"
  echo " 1. Toggle the tunnel ON in the WireGuard app."
  echo " 2. Trust the CA: open http://mitm.it → install the Apple profile →"
  echo "    Settings → General → About → Certificate Trust Settings →"
  echo "    enable FULL trust for mitmproxy."
  echo " 3. Watch flows at http://localhost:$WEB_PORT"
  echo " Mac LAN IP (the config Endpoint): $(lan_ip):$WG_PORT"
  echo "------------------------------------------------------------------"
}

stop() {
  # PIDFILE holds the `script` wrapper PID; kill it, then pkill mitmweb directly in
  # case the child outlived its PTY. Either way the UDP/web ports get freed.
  [[ -f "$PIDFILE" ]] && kill "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
  if pkill -f "mode wireguard" 2>/dev/null; then
    echo "Stopped WireGuard mitmweb"
  else
    echo "WireGuard mitmweb wasn't running"
  fi
  echo "(WireGuard mode never touched the system proxy — nothing else to restore.)"
}

case "${1:-start}" in
  start) start ;;
  qr)    qr ;;
  stop)  stop ;;
  *) echo "Usage: $0 {start|qr|stop}"; exit 1 ;;
esac
