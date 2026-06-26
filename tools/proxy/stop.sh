#!/usr/bin/env bash
# Stop the HTTP-proxy mitmweb and fully restore Mac proxy settings.
# Use this to undo tools/proxy/start.sh. (WireGuard mode has its own teardown
# in tools/proxy/wireguard.sh and does NOT touch the system proxy.)

set -euo pipefail

PIDFILE="/tmp/mitmweb.pid"

if [[ -f "$PIDFILE" ]]; then
  PID=$(cat "$PIDFILE")
  kill "$PID" 2>/dev/null && echo "Stopped mitmweb (pid $PID)" || echo "mitmweb wasn't running"
  rm -f "$PIDFILE"
else
  pkill -f mitmweb 2>/dev/null && echo "Stopped mitmweb" || echo "mitmweb wasn't running"
fi

echo "Restoring Mac Wi-Fi proxy settings..."
# Clear the server host/port + bypass list FIRST (these commands re-enable the
# proxy as a side effect), THEN toggle state off last — order matters, or the
# proxy is left "enabled" with an empty server, which still breaks browsing.
networksetup -setwebproxy Wi-Fi "" 0 2>/dev/null || true
networksetup -setsecurewebproxy Wi-Fi "" 0 2>/dev/null || true
# Reset bypass domains to the macOS default ("Empty" == none)
networksetup -setproxybypassdomains Wi-Fi "Empty" 2>/dev/null || true
networksetup -setwebproxystate Wi-Fi off
networksetup -setsecurewebproxystate Wi-Fi off

echo "Done. Normal browsing + App Store should work again."
