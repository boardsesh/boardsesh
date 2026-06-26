#!/usr/bin/env bash
# Start mitmweb and route iOS simulator traffic through it.
# Run: ./tools/proxy/start.sh
# Stop: ./tools/proxy/stop.sh
# Web UI: http://localhost:8081

set -euo pipefail

PROXY_HOST="0.0.0.0"
PROXY_PORT=9090
WEB_PORT=9091
CERT="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
PIDFILE="/tmp/mitmweb.pid"

# Ensure cert exists (generated on first run)
if [[ ! -f "$CERT" ]]; then
  echo "Generating mitmproxy CA cert..."
  mitmdump -p "$PROXY_PORT" --listen-host "$PROXY_HOST" &
  TMP_PID=$!
  sleep 3
  kill "$TMP_PID" 2>/dev/null
  wait "$TMP_PID" 2>/dev/null || true
fi

# Install cert in all booted iOS simulators
echo "Installing mitmproxy CA cert in booted simulators..."
while IFS= read -r udid; do
  xcrun simctl keychain "$udid" add-root-cert "$CERT" 2>/dev/null && echo "  ✓ $udid" || echo "  ✗ $udid (skipped)"
done < <(xcrun simctl list devices booted | grep -oE '[A-F0-9-]{36}')

# Route Mac Wi-Fi traffic through mitmproxy (simulator inherits Mac proxy)
echo "Setting Mac Wi-Fi proxy → $PROXY_HOST:$PROXY_PORT"
networksetup -setwebproxy Wi-Fi "$PROXY_HOST" "$PROXY_PORT"
networksetup -setsecurewebproxy Wi-Fi "$PROXY_HOST" "$PROXY_PORT"
networksetup -setwebproxystate Wi-Fi on
networksetup -setsecurewebproxystate Wi-Fi on
# Bypass Apple services (App Store, iCloud, etc.) and local addresses — these use cert pinning
networksetup -setproxybypassdomains Wi-Fi \
  "*.apple.com" "*.itunes.com" "*.mzstatic.com" "*.icloud.com" "*.aaplimg.com" \
  "localhost" "127.0.0.1" "*.local"

# Start mitmweb in background
echo "Starting mitmweb on port $WEB_PORT..."
nohup mitmweb \
  --listen-host "$PROXY_HOST" \
  --listen-port "$PROXY_PORT" \
  --web-port "$WEB_PORT" \
  --web-host 127.0.0.1 \
  > /tmp/mitmweb.log 2>&1 &
echo $! > "$PIDFILE"

echo ""
echo "Proxy running — open http://localhost:$WEB_PORT in your browser"
echo "Stop with: ./tools/proxy/stop.sh"
echo ""
echo "NOTE: If you see HTTPS errors in your Mac browser, trust the CA cert once:"
echo "  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain $CERT"
