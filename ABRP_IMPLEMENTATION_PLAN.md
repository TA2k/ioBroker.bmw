# Implementation plan: ABRP live telemetry

## Goal and scope

Add an optional, disabled-by-default integration that forwards useful BMW CarData telemetry to A Better Routeplanner (ABRP):

- `utc`: normally the original BMW measurement timestamp as Unix seconds; the one-time startup seed uses the adapter start/send time
- `soc`: `vehicle.drivetrain.batteryManagement.header` as a percentage, with `vehicle.powertrain.electric.battery.stateOfCharge.displayed` as a compatibility fallback
- `is_charging`: `1` only for an active BMW charging session, otherwise `0`
- `is_dcfc`: `1` for an active DC charging connection and `0` for AC, only while charging
- `est_battery_range`: BMW's remaining electric range normalized to kilometres

No location, speed, VIN, route, or driving history is sent to ABRP. The integration must not trigger additional BMW API calls; it consumes the data already received through BMW MQTT streaming and the adapter's existing telematic API refreshes.

## External API contract

Use the Iternio Telemetry API endpoint:

`https://api.iternio.com/1/tlm/send`

Each request needs:

- an ABRP Telemetry API key identifying the sending application, sent as the HTTP header `Authorization: APIKEY <key>`
- one ABRP Generic live-data token identifying the ABRP vehicle
- a `tlm` JSON object containing `utc`, `soc`, and any currently valid optional telemetry fields

The Generic token and serialized `tlm` object are URL-encoded request parameters. Although the v1 documentation also permits an `api_key` query parameter and allows both GET and POST, the adapter follows the published `send` request and keeps the API key out of the URL by using the authorization header.

ABRP limits telemetry traffic to a maximum of two requests per second and API key. This limit is global for the configured API key, not per VIN. Every request path, including automatic MQTT updates, API refreshes, manual `sendNow` actions, and retries, must therefore pass through one shared rate limiter.

Treat a request as successful only when the HTTP request succeeds and the JSON body contains `status: "ok"`. ABRP may return HTTP 200 with an application-level error. A `missing` field in an otherwise successful response is informational because not every BMW vehicle provides every optional field.

Do not commit or ship somebody else's API key. Users obtain a free Telemetry API key from ABRP's API-key management page and a Generic token from the live-data connection of the applicable ABRP vehicle.

## Configuration and secrets

Extend `io-package.json` and `admin/jsonConfig.json` with an ABRP section:

- `abrpEnabled` (boolean, default `false`)
- `abrpApiKey` (password field, required only when enabled)
- `abrpVehicles` (table of `enabled`, `vin`, and `token`)

The table supports multiple BMW vehicles while keeping one ABRP Generic token per VIN. Require unique, normalized VINs and ignore disabled rows.

Protect both credentials:

- add `abrpApiKey` and the table token path to `encryptedNative`
- add the same paths to `protectedNative`
- never include tokens, API keys, complete request URLs, or query parameters in logs or states

Do not combine the table's `encryptedAttributes` option with the same `encryptedNative` path: both mechanisms encrypt the value and leave one encrypted layer after js-controller startup. Nested `encryptedNative` paths require ioBroker Admin 8.2.0 or newer, which includes json-config 10.1.2 with the corrected nested-path handling. Recover legacy double-encrypted UUID tokens once at runtime so affected installations can send telemetry immediately, and ask the user to re-enter/save the token once to migrate the stored value.

Add translations for all languages already present under `admin/i18n/`. The UI help text must explain how to create both credentials, that the Generic token is vehicle-specific, and which data leaves ioBroker.

## Internal design

### 1. Isolated ABRP module

Create `lib/abrp.js` instead of mixing the HTTP and mapping logic into `main.js`. It should expose small, testable units:

- a BMW-to-ABRP mapper
- configuration/token lookup by VIN
- an ABRP client with a dedicated Axios instance and timeout
- a per-VIN sender that deduplicates and serializes updates
- one adapter-wide/API-key-wide scheduler that enforces the ABRP request limit

Do not reuse the BMW Axios client with `withCredentials: true`; ABRP communication must be isolated from BMW authentication and cookies.

### 2. Mapping and validation

Read the SoC directly from each incoming telematic payload before or after it is handed to `json2iob`:

Use these BMW sources in priority order:

