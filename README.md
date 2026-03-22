# braid-fuzz

Test framework for braid-http client implementations. Helps you build a new braid-http client that syncs perfectly. Great for guiding an AI.

Run your client through this gauntlet, and get back pass/fail results that an AI agent (or human) can act on.

## Quick start

```
npm install
braid-fuzz serve
```

This starts a server. Your client connects via WebSocket or TCP:

- **WebSocket:** `ws://127.0.0.1:4444`
- **TCP:** `127.0.0.1:4445`

Both use the same protocol: newline-delimited JSON, bidirectional.

Tests run automatically when your client connects. See [Protocol](#protocol) below for the full command reference.

You can also spawn your client as a subprocess:

```
braid-fuzz serve "node ./clients/js-simpleton.js"
braid-fuzz serve "node ./clients/js-simpleton.js" simpleton
braid-fuzz serve "emacs --batch --load ./clients/emacs-agent.el"
```

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Test Runner (Node.js)                 │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Test Suites  │  │ Socket Proxy │  │ Braid-Text     │  │
│  │              │  │ (fault       │  │ Server         │  │
│  │              │  │  injection)  │  │ (real CRDT)    │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                 │                  │           │
│         ▼                 ▼                  │           │
│  ┌─────────────────────────────┐             │           │
│  │      Client Bridge          │◄────────────┘           │
│  │  HTTP (GET/PUT) or stdio    │                         │
│  └──────────┬──────────────────┘                         │
│             │                                            │
│             ▼                                            │
│  ┌─────────────────────────────┐                         │
│  │  Your client (any language) │                         │
│  └─────────────────────────────┘                         │
└──────────────────────────────────────────────────────────┘
```

- **Test server** (`server.js`) — wraps `braid-text` with a control API for making server-side edits, reading state, and configuring behavior (ACK delays, PUT drops, etc.)
- **Socket proxy** (`proxy.js`) — TCP proxy between client and server. Supports modes: `passthrough`, `blackhole`, `rst`, `close`, `delay`, `corrupt`. Tests switch modes to simulate network faults.
- **Client bridge** — communicates with the client under test. In server mode (`lib/http-bridge.js`), streams commands over a long-lived GET and receives responses via PUTs. In subprocess mode (`lib/client-bridge.js`), spawns a process and talks JSON-lines over stdin/stdout.
- **Test suites** (`tests/`) — discrete, named tests with structured assertions.

## Test suites

Tests are organized into three layers, from lowest to highest:

### Subscriptions

Tests for braid subscription parsing — the core protocol layer. These use the `braid_fetch` command with `subscribe: true` to test the client's `braid_fetch` directly, independent of any merge protocol.

| Test | Description |
|------|-------------|
| subscriptions-1 | Receive snapshot body — full body via Content-Length |
| subscriptions-2 | Receive incremental patch — Content-Range patch |
| subscriptions-3 | Multi-patch update — Patches: N with multiple patches |
| subscriptions-4 | Receive Patches: 0 update — version advances, no content |
| subscriptions-5 | Subscribe with Parents header — server resumes from version |
| subscriptions-6 | Receive multiple updates in one stream — ordering verified |

### Reliable Updates

Tests for reliable update delivery: subscription reconnection, heartbeat liveness, and PUT retry. All tests use the `braid_fetch` command — with `subscribe: true` for subscriptions, or `method: "PUT"` for PUTs.

| Test | Description |
|------|-------------|
| reliable-updates-1 | Reconnect after connection close |
| reliable-updates-2 | Reconnect after TCP RST mid-stream |
| reliable-updates-3 | 503 then recovery |
| reliable-updates-4 | Rapid disconnect cycling |
| reliable-updates-5 | Client can unsubscribe |
| reliable-updates-6 | 500 then recovery |
| reliable-updates-7 | Blackhole detected via heartbeat timeout |
| reliable-updates-8 | Close between patches |
| reliable-updates-9 | Multiple error statuses then recovery |
| reliable-updates-10 | Reconnect after connection refused |
| reliable-updates-11 | PUT delivered successfully |
| reliable-updates-12 | PUT retried after connection dies |
| reliable-updates-13 | PUT retried after 503 |

### Simpleton

Tests for the simpleton merge protocol: local edits, remote edits, concurrent convergence. Uses `simpleton` to start a `simpleton_client` and `replace`/`state` to drive edits.

| Test | Description |
|------|-------------|
| simpleton-1 | Initial subscribe — buffer matches server state |
| simpleton-2 | Local edit round-trip — insert → PUT → ACK → states match |
| simpleton-3 | Receive remote edit — server edit arrives in client |
| simpleton-4 | Concurrent edits converge — both sides insert at pos 0 |
| simpleton-5 | Interleaved edits — alternating client/server, all present |
| simpleton-6 | Edit during reconnect — offline edit merges on reconnect |
| simpleton-7 | Multi-client fuzz — 3 clients + server, random edits, all converge |

## Protocol

Your client connects via WebSocket or TCP and communicates using newline-delimited JSON.

### Connecting

Connect to the fuzz server via either transport:

- **WebSocket:** `ws://127.0.0.1:4444` (or `ws://127.0.0.1:4444?filter=simpleton`)
- **TCP:** `127.0.0.1:4445`

Once connected, the server immediately starts streaming JSON-line commands. Each command has an `id` and `cmd` field. Send your response as a JSON line back on the same connection.

When all tests finish, the server sends a final line with `"done": true` and the results summary, then closes the connection.

### Example flow

```
Client                                  Fuzz Server
  |                                         |
  |  (connect via WebSocket or TCP)         |
  |  ────────────────────────────────────>  |
  |                                         |
  |  {"id":1,"cmd":"braid_fetch","url":..}  |
  |  <────────────────────────────────────  |
  |                                         |
  |  {"id":1, "ok":true}                    |
  |  ────────────────────────────────────>  |
  |                                         |
  |  (subscription updates arrive from the  |
  |   braid server — client forwards them   |
  |   to the fuzz server as events)         |
  |                                         |
  |  {"event":"fetch-update", ...}          |
  |  ────────────────────────────────────>  |
  |                                         |
  |  ... more commands and events ...       |
  |                                         |
  |  {"done":true, "results":[...], ...}    |
  |  <────────────────────────────────────  |
  |  (connection closes)                    |
```

### Commands (server → client)

Every command includes an `id` (integer, assigned by the server) and a `cmd` (string). The client must echo back the same `id` in its response.

#### `braid_fetch` — Call the client's braid_fetch

```json
{"id": 1, "cmd": "braid_fetch", "url": "http://...", "subscribe": true, "headers": {"Merge-Type": "simpleton"}}
```

Mirrors the `braid_fetch` API directly. The client should call its `braid_fetch` function with the given options.

| Field | Type   | Description |
|-------|--------|-------------|
| `url` | string | Full HTTP URL |
| `method` | string | `"GET"` (default) or `"PUT"` |
| `subscribe` | boolean | `true` to open a subscription (GET only) |
| `version` | array | Version strings (PUT only) |
| `parents` | array | Parent version strings (PUT only) |
| `patches` | array | Array of `{unit, range, content}` (PUT only) |
| `headers` | object | Extra headers (optional) |
| `name` | string | Name for this fetch (optional, auto-generated if omitted) |

**For subscriptions** (`subscribe: true`), push updates as they arrive:
```json
{"event": "fetch-update", "name": "fetch-1", "data": {"version": [...], "parents": [...], "body": "...", "patches": [...]}}
```

The `data` object should include:
- `version` — the update's Version header (array of strings, or null)
- `parents` — the update's Parents header (array of strings, or null)
- `body` — the full body text (for snapshot updates)
- `patches` — array of `{range: [start, end], content: "..."}` (for incremental updates)

**For PUTs** (`method: "PUT"`), push the result:
```json
{"event": "fetch-ack", "name": "fetch-2", "data": {"status": 200}}
```

**On errors** (either type):
```json
{"event": "fetch-error", "name": "fetch-1", "data": {"message": "..."}}
```

Used by subscription, reliable-updates, and PUT tests.

#### `unsubscribe` — Abort a braid_fetch subscription

```json
{"id": 2, "cmd": "unsubscribe", "name": "fetch-1"}
```

Aborts the subscription started by a previous `braid_fetch` command. If `name` is omitted, aborts the most recent one.

#### `simpleton` — Open a simpleton subscription

```json
{"id": 3, "cmd": "simpleton", "url": "http://127.0.0.1:4567/doc"}
```

| Field | Type   | Description |
|-------|--------|-------------|
| `url` | string | Full HTTP URL of the braid-text resource to subscribe to |

The client should start a `simpleton_client` (or equivalent) subscription to the given URL, wiring up `on_state` / `get_state` callbacks so the local buffer tracks remote state. Used by simpleton tests.

#### `replace` — Edit the local buffer

```json
{"id": 4, "cmd": "replace", "pos": 3, "len": 2, "text": "x"}
```

| Field  | Type   | Description |
|--------|--------|-------------|
| `pos`  | number | 0-based character index (not byte offset). Default: 0 |
| `len`  | number | Number of characters to remove. Default: 0 |
| `text` | string | Text to insert at `pos` after removing. Default: "" |

Mutates the local buffer and triggers a PUT to the server (via `simpleton.changed()` or equivalent). Covers insert (`len: 0`), delete (`text: ""`), and replace.

#### `state` — Return the current buffer contents

```json
{"id": 7, "cmd": "state"}
```

Response **must** include a `state` field:

```json
{"id": 7, "ok": true, "state": "current buffer text"}
```

#### `wait-ack` — Block until all pending PUTs are acknowledged

```json
{"id": 8, "cmd": "wait-ack"}
```

The client must not respond until every previously triggered PUT has received an ACK from the server. If there are no pending PUTs, respond immediately.

#### `kill-sub` — Tear down the active simpleton subscription

```json
{"id": 9, "cmd": "kill-sub"}
```

Aborts the current simpleton subscription. Does **not** clear the local buffer.

#### `quit` — Shut down the client process

```json
{"id": 10, "cmd": "quit"}
```

The client should respond, clean up resources, and exit.

### Responses (client → runner)

Every response is a single JSON line containing the `id` from the command.

**Success:**
```json
{"id": 1, "ok": true}
```

**Success with data** (only `state` returns extra fields):
```json
{"id": 7, "ok": true, "state": "buffer contents here"}
```

**Error:**
```json
{"id": 1, "error": "description of what went wrong"}
```

**Unsolicited events** (no `id` — pushed proactively by the client):
```json
{"event": "fetch-update", "name": "fetch-1", "data": {...}}
{"event": "fetch-ack", "name": "fetch-2", "data": {"status": 200}}
{"event": "fetch-error", "name": "fetch-1", "data": {"message": "..."}}
```

### Writing a new client

Connect to the fuzz server via WebSocket or TCP and exchange JSON lines. Any language can do this. Key points:

- All positions are **character offsets**, not byte offsets (relevant for multi-byte UTF-8).
- Handle commands sequentially (respond to each before reading the next) except for `wait-ack`, which blocks until ACKs arrive.
- For `braid_fetch` subscriptions, push updates proactively as unsolicited events — don't wait to be asked.
- Unknown commands should return an error response, not crash.

See [clients/js-simpleton.js](clients/js-simpleton.js) for a complete reference implementation.

## CLI

```
braid-fuzz serve                          Start server, wait for client
braid-fuzz serve <filter>                Start server, only run matching tests
braid-fuzz serve <cmd>                    Spawn <cmd> as subprocess, run tests
braid-fuzz serve <cmd> <filter>          Subprocess + filter
braid-fuzz client <cmd|url>               (coming soon) Test a braid server

Options:
  --port <n>            WebSocket port (default: 4444, server mode only)
  --tcp-port <n>        TCP port (default: 4445, server mode only)
  --timeout <ms>        Per-test timeout (default: 30000)
  --json                Output results as JSON
  --server-port <n>     Fixed braid-text server port (default: auto)
  --proxy-port <n>      Fixed proxy port (default: auto)
```

In server mode, you can also pass a filter via WebSocket query string: `ws://127.0.0.1:4444?filter=simpleton`

## JSON output

The final line of the GET response (with `"done": true`) contains the full results:

```json
{
  "done": true,
  "results": [
    {"id": "subscriptions-1", "name": "Receive snapshot body", "status": "pass", "duration_ms": 521},
    {"id": "simpleton-4", "name": "Concurrent edits converge", "status": "fail", "error": "...", "duration_ms": 10032}
  ],
  "summary": {"passed": 25, "failed": 1, "skipped": 0, "total": 26}
}
```

## Subprocess mode

In subprocess mode, the client reads JSON-line commands from stdin and writes JSON-line responses to stdout. The commands, responses, and unsolicited events are identical to server mode.

```
braid-fuzz serve "node ./clients/js-simpleton.js"
braid-fuzz serve "node ./clients/js-simpleton.js" simpleton
braid-fuzz serve "node ./clients/js-simpleton.js" --json
```

In this mode, diagnostic output must go to **stderr** (stdout is the protocol channel).
