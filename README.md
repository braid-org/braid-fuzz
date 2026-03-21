# braid-fuzz

Test framework for braid-http client implementations.  Helps you build a new braid-http client that syncs perfectly.  Great for guiding an AI.

Run your client through this gauntlet, and get back pass/fail results that an
AI agent (or human) can act on.

Currently tests:
- Core Braid-HTTP
   - [Versions](https://datatracker.ietf.org/doc/html/draft-toomim-httpbis-versions)
   - Updates
   - [Subscriptions](https://braid.org/protocol/subscriptions)
   - Multiresponse
   - [Reliable Updates](https://braid.org/protocol/reliable-updates)
- Applications:
  - Text sync (dt & [simpleton](https://braid.org/protocol/simpleton) merge types
  - [Multiplayer cursors](https://braid.org/protocol/cursors)
  - [Webindex](https://braid.org/protocol/web-index)

You tell it what command to run with `--cmd`, and it spawns that command as a subprocess, communicating via JSON-lines over stdin/stdout.

## Quick start

```
npm install
node test-runner.js --cmd "node ./clients/js-simpleton.js"
```

More examples:

```
node test-runner.js --cmd "node ./clients/js-simpleton.js" A1
node test-runner.js --cmd "node ./clients/js-simpleton.js" --json
node test-runner.js --cmd "emacs --batch --load ./clients/emacs-agent.el"
node test-runner.js --cmd "nvim --headless -u ./clients/nvim-agent.lua"
```

See [Client Agent Bridge Protocol](#client-agent-bridge-protocol) below for what the command needs to implement.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Test Runner (Node.js)                 │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Test Suites  │  │ Socket Proxy │  │ Braid-Text     │  │
│  │ A/B/C        │  │ (fault       │  │ Server         │  │
│  │              │  │  injection)  │  │ (real CRDT)    │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                 │                  │           │
│         ▼                 ▼                  │           │
│  ┌─────────────────────────────┐             │           │
│  │      Client Agent Bridge    │◄────────────┘           │
│  │  stdin/stdout JSON-lines    │                         │
│  └──────────┬──────────────────┘                         │
│             │                                            │
│             ▼                                            │
│  ┌─────────────────────────────┐                         │
│  │  emacs --batch / nvim       │                         │
│  │  --headless / JS client     │                         │
│  └─────────────────────────────┘                         │
└──────────────────────────────────────────────────────────┘
```

- **Test server** (`server.js`) — wraps `braid-text` with a control API for making server-side edits, reading state, and configuring behavior (ACK delays, PUT drops, etc.)
- **Socket proxy** (`proxy.js`) — TCP proxy between client and server. Supports modes: `passthrough`, `blackhole`, `rst`, `close`, `delay`, `corrupt`. Tests switch modes to simulate network faults.
- **Client bridge** (`lib/client-bridge.js`) — spawns the client and talks JSON-lines.
- **Test suites** (`tests/`) — discrete, named tests with structured assertions.

## Test suites

### A: Reconnect Scenarios (10 tests)

| Test | Description |
|------|-------------|
| ARC  | Clean reconnect — server closes subscription, client reconnects |
| ARST | TCP RST mid-stream — proxy injects RST, client recovers |
| ABH  | Silent connection death — blackhole, client detects via heartbeat |
| ASR  | Server restart — client reconnects after outage |
| AQP  | Reconnect with queued PUTs — unacked PUTs retried in order |
| ACY  | Rapid disconnect cycling — 5 disconnects in 10 seconds |
| AIF  | Disconnect during local edit — in-flight PUT retried, no duplicate |
| ASD  | Silent disconnect + remote edits — catch-up after blackhole |
| ABS  | Bad status then recovery — 503 → retry → success |
| ARA  | Retry-After header — 429 with Retry-After, client waits |

### B: Subscription Behavior (10 tests)

| Test | Description |
|------|-------------|
| BIS | Initial subscribe — buffer matches server state |
| BRP | Receive remote patch — server edit arrives in client |
| BMR | Receive multiple rapid patches — 10 edits, all applied in order |
| BEP | First PUT has empty Parents header — not omitted |
| BPR | Parents header on reconnect — delta sync after disconnect |
| BOP | Overlapping patches on reconnect — no duplicates |
| BHL | Heartbeat liveness — connection stays alive across heartbeats |
| BDV | Digest verification — Repr-Digest checked, states match |
| BMP2 | Multi-patch update — Patches: 2 in one update, all applied |
| BMP | Malformed patch — corruption detected, client recovers |

### C: Convergence (8 tests)

| Test | Description |
|------|-------------|
| CRT | Local edit round-trip — insert → PUT → ACK → states match |
| CCC | Concurrent edits converge — both sides insert at pos 0 |
| CIL | Interleaved edits — alternating client/server, all present |
| CDI | Delete + insert conflict — overlapping ranges converge |
| CLB | Large burst — 20 rapid local edits, all acknowledged |
| CED | Empty document — edits on fresh empty doc work |
| CDR | Edit during reconnect — offline edit merges on reconnect |
| CMC | Multi-client convergence — 2 clients + server all converge |

## Client Agent Bridge Protocol

The test runner communicates with the client via JSON-lines over stdin/stdout. The client must include a compatible agent that translates these commands. Each message is a single line of JSON terminated by `\n`.

Every command includes an `id` (integer, assigned by the runner) and a `cmd` (string). The client must echo back the same `id` in its response.

### Commands (runner → client)

#### `connect` — Open a Braid subscription to a URL

```json
{"id": 1, "cmd": "connect", "url": "http://127.0.0.1:4567/doc"}
```

| Field | Type   | Description |
|-------|--------|-------------|
| `url` | string | Full HTTP URL of the braid-text resource to subscribe to |

The client should start a `simpleton_client` (or equivalent) subscription to the given URL, wiring up `on_state` / `get_state` callbacks so the local buffer tracks remote state.

#### `insert` — Insert text at a character position

```json
{"id": 2, "cmd": "insert", "pos": 5, "text": "hello"}
```

| Field  | Type   | Description |
|--------|--------|-------------|
| `pos`  | number | 0-based character index (not byte offset) to insert before |
| `text` | string | Text to insert |

Mutates the local buffer and triggers a PUT to the server (via `simpleton.changed()` or equivalent).

#### `delete` — Delete characters at a position

```json
{"id": 3, "cmd": "delete", "pos": 3, "len": 2}
```

| Field | Type   | Description |
|-------|--------|-------------|
| `pos` | number | 0-based character index where deletion starts |
| `len` | number | Number of characters to delete |

#### `replace` — Replace a range of characters

```json
{"id": 4, "cmd": "replace", "pos": 3, "len": 2, "text": "x"}
```

| Field  | Type   | Description |
|--------|--------|-------------|
| `pos`  | number | 0-based character index where replacement starts |
| `len`  | number | Number of characters to remove |
| `text` | string | Replacement text (can be shorter, longer, or same length) |

Equivalent to a `delete` at `(pos, len)` followed by an `insert` at `(pos, text)`, but as a single operation.

#### `state` — Return the current buffer contents

```json
{"id": 5, "cmd": "state"}
```

No extra fields. The response **must** include a `state` field with the full buffer contents as a string:

```json
{"id": 5, "ok": true, "state": "current buffer text"}
```

#### `wait-ack` — Block until all pending PUTs are acknowledged

```json
{"id": 6, "cmd": "wait-ack"}
```

No extra fields. The client must not respond until every previously triggered PUT has received an ACK from the server. If there are no pending PUTs, respond immediately.

#### `kill-sub` — Tear down the active subscription

```json
{"id": 7, "cmd": "kill-sub"}
```

No extra fields. Aborts the current subscription (e.g., calls `simpleton.abort()`). Does **not** clear the local buffer. Tests use this to simulate client-side disconnects before re-connecting.

#### `kill-put` — Cancel any in-flight PUT request

```json
{"id": 8, "cmd": "kill-put"}
```

No extra fields. If the underlying client supports aborting in-flight PUTs, do so. Otherwise, acknowledge and no-op. The reference JS client treats this as a no-op.

#### `quit` — Shut down the client process

```json
{"id": 9, "cmd": "quit"}
```

No extra fields. The client should respond, clean up resources (abort subscriptions), and exit.

### Responses (client → runner)

Every response is a single JSON line containing the `id` from the command.

**Success:**

```json
{"id": 1, "ok": true}
```

**Success with data** (only `state` returns extra fields):

```json
{"id": 5, "ok": true, "state": "buffer contents here"}
```

**Error:**

```json
{"id": 1, "error": "description of what went wrong"}
```

### Writing a new client

Implement a process that reads JSON lines from stdin and writes JSON lines to stdout. See [clients/js-simpleton.js](clients/js-simpleton.js) for a complete reference implementation. Key points:

- All positions are **character offsets**, not byte offsets (relevant for multi-byte UTF-8).
- Diagnostic/debug output must go to **stderr**, never stdout — the runner parses stdout as protocol messages.
- The client must handle commands sequentially (respond to each before reading the next) except for `wait-ack`, which blocks until ACKs arrive.
- Unknown commands should return an error response, not crash.

## CLI options

```
node test-runner.js [options] [filter]

--cmd <command>      Command to spawn (required)
--filter <pattern>   Only run tests matching pattern
--json               Output results as JSON
--verbose            Show detailed output
--timeout <ms>       Per-test timeout (default: 30000)
--server-port <n>    Fixed server port (default: auto)
--proxy-port <n>     Fixed proxy port (default: auto)
```

## JSON output

```
node test-runner.js --cmd "node ./clients/js-simpleton.js" --json
```

```json
{
  "results": [
    {"id": "A1", "name": "Clean reconnect", "status": "pass", "duration_ms": 4521},
    {"id": "A2", "name": "TCP RST mid-stream", "status": "fail", "error": "...", "duration_ms": 10032}
  ],
  "summary": {"passed": 25, "failed": 2, "skipped": 0, "total": 28}
}
```
