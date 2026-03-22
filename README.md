# braid-fuzz

Test framework for braid-http client implementations. Helps you build a new braid-http client that syncs perfectly. Great for guiding an AI.

Run your client through this gauntlet, and get back pass/fail results that an AI agent (or human) can act on.

## Instructions to build a client with braid-fuzz

1. Connect your client to braid-fuzz
  - Implement a `controller` in your client that lets braid-fuzz control it
  - Write a headless `launch-script`, so braid-fuzz can launch your client and run tests automatically
  - Test the basics with `braid-fuzz <launch-script> basics`
2. Build and test one Braid-HTTP feature at a time
  - (First, implement and test the prerequisites for your feature)
  - Implement the feature itself
  - Implement the controller commands to test the feature
  - Test the feature with `braid-fuzz <launch-script> <feature-name>`
  - Read the failed tests in the console.
  - Fix the bugs! Iterate until tests pass.
3. Run the full test-suite periodically to verify that prior features are still working with `braid-fuzz <launch-script> everything`

See the example controller and launch script for braid-text simpleton: [braid-text-simpleton-controller.js](examples/braid-text-simpleton-controller.js), [braid-text-simpleton-launcher.sh](examples/braid-text-simpleton-launcher.sh).

Detailed instructions follow:

### 1. Connect your client with a braid-fuzz controller

First, make a `controller` script for your client that lets braid-fuzz control it.  The script will:
1. Connect to braid-fuzz via one of:
  - **stdin/stdout**: Simplest — braid-fuzz spawns your script directly.
  - **TCP**: Connect to `localhost:4445`.
  - **WebSocket**: Connect to `ws://localhost:4444`.
2. Read each incoming JSON command:
  - stdin/stdout and TCP: Each command is one line of text, separated by `\n`.
  - WebSocket: Each command is one message.
3. Run the command to control your client below:
  - Basic commands  *(start here!)*
    - **Hello**: We begin! Respond with ok.
    - **Results**: Testing is done. Receive results and clean up.
  - HTTP commands *(add these next)*
    - **Open HTTP** request
    - **Close HTTP** request
  - Text Sync commands *(then try these)*
    - **Sync text**: Start syncing client text with a url
    - **End sync**: End syncing
    - **Edit**: Simulate a user text edit
    - **Send text**: Send a copy of the client's text buffer back to braid-fuzz
    - **Ack**: Notify braid-fuzz when all client edits to get acknowledged by server

Second, write a headless `launch-client.sh` script that:
 1. Launches your client from the command-line (headless if possible)
 2. Runs your client's `controller`

If using stdin/stdout, the launch script just needs to run the controller — braid-fuzz will pipe commands in and read responses out. If using TCP or WebSocket, the controller connects to the braid-fuzz server on its own.

Now braid-fuzz can automatically run tests against your client with
`braid-fuzz <launch-client.sh> <feature>`

### 2. Build and test a feature

To start, implement the *basic commands*, and test your basic setup with:

```
braid-fuzz <launch-client.sh> basics
```

Once that works, you can start building and testing the exciting features!

For each feature:
  1. Implement the feature in your client
  2. Implement the feature's controller commands in your `controller`
  3. Test the feature with `braid-fuzz <launch-client.sh> <feature>`

Once the Basic tests work, try moving on to HTTP.

#### Basic Tests and Commands

Run these tests with:
```
braid-fuzz <launch-client.sh> basics
```

Commands to implement:

| Command | JSON `cmd` | What to do |
|---------|-----------|------------|
| **Hello** | `hello` | Respond with `ok`. |
| **Results** | `results` | Receive test results. Respond with `ok`, then clean up and exit. |

#### HTTP Tests and Commands

Run these tests with:
```
braid-fuzz <launch-client.sh> http
```

These test your client's `braid_fetch` — can it open an HTTP request and send a PUT?

Commands to implement:

| Command | JSON `cmd` | What to do |
|---------|-----------|------------|
| **Open HTTP request** | `open-http` | Call `braid_fetch(url, {subscribe: true, ...})`. Push each update back as an `update` event. |
| **Send PUT** | `open-http` | Call `braid_fetch(url, {method: "PUT", version, parents, patches, ...})`. Push result as `ack`. |

#### Subscriptions Tests

Run these tests with:
```
braid-fuzz <launch-client.sh> subscriptions
```

These test subscription parsing in detail — snapshots, incremental patches, multi-patch updates, Patches: 0, Parents header. Uses the same `open-http` command as HTTP, plus:

| Command | JSON `cmd` | What to do |
|---------|-----------|------------|
| **Close HTTP request** | `close-http` | Abort the current `braid_fetch` subscription. |

#### Reliable Updates Tests

Run these tests with:
```
braid-fuzz <launch-client.sh> reliable-updates
```

These test reconnection, retry, heartbeat detection, and PUT retry. Uses the same `open-http` and `close-http` commands. Your `braid_fetch` needs to handle retry and heartbeat liveness.

#### Text Sync (Simpleton) Tests and Commands

Run these tests with:
```
braid-fuzz <launch-client.sh> simpleton
```

These test the simpleton merge protocol — local edits, remote edits, concurrent convergence.

Commands to implement:

| Command | JSON `cmd` | What to do |
|---------|-----------|------------|
| **Sync text** | `sync-text` | Start a `simpleton_client` subscription to the given URL. |
| **End sync** | `end-sync` | Abort the simpleton subscription. |
| **Edit** | `edit` | Edit the local buffer at `pos`, removing `len` chars, inserting `text`. Triggers a PUT via `simpleton.changed()`. |
| **Send text** | `send-text` | Respond with `{"state": "current buffer text"}`. |
| **Ack** | `ack` | Block until all pending PUTs are acknowledged. |



