# Build a Braid Client with Braid-Fuzz

Braid-Fuzz is a test framework for braid-http client implementations. It helps you build a new braid-http client that syncs perfectly. It's great for guiding an AI.

Run your client through this gauntlet, and get back pass/fail results that an AI agent (or human) can act on.

## First, connect your client to Braid-Fuzz

Implement a `controller` in your client that lets Braid-Fuzz control it.  For example, if your client runs in nodejs, you'd write:

```javascript
var readline = require('readline').createInterface({ input: process.stdin })
readline.on('line', (line) => {

  // The message is json
  var msg = JSON.parse(line)

  // Each message gives us a command
  switch (msg.cmd) {

    // The "hello" command tells us to reply back
    case "hello": {
      reply(msg.id)
      break
    }

    // The "results" gives us test results, and tells us to exit.
    case "results": {
      reply(msg.id)
      setTimeout(() => process.exit(0), 100)
      break
    }

    // You will implement additional commands here, to do things like edit
    // text, or open a HTTP network connection to a URL.

  }
})

// This is how we send data back to Braid-Fuzz
function reply(id, data) {
    process.stdout.write(JSON.stringify({ id, ok: true, ...data }) + "\n")
}
function reply_error(id, msg) {
    process.stdout.write(JSON.stringify({ id, error: msg }) + "\n")
}
```
(You can also communicate via TCP or WebSocket instead of STDIO if needed. See below.)


Now, write a headless `launch-script.sh`, that Braid-Fuzz can launch your client with.  Something like this:

```
#!/bin/bash
my-cool-client --headless --load-plugin=controller.js
```

Great!  Now install braid-fuzz, and test your connection to it:

 ```
 # Install braid-fuzz so you can run it as a command
 npm install -g braid-fuzz

 # Run the basic tests
 braid-fuzz <launch-script.sh> basics
 ```

## Jacked in? Now run the Feature Gauntlet!

For each feature below, you will:

- Add `controller` commands to test the feature
- Implement the feature
- Test with `braid-fuzz <launch-script.sh> <feature-name>`
- Fix the failures and iterate until tests pass!

<!--
### Basics: Connecting to Braid-Fuzz

This tests setting connecting and quitting from Braid-Fuzz.  Run with:

```
braid-fuzz <launch-client.sh> basics
```

Implement these commands:

| Command | JSON `cmd` | What to do |
|---------|-----------|------------|
| **Hello** | `hello` | Respond with `ok`. |
| **Results** | `results` | Receive test results. Respond with `ok`, then clean up and exit. |
-->

### Regular HTTP

This test whether your client can send a basic PUT and a GET.

Run these tests with:
```
braid-fuzz <launch-client.sh> http
```

Commands to implement:

| Command | JSON `cmd` | What to do |
|---------|-----------|------------|
| **Open HTTP request** | `open-http` | Call `braid_fetch(url, {subscribe: true, ...})`. Push each update back as an `update` event. |
| **Send PUT** | `open-http` | Call `braid_fetch(url, {method: "PUT", version, parents, patches, ...})`. Push result as `ack`. |


### Subscriptions and Updates

These test subscription parsing in detail: snapshots, incremental patches, multi-patch updates, Patches: 0, and the Parents header.

- [Subscriptions](https://braid.org/protocol/subscriptions): Making subscriptions, parsing streams of updates
- Updates: Patches and whatnot

Run these tests with:
```
braid-fuzz <launch-client.sh> subscriptions
```

You need just one more command:

| Command | JSON `cmd` | What to do |
|---------|-----------|------------|
| **Close HTTP request** | `close-http` | Abort the current `braid_fetch` subscription. |


### Reliable Updates

This tests your client's ability to recover from network failures gracefully:

- [Reliable Updates](https://braid.org/protocol/reliable-updates): Noticing and recovering from network failures 
  - Reconnection
  - Retry
  - Heartbeat detection
  - PUT retry

Run with:

```
braid-fuzz <launch-client.sh> reliable-updates
```

These use the same commands as above.

### Text Editing

This tests text edit synchronization, using the simpleton protocol:

- [Simpleton](https://braid.org/protocol/simpleton): the simpleton text sync protocol

Run these tests with:
```
braid-fuzz <launch-client.sh> simpleton
```

You need to implement these `controller` commands:

| Command | JSON `cmd` | What to do |
|---------|-----------|------------|
| **Sync text** | `sync-text` | Start a `simpleton_client` subscription to the given URL. |
| **End sync** | `end-sync` | Abort the simpleton subscription. |
| **Edit** | `edit` | Edit the local buffer at `pos`, removing `len` chars, inserting `text`. Triggers a PUT via `simpleton.changed()`. |
| **Send text** | `send-text` | Respond with `{"state": "current buffer text"}`. |
| **Ack** | `ack` | Block until all pending PUTs are acknowledged. |

### Multiplayer Cursors

This tests syncing cursor and locations and selections within text documents across multiple clients:

- [Cursors](https://braid.org/protocol/cursors)

```
TBD
```

### Indexes

This tests syncing directories of multiple files:

- [Webindex](https://braid.org/protocol/web-index)

```
TBD
```

### Putting it all together

You can run the full test-suite periodically to verify that prior features are still working with:

```
braid-fuzz <launch-script> everything
```

## Protocol Details

### Connection

**Stdin/Stdout**:
 - Each message is newline-delimited

**TCP**
 - Each message is newline-delimited
 - Client connects to `localhost:4445`

**WebSocket**:
 - Each message is a WebSocket message
 - Client connects to `ws://localhost:4444`

### Messages

Communication is JSON-RPC-like.  There is one command or response per line (stdin/stdout and TCP) or per message (WebSocket).

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

### Overview of commands


  - Basic commands
    - **Hello**: We begin! Respond with ok.
    - **Results**: Testing is done. Receive results and clean up.
  - HTTP commands
    - **Open HTTP** request
    - **Close HTTP** request
  - Text Sync commands
    - **Sync text**: Start syncing client text with a url
    - **End sync**: End syncing
    - **Edit**: Simulate a user text edit
    - **Send text**: Send a copy of the client's text buffer back to braid-fuzz
    - **Ack**: Notify braid-fuzz when all client edits to get acknowledged by server


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


## Extra stuff

### Example Scripts
See the example controller and launch script for braid-text simpleton: [braid-text-simpleton-controller.js](examples/braid-text-simpleton-controller.js), [braid-text-simpleton-launcher.sh](examples/braid-text-simpleton-launcher.sh).

### Reading specs from disk
When you run braid-fuzz, it automatically downloads the latest Braid protocol specs into the `specs/` directory. If you're using an AI agent to build your client, point it at these files for the full protocol details:
- `specs/subscriptions.md` — how subscriptions and update streams work ([source](https://braid.org/protocol/subscriptions))
- `specs/reliable-updates.md` — retry, reconnection, and heartbeat behavior ([source](https://braid.org/protocol/reliable-updates))
- `specs/reliable-updates-tests.md` — detailed test scenarios ([source](https://braid.org/protocol/reliable-updates/tests))
- `specs/simpleton.md` — the simpleton text sync protocol ([source](https://braid.org/protocol/simpleton))

