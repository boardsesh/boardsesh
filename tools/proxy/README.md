# tools/proxy — iOS traffic capture with mitmproxy

Dev tooling for inspecting the HTTPS traffic of iOS apps (e.g. reverse-engineering
the Moon Climbing / MoonBoard app's backend). Two modes, pick by what you're capturing.

|                                          | `start.sh` (HTTP proxy)               | `wireguard.sh` (WireGuard)      |
| ---------------------------------------- | ------------------------------------- | ------------------------------- |
| Target                                   | iOS **simulator** + Mac browsers      | **Physical phone**              |
| Intercepts                               | Apps that honor the system HTTP proxy | **Everything**, at the IP layer |
| Captures Firebase gRPC / WebSocket sync? | ❌ no (SDK ignores the proxy)         | ✅ yes                          |
| Phone setup                              | Wi-Fi proxy → Mac IP:9090             | Free WireGuard app + scan QR    |
| Touches Mac system proxy?                | yes (revert with `stop.sh`)           | no                              |

Both share one mitmproxy CA (`~/.mitmproxy/mitmproxy-ca-cert.pem`), generated on first run.

## Prerequisites

```bash
brew install mitmproxy qrencode
```

## Mode 1 — HTTP proxy (simulator / browsers)

```bash
./tools/proxy/start.sh     # installs CA in booted sims, sets Mac Wi-Fi proxy, starts mitmweb
./tools/proxy/stop.sh      # stops mitmweb AND fully restores the Mac proxy settings
```

- Web UI: http://localhost:9091 (proxy on :9090).
- The CA is auto-installed into every **booted** simulator (`simctl keychain … add-root-cert`).
- For Mac browsers showing TLS errors, trust the CA once:
  `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.mitmproxy/mitmproxy-ca-cert.pem`
- **Apple services are bypassed** (`*.apple.com`, `*.mzstatic.com`, …) so the App Store/iCloud
  keep working — they pin certs and would otherwise break.
- **Limitation:** native SDKs that don't read the system proxy are invisible here. Firebase's
  **Firestore** (gRPC/HTTP2) and **Realtime Database** (WebSocket) sync layers fall in this bucket —
  you'll see App Check (`firebaseappcheck.googleapis.com`) but **not** `firestore.googleapis.com`
  or `*.firebaseio.com`. Use WireGuard mode for those.

Always run `stop.sh` when done, or normal browsing / the App Store may break (an enabled proxy
pointing at a dead mitmproxy drops all traffic).

## Mode 2 — WireGuard (physical phone, captures everything)

```bash
./tools/proxy/wireguard.sh start   # builds client config + QR, opens the QR, starts mitmweb
./tools/proxy/wireguard.sh qr       # re-open the QR for a running instance
./tools/proxy/wireguard.sh stop     # stop (system proxy is never touched)
```

Intercepts at the IP layer via mitmproxy's built-in WireGuard server, so proxy-unaware apps
(Firebase gRPC/WebSocket, etc.) are captured too. No pfctl, no IP forwarding, no extra hardware.

On the iPhone:

1. Install the free **WireGuard** app from the App Store.
2. `+` → **Create from QR code** → scan the QR the script opened (or import `/tmp/wg-client.conf`).
3. Toggle the tunnel **ON**.
4. **Trust the CA** (required, or HTTPS shows cert errors):
   - With the tunnel on, open `http://mitm.it` in Safari → install the **Apple** profile.
   - Settings → General → VPN & Device Management → install the mitmproxy profile.
   - Settings → General → About → **Certificate Trust Settings** → enable **full trust** for mitmproxy.
5. Watch flows at http://localhost:9091.

Notes:

- The client config's `Endpoint` is auto-set to the Mac's `en0` LAN IP. If the Mac is on a
  different interface (or the phone can't connect), edit the Endpoint in the WireGuard app to the
  Mac's reachable IP, port `51820`.
- `mitmweb` only shows the WireGuard config in its web UI, not the console — so the script briefly
  runs `mitmdump` against the same keyfile to extract the client config and rewrite the Endpoint.
- Server key material lives in `~/.mitmproxy/wireguard.conf` (stable across runs → the QR stays valid).

## Decoding captured payloads

- **Realtime Database** (`*.firebaseio.com`): WebSocket frames are JSON — readable directly in the UI.
- **Firestore** (`firestore.googleapis.com`): gRPC payloads are protobuf. mitmproxy's gRPC/protobuf
  content viewer shows field numbers + values without schemas; decode against Google's Firestore
  `.proto` for full field names. Save flows from the web UI for offline decoding.

## Files

- `start.sh` — HTTP-proxy mode (simulator + browsers); sets the Mac Wi-Fi proxy.
- `stop.sh` — stops HTTP-proxy mitmweb and fully reverts the Mac proxy (host + bypass list + state).
- `wireguard.sh` — WireGuard mode (physical phone); builds the client config/QR and runs mitmweb.
