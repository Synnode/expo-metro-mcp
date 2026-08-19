# expo-metro-mcp Skill

Use this skill when working on a React Native / Expo project that has a running Metro dev server. It gives you real-time log access, stack trace resolution, and direct control over iOS simulators and Android emulators.

## Prerequisites

- Metro dev server running (`npx expo start`)
- App running on a simulator or emulator (for device tools)
- iOS tap/swipe/input: `brew install idb-companion && pip3 install fb-idb`
- Android tap/swipe/input: `adb` available (Android Studio / platform-tools)

## Tool reference

| Tool | When to use |
|---|---|
| `get_status` | Always check first — confirms Metro connection and buffer stats |
| `get_logs` | Fetch recent logs; filter by level or time window |
| `get_errors` | Fetch errors with stack traces from the buffer |
| `watch_logs` | Poll for live logs after triggering an action (max 30s) |
| `resolve_stack` | Resolve bundle offsets to original source file:line |
| `clear_logs` | Clear buffer after resolving an issue |
| `reload` | Reload the RN app via Metro |
| `connect` | Grab CDP connection if disconnected or taken by DevTools |
| `disconnect` | Release CDP so React Native DevTools can connect |
| `list_devices` | List active iOS simulators and Android emulators |
| `screenshot` | Capture current screen as image; response includes exact pixel dimensions for tap/swipe |
| `tap` | Tap at x,y coordinates. On Android, pass `expected_package` to detect ANR dialogs / stale focus that would silently swallow the tap |
| `swipe` | Swipe between two coordinates (scroll, dismiss sheets, etc.) |
| `input_text` | Type text into the focused input field — works without the on-screen keyboard |
| `input_key` | Send a special key: `enter`, `backspace`, `delete`, `tab`, `escape`, `back`, `space`, arrow keys |
| `sqlite_tables` | List user tables/views in the app's SQLite DB (needs the `sqlite` debug hook) |
| `sqlite_schema` | Inspect a table's columns, foreign keys, indexes, and `CREATE` SQL |
| `sqlite_query` | Run a read-only query (`SELECT`/`WITH`/`PRAGMA`/`EXPLAIN`); bind values via `params` |
| `sqlite_exec` | Run a write statement (`INSERT`/`UPDATE`/`DELETE`/DDL); disabled under `EXPO_METRO_MCP_READ_ONLY=1` |

## Workflows

### Inspecting or seeding SQLite data

Requires the app to expose `globalThis.__EXPO_METRO_MCP__.sqlite` (`query`/`run`) in `__DEV__` — see the SQLite debug hook section in the README.

1. `sqlite_tables` — discover what tables exist
2. `sqlite_schema` with a `table` — learn its columns before writing SQL
3. `sqlite_query` — read rows; always pass values through `params` (`?` placeholders), never string-interpolate
4. `sqlite_exec` — seed or mutate rows (`INSERT`/`UPDATE`/`DELETE`); check `changes` in the result
5. `reload` if the app caches query results and won't re-read on its own

### Debugging a crash or error

1. `get_status` — confirm Metro is connected
2. `get_errors` — fetch errors with stack traces
3. `resolve_stack` — map bundle offsets to original source locations
4. Fix the issue in source
5. `reload` — reload the app
6. `watch_logs` with `duration: "10s"` — confirm no new errors appear
7. `clear_logs` — clean up the buffer

### Visual UI verification

1. `list_devices` — find available simulators/emulators
2. `screenshot` — capture the current screen
3. Identify the target element by its coordinates in the image
4. `tap` at those coordinates
5. `screenshot` again — verify the expected screen transition occurred
6. Repeat until the flow is complete

### Scrolling / dismissing

1. `screenshot` — identify scroll start and end points
2. `swipe` from bottom to top to scroll down, top to bottom to scroll up
3. `screenshot` — verify the result

