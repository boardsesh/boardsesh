# Bluetooth controller evidence

Issue #7950 investigates MoonBoard's documented twelve-digit controller
identifier. Its actual encoding remains unverified. The instrumentation also
collects evidence for other supported climbing-board families.

Evidence belongs on existing Bluetooth events, not a separate event series.
Connection outcomes retain the selected peripheral's advertisement evidence;
scan summaries retain a bounded batch. Platform peripheral handles, parsed
name suffixes, configured board IDs and manufacturer identity are separate
concepts. No payload is decoded into a new manufacturer identity by this work.

New clients add `bleEvidenceVersion: 1` and a bounded JSON string named
`bleEvidence`. Actual radio scans carry `bleScanId`; connection-start and
outcome events share `bleConnectionAttemptId`. A partial picker summary uses
`blePickerSessionId` rather than pretending its UI session is a radio scan.
Existing event names, cohorts and emission counts remain the same.

## Interpretation

Inspect the evidence version, source, completeness and truncation before
comparing bytes. An absent field on an older binary is not evidence that a
controller does not advertise it. A cached name is not necessarily the current
advertised local name. Native targeted service discovery is not a complete
GATT inventory. Native reconnects can have no fresh advertisement at all.

Picker-cache summaries exclude unselected peripherals identified only by a
generic transport service. An explicitly selected peripheral keeps priority
when the evidence batch reaches its device limit. Picker capability comes
from that scan's adapter; partial cached observations do not establish support
for collecting advertisements before deduplication on an older native binary.

New iOS binaries return an attempt-bound discovery snapshot with a successful
prepared connection, before the first LED write. This preserves GATT evidence
if that write drops the link. Older binaries keep their existing connection
behavior and cannot supply this additional snapshot.

Android raw scan records preserve advertisement structures that the BLE
library's parsed manufacturer/service fields may discard. iOS CoreBluetooth
does not expose an equivalent complete raw packet. Hex encoding preserves
leading zero bytes; it does not establish byte order or identity semantics.

Evidence collection uses existing scans and discovery. It adds no controller
connections, characteristic reads, authentication operations or LED writes.
PINs and authentication characteristic values must never enter analytics.
The normal analytics consent gate applies at emission time.

## Investigation queries

Start with raw event keys rather than relying exclusively on PostHog's cached
property taxonomy. The initial ninety-day investigation found manufacturer
data on thirty MoonBoard-tagged connection events even though those fields
were absent from the cached taxonomy.

```sql
SELECT DISTINCT arrayJoin(JSONExtractKeys(properties)) AS property_key
FROM events
WHERE timestamp >= now() - INTERVAL 7 DAY
  AND event IN (
    'Bluetooth Connection Success', 'Bluetooth Connection Failed',
    'Bluetooth Connection Cancelled', 'Bluetooth Disconnected',
    'Board Quickstart Scan Finished', 'BLE Picker Devices Resolved',
    'BLE Advertisement Recon'
  )
ORDER BY property_key
LIMIT 300
```

```sql
SELECT timestamp, event, properties.boardName AS configured_board,
       properties.bleScanId AS scan_id,
       properties.bleConnectionAttemptId AS attempt_id,
       properties.bleEvidence AS evidence
FROM events
WHERE timestamp >= now() - INTERVAL 7 DAY
  AND event IN ('Bluetooth Connection Success', 'Bluetooth Connection Failed')
  AND properties.bleEvidenceVersion = 1
ORDER BY timestamp DESC
LIMIT 50
```

Filter by the evidence schema version and compatible app/runtime before
evaluating coverage. Join scan and connection records using their explicit
correlation fields, not names or board configuration IDs. Repeated payloads
and Android-address matches provide hypotheses; they do not by themselves
verify the identifier described by the manufacturer.

The next step after rollout is to compare observed formats across repeated
connections and platforms. Keep #7950 open until corroborating evidence
supports a decoder, its source and its normalization rules. Synthetic fixtures
verify data flow, not the actual MoonBoard V5 encoding.