## Protocol

Communication uses JSON — one command or response per line (stdin/stdout and TCP) or per message (WebSocket).

Each command from braid-fuzz includes an `id` and `cmd` field. Your controller responds with the same `id` and either `"ok": true` or `"error": "..."`. When all tests finish, braid-fuzz sends a `results` command with the test results.

### Example flow

```
Controller                              braid-fuzz
  |                                         |
  |  {"id":1,"cmd":"hello"}                 |
  |  <────────────────────────────────────  |
  |                                         |
  |  {"id":1, "ok":true}                    |
  |  ────────────────────────────────────>  |
  |                                         |
  |  {"id":2,"cmd":"open-http","url":..}     |
  |  <────────────────────────────────────  |
  |                                         |
  |  {"id":2, "ok":true}                    |
  |  ────────────────────────────────────>  |
  |                                         |
  |  (updates arrive from braid server —    |
  |   controller forwards them as events)   |
  |                                         |
  |  {"event":"update", ...}                |
  |  ────────────────────────────────────>  |
  |                                         |
  |  ... more commands and events ...       |
  |                                         |
  |  {"cmd":"results", "results":[...]}     |
  |  <────────────────────────────────────  |
  |                                         |
  |  {"id":N, "ok":true}                    |
  |  ────────────────────────────────────>  |
```

### Commands (server → client)

Every command includes an `id` (integer, assigned by the server) and a `cmd` (string). The client must echo back the same `id` in its response.

#### `hello` — Greeting

```json
{"id": 1, "cmd": "hello"}
```

Respond with `{"id": 1, "ok": true}`. This is the first command sent, used by the basics tests.

#### `results` — Test results

```json
{"id": 2, "cmd": "results", "results": [...], "summary": {"passed": 5, "failed": 1, ...}}
```

Sent when all tests are done. The command includes the full test results. Respond with `ok`, then clean up and exit.

#### `open-http` — Call the client's braid_fetch

```json
{"id": 1, "cmd": "open-http", "url": "http://...", "subscribe": true, "headers": {"Merge-Type": "simpleton"}}
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

**For subscriptions** (`subscribe: true`), push updates as they arrive:
```json
{"event": "update", "data": {"version": [...], "parents": [...], "body": "...", "patches": [...]}}
```

The `data` object should include:
- `version` — the update's Version header (array of strings, or null)
- `parents` — the update's Parents header (array of strings, or null)
- `body` — the full body text (for snapshot updates)
- `patches` — array of `{range: [start, end], content: "..."}` (for incremental updates)

**For PUTs** (`method: "PUT"`), push the result:
```json
{"event": "ack", "data": {"status": 200}}
```

**On errors** (either type):
```json
{"event": "error", "data": {"message": "..."}}
```

Used by subscription, reliable-updates, and PUT tests.

#### `close-http` — Abort a braid_fetch subscription

```json
{"id": 2, "cmd": "close-http"}
```

Aborts the current `braid_fetch` subscription.

#### `sync-text` — Open a simpleton subscription

```json
{"id": 3, "cmd": "sync-text", "url": "http://127.0.0.1:4567/doc"}
```

| Field | Type   | Description |
|-------|--------|-------------|
| `url` | string | Full HTTP URL of the braid-text resource to subscribe to |

The client should start a `simpleton_client` (or equivalent) subscription to the given URL, wiring up `on_state` / `get_state` callbacks so the local buffer tracks remote state. Used by simpleton tests.

#### `edit` — Edit the local buffer

```json
{"id": 4, "cmd": "edit", "pos": 3, "len": 2, "text": "x"}
```

| Field  | Type   | Description |
|--------|--------|-------------|
| `pos`  | number | 0-based character index (not byte offset). Default: 0 |
| `len`  | number | Number of characters to remove. Default: 0 |
| `text` | string | Text to insert at `pos` after removing. Default: "" |

Mutates the local buffer and triggers a PUT to the server (via `simpleton.changed()` or equivalent). Covers insert (`len: 0`), delete (`text: ""`), and replace.

#### `send-text` — Return the current buffer contents

```json
{"id": 7, "cmd": "send-text"}
```

Response **must** include a `state` field:

```json
{"id": 7, "ok": true, "state": "current buffer text"}
```

#### `ack` — Block until all pending PUTs are acknowledged

```json
{"id": 8, "cmd": "ack"}
```

The client must not respond until every previously triggered PUT has received an ACK from the server. If there are no pending PUTs, respond immediately.

#### `end-sync` — Tear down the active simpleton subscription

```json
{"id": 9, "cmd": "end-sync"}
```

Aborts the current simpleton subscription. Does **not** clear the local buffer.

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
{"event": "update", "data": {...}}
{"event": "ack", "data": {"status": 200}}
{"event": "error", "data": {"message": "..."}}
```

See [examples/braid-text-simpleton-controller.js](examples/braid-text-simpleton-controller.js) for a complete reference implementation.

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
│  │  WebSocket, TCP, or stdio   │                         │
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
- **Client bridge** — communicates with the client under test via WebSocket, TCP (`lib/stream-bridge.js`), or stdin/stdout (`lib/client-bridge.js`). All transports use the same JSON-lines protocol.
- **Test suites** (`tests/`) — discrete, named tests with structured assertions.