1. `vehicle.drivetrain.batteryManagement.header`
2. `vehicle.powertrain.electric.battery.stateOfCharge.displayed` as a fallback for vehicles that provide it

If both entries occur in the same payload, the `batteryManagement.header` value wins. If the primary entry is missing or unusable, the mapper may use a valid fallback entry and its corresponding timestamp.

The mapper must:

- accept numeric values and valid numeric strings
- retain valid boundary values `0` and `100`
- reject NaN, infinity, and values outside `0..100`
- parse the BMW entry's ISO timestamp and convert milliseconds to integer Unix seconds
- reject missing, invalid, future-skewed, or stale timestamps rather than presenting cached BMW data as live data
- map `CHARGINGACTIVE` to `is_charging: 1`; map `NOCHARGING`, `INITIALIZATION`, `CHARGINGPAUSED`, `CHARGINGENDED`, and `CHARGINGERROR` to `0`
- derive `is_dcfc` from the streaming-capable DC charging-port connection status, not the non-streaming DC mode preference
- convert a miles-based BMW range to kilometres and omit ambiguous display-range values when the BMW unit is unknown
- cache fresh auxiliary fields per VIN so partial MQTT messages can be merged with the latest still-fresh SoC
- return no telemetry when neither a fresh SoC nor an auxiliary update with a cached fresh SoC is available

Use the BMW source timestamp, not `Date.now()`. This lets ABRP recognize the actual age of a value and prevents an old API snapshot from appearing current.

Exception: after each adapter start, send the latest persisted or API-returned valid SoC once even if its BMW timestamp is older than the normal freshness window. Use the startup send time as `utc` for this one request so a sleeping vehicle initializes the ABRP Generic connection without requiring a drive. Subsequent telemetry must again pass the normal freshness check. This startup seed still passes through the shared limiter and does not trigger an extra BMW request.

### 3. One ingestion path

Extract the repeated handling of telematic payloads in `main.js` into a shared method, for example `processTelematicData(vin, data, source)`. Route all existing sources through it:

- MQTT messages
- initial container fetch
- periodic telematic refresh
- container validation fetch
- manual `fetchViaAPI`

The shared method keeps the existing `json2iob` behavior and then offers the same raw payload to the ABRP sender. Deduplication by VIN, source timestamp, and SoC prevents the startup/validation paths from sending the same measurement more than once.

ABRP failures must never fail BMW data processing or disconnect BMW MQTT.

### 4. Delivery behavior

For every configured VIN:

- seed ABRP once after adapter startup from the last-known SoC, preferring persisted ioBroker data and otherwise using the normal startup container fetch
- send immediately when a fresh SoC measurement with a new timestamp or value arrives
- send fresh charging-state, DC-state, and range changes together with the latest still-fresh SoC
- allow only one in-flight ABRP request per VIN
- if another measurement arrives while sending, retain only the newest pending measurement
- use a bounded timeout
- retry transient network, HTTP 429, and 5xx failures with a small capped backoff; do not retry invalid credentials or other permanent 4xx responses
- never create an unbounded offline queue; a newer SoC supersedes an older unsent SoC
- stop timers and discard pending work in `onUnload`

Enforce the ABRP limit centrally across all vehicles:

- allow at most two request starts per rolling second for the configured API key
- use a conservative minimum spacing of 550 ms between request starts so timing jitter cannot cross the two-per-second boundary
- keep only the newest pending telemetry point per VIN; rapid BMW MQTT updates replace, rather than append to, older unsent values
- schedule VINs fairly (round-robin) so one noisy vehicle cannot starve another configured vehicle
- route retries and `sendNow` through the same scheduler; neither may bypass or create a second limiter
- do not count an incoming BMW message as an ABRP request until the HTTP request actually starts
- preserve the original BMW timestamp while queued and discard the item if it becomes stale before transmission
- keep the limiter adapter-wide while there is one configured API key; if support for multiple API keys is added later, maintain one independent limiter per distinct key

This is event-driven. Do not add a fast polling interval and do not call BMW solely for ABRP.

### 5. Observable ioBroker states

Create a small `${vin}.abrp` channel for configured vehicles:

- `lastSuccess` (timestamp)
- `lastAttempt` (timestamp)
- `lastSoc` (number, `%`)
- `status` (`disabled`, `waiting`, `ok`, `error`)
- `lastError` (sanitized text without secrets)
- `sendNow` (write-only button, optional but useful for setup validation)