**Note:** iOS swipe simulation is limited due to idb constraints. For reliable swipe gestures, prefer Android emulators.

### Filling in a form field

1. `screenshot` — locate the input field
2. `tap` on the field to focus it
3. `input_text` with the value to type — no keyboard required
4. `input_key` with `"enter"` to submit, or `tap` the submit button
5. `screenshot` — verify the result

### Navigating a full user flow

1. `screenshot` — assess the current screen
2. Determine the next action (tap a button, fill a field, scroll)
3. Execute `tap`, `swipe`, `input_text`, or `input_key`
4. `screenshot` — verify the transition
5. `watch_logs` if the action triggers async work (API calls, navigation)
6. Repeat from step 1 until the flow is complete

## Platform notes

### iOS

- Screenshots are automatically downscaled from pixel resolution to logical points via `sips`
- Tap and swipe coordinates must be in **logical points** (matching the downscaled screenshot)
- Tap requires `idb` — the MCP auto-spawns `idb_companion` and kills it after inactivity
- If `idb` is unavailable, tap falls back to `xcrun simctl io sendtouchJSON` (Xcode 14.3+)
- Physical devices are not supported — simulators only

### Android

- Screenshots are captured via `adb screencap` at native resolution; pixel dimensions are included in the response
- Tap, swipe, input_text, and input_key use `adb shell input` — no extra tooling required
- Works on both emulators and (if adb-connected) physical devices
- `tap` runs a pre-flight focus check via `dumpsys window`:
  - If a system **ANR dialog** ("Application Not Responding") has focus, the tap is **blocked** and the response includes recovery commands. `adb shell input tap` would otherwise silently route the event to the dialog instead of your app.
  - If `expected_package` is provided and the focused window belongs to a different package, the response includes a warning (the tap is still sent).
  - If the tap coordinates fall outside the focused window's frame, the response includes a warning. Degenerate `0×0` frames from system overlays are ignored to avoid false positives.

### When a tap "succeeds" but nothing happens

This usually means the focused window on the device is not your app. The most common causes:
- An ANR dialog from an earlier crash is still open (often invisible if the app was backgrounded)
- Multiple stale `MainActivity` instances accumulated from Fast Refresh / dev menu reloads, and focus is on a hidden one
- A system permission prompt, OS update banner, or notification shade is on top

Pass `expected_package` (e.g. `"com.yourcompany.yourapp"`) to `tap` to surface this immediately rather than debugging coords/scaling. If the tool returns an ANR-blocked error, follow the recovery commands it suggests; a full `adb reboot` is the cleanest fix when stale Activity tasks have accumulated.

## Connection management

The MCP holds a CDP WebSocket connection to Metro. React Native DevTools uses the same connection — only one client can hold it at a time.

**Important agent behavior:** if a tool that needs CDP reports that the MCP is disconnected, the agent should try `connect` itself before giving up or asking the user. In practice, disconnection often just means DevTools had the socket last.

- If DevTools is open and the MCP shows disconnected: call `connect` to take over
- Before opening DevTools: call `disconnect` to release the connection
- If a runtime tool fails because CDP is not attached, retry after `connect`
- The MCP reconnects automatically when Metro restarts or the device reconnects, but explicit `connect` is still the fastest recovery path when DevTools was using the socket

## Tips

- Always `screenshot` before tapping — coordinates are only valid for the current screen state
- The `screenshot` response includes the image dimensions — use those exact px values for `tap`/`swipe`, no manual scaling needed
- To fill a form: `tap` to focus → `input_text` to type → `input_key` `"enter"` to submit
- Use `watch_logs` with `level: "error"` after navigation actions to catch silent failures
- If a stack trace is unreadable (bundle offsets), always run `resolve_stack` before attempting a fix
- `clear_logs` between distinct test scenarios keeps the buffer clean and `get_errors` output relevant
- If multiple devices are running, pass `platform` or `device_id` explicitly to avoid ambiguity