`sendNow` should resend only a cached, still-fresh SoC measurement. It must not trigger a BMW API request. Status objects should be created only for configured ABRP vehicles so the normal adapter object tree stays unchanged when the feature is disabled.

## Files to change

- `main.js`: lifecycle wiring, centralized telematic processing, status objects, unload cleanup
- `lib/abrp.js`: mapper, client, per-VIN delivery state, redaction/error normalization
- `io-package.json`: native defaults, protected/encrypted settings, release notes, optional status object definitions
- `admin/jsonConfig.json`: opt-in ABRP configuration and per-VIN token table
- `admin/i18n/*.json`: labels, help, privacy notice, validation messages
- `README.md`: ABRP prerequisites and setup instructions
- `lib/adapter-config.d.ts`: expected to update automatically through the inferred `native` type; verify with TypeScript
- `*.test.js` or new focused test files: unit and adapter integration coverage

## Test plan

### Unit tests

- map valid integer, float, string, zero, and 100-percent SoC values
- reject absent, malformed, and out-of-range SoC values
- convert valid BMW timestamps to epoch seconds
- reject stale/future/invalid timestamps
- match each VIN to only its own Generic token
- build the exact ABRP request without leaking credentials to logs/errors
- accept only `{ "status": "ok" }` as success, even with HTTP 200
- classify 429/5xx/network failures as transient and 400/401/403 as permanent
- deduplicate identical measurements and coalesce concurrent updates to the newest value
- prove with a fake clock that bursts never start more than two requests in any rolling one-second window
- prove that MQTT bursts for one VIN retain only their newest unsent SoC
- prove fair scheduling across multiple VINs sharing the API key
- prove automatic sends, `sendNow`, and retries all share the same rate budget
- discard queued telemetry that becomes stale while waiting for the limiter

### Adapter-level tests

- disabled configuration produces no ABRP request or ABRP vehicle objects
- a BMW MQTT payload containing a fresh SoC produces one ABRP request
- a periodic/API payload follows the same path
- a partial MQTT payload without SoC produces no request
- repeated processing of the same source measurement produces no duplicate request
- an MQTT burst above two updates per second remains within the API-key-wide ABRP limit
- simultaneous updates from multiple VINs remain within the same shared limit
- one VIN cannot use another VIN's token
- ABRP failure updates sanitized status states but BMW state parsing continues
- unload cancels retry timers and prevents later sends

### Quality gates

Run at least:

- `npm test`
- `npm run check`
- `npm run lint`
- package/adapter validation already configured in this repository

Perform one manual end-to-end test with a real ABRP test vehicle: after a fresh BMW MQTT SoC update, ABRP must show the same SoC and the adapter's `${vin}.abrp.lastSuccess` must update without any increase caused by ABRP in the BMW API-call history.

## Documentation flow for users

Document these setup steps:

1. Save/select the vehicle in ABRP.
2. In its live-data settings, link the `Generic` provider and copy the vehicle token.
3. Create a free Telemetry API key in ABRP's telemetry API-key management.
4. Enable ABRP in the BMW adapter, enter the API key, and add the VIN/token mapping.
5. Restart/save the instance and wait for a fresh BMW SoC event.
6. Check `${vin}.abrp.status`, `lastSuccess`, and ABRP's live-data indication.

Also state the operational limitation: “live” means as fresh as BMW CarData makes the SoC available. A sleeping vehicle or delayed BMW backend cannot be made real-time by the adapter.

## Acceptance criteria

- ABRP integration is opt-in and disabled by default.
- A fresh BMW high-voltage battery SoC is delivered to the correct ABRP vehicle with its original measurement timestamp, preferring `batteryManagement.header` over the compatibility fallback.
- Fresh BMW charging state, DC charging state, and electric range are normalized to ABRP's documented values and merged with the same VIN's fresh SoC.
- No additional BMW API requests are generated.
- Multiple VINs cannot cross-use tokens.
- No secret appears in logs, ioBroker states, or repository files.
- Stale/invalid data and duplicate events are not sent.
- No combination of MQTT updates, multiple VINs, manual sends, or retries exceeds two ABRP requests per second for the API key.
- ABRP outages do not affect BMW authentication, MQTT, state updates, or adapter shutdown.
- The admin UI and README clearly require both the Telemetry API key and Generic vehicle token and disclose the transmitted fields.
