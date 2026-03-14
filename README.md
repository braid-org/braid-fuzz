# braid-fuzz

A headless test harness for Braid protocol editor plugins. Run discrete, named tests against an Emacs, Neovim, or any editor plugin — without a GUI — and get structured pass/fail results that an AI agent (or human) can act on.

You tell it what command to run with `--cmd`, and it spawns that command as a subprocess, communicating via JSON-lines over stdin/stdout.

## Quick start

```
npm install
node test-runner.js --cmd "node ./shims/js-simpleton.js"
```

More examples:

```
node test-runner.js --cmd "node ./shims/js-simpleton.js" A1
node test-runner.js --cmd "node ./shims/js-simpleton.js" --json
node test-runner.js --cmd "emacs --batch --load ./shims/emacs-agent.el"
node test-runner.js --cmd "nvim --headless -u ./shims/nvim-agent.lua"
```

See [Editor Agent Bridge Protocol](#editor-agent-bridge-protocol) below for what the command needs to implement.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Test Runner (Node.js)                  │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Test Suites  │  │ Socket Proxy │  │ Braid-Text     │  │
│  │ A/B/C        │  │ (fault       │  │ Server         │  │
│  │              │  │  injection)  │  │ (real CRDT)    │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                 │                   │           │
│         ▼                 ▼                   │           │
│  ┌─────────────────────────────┐              │           │
│  │      Editor Agent Bridge    │◄─────────────┘           │
│  │  stdin/stdout JSON-lines    │                          │
│  └──────────┬──────────────────┘                          │
│             │                                             │
│             ▼                                             │
│  ┌─────────────────────────────┐                          │
│  │  emacs --batch / nvim       │                          │
│  │  --headless / JS shim       │                          │
│  └─────────────────────────────┘                          │
└──────────────────────────────────────────────────────────┘
```

- **Test server** (`server.js`) — wraps `braid-text` with a control API for making server-side edits, reading state, and configuring behavior (ACK delays, PUT drops, etc.)
- **Socket proxy** (`proxy.js`) — TCP proxy between editor and server. Supports modes: `passthrough`, `blackhole`, `rst`, `close`, `delay`, `corrupt`. Tests switch modes to simulate network faults.
- **Editor bridge** (`lib/editor-bridge.js`) — spawns the editor and talks JSON-lines.
- **Test suites** (`tests/`) — discrete, named tests with structured assertions.

## Test suites

### A: Reconnect Scenarios (10 tests)

| Test | Description |
|------|-------------|
| A1 | Clean reconnect — server closes subscription, client reconnects |
| A2 | TCP RST mid-stream — proxy injects RST, client recovers |
| A3 | Silent connection death — blackhole, client detects via heartbeat |
| A4 | Server restart — client reconnects after outage |
| A5 | Reconnect with queued PUTs — unacked PUTs retried in order |
| A6 | Rapid disconnect cycling — 5 disconnects in 10 seconds |
| A7 | Disconnect during local edit — in-flight PUT retried, no duplicate |
| A8 | Silent disconnect + remote edits — catch-up after blackhole |
| A9 | Bad status then recovery — 503 → retry → success |
| A10 | Retry-After header — 429 with Retry-After, client waits |

### B: Subscription Behavior (8 tests)

| Test | Description |
|------|-------------|
| B1 | Initial subscribe — buffer matches server state |
| B2 | Receive remote patch — server edit arrives in editor |
| B3 | Receive multiple rapid patches — 10 edits, all applied in order |
| B4 | Parents header on reconnect — delta sync after disconnect |
| B5 | Overlapping patches on reconnect — no duplicates |
| B6 | Heartbeat liveness — connection stays alive across heartbeats |
| B7 | Digest verification — Repr-Digest checked, states match |
| B8 | Malformed patch — corruption detected, client recovers |

### C: Convergence (8 tests)

| Test | Description |
|------|-------------|
| C1 | Local edit round-trip — insert → PUT → ACK → states match |
| C2 | Concurrent edits converge — both sides insert at pos 0 |
| C3 | Interleaved edits — alternating client/server, all present |
| C4 | Delete + insert conflict — overlapping ranges converge |
| C5 | Large burst — 20 rapid local edits, all acknowledged |
| C6 | Empty document — edits on fresh empty doc work |
| C7 | Edit during reconnect — offline edit merges on reconnect |
| C8 | Multi-client convergence — 2 editors + server all converge |

## Editor Agent Bridge Protocol

The test runner communicates with the editor via JSON-lines over stdin/stdout. The editor plugin must include a thin "agent shim" that translates these commands.

**Commands (runner → editor):**

```json
{"id": 1, "cmd": "connect", "url": "http://..."}
{"id": 2, "cmd": "insert", "pos": 5, "text": "hello"}
{"id": 3, "cmd": "delete", "pos": 3, "len": 2}
{"id": 4, "cmd": "replace", "pos": 3, "len": 2, "text": "x"}
{"id": 5, "cmd": "state"}
{"id": 6, "cmd": "wait-ack"}
{"id": 7, "cmd": "kill-sub"}
{"id": 8, "cmd": "quit"}
```

**Responses (editor → runner):**

```json
{"id": 1, "ok": true}
{"id": 5, "ok": true, "state": "buffer contents here"}
{"id": 8, "ok": true}
```

On error: `{"id": 1, "error": "description"}`

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
node test-runner.js --cmd "node ./shims/js-simpleton.js" --json
```

```json
{
  "results": [
    {"id": "A1", "name": "Clean reconnect", "status": "pass", "duration_ms": 4521},
    {"id": "A2", "name": "TCP RST mid-stream", "status": "fail", "error": "...", "duration_ms": 10032}
  ],
  "summary": {"passed": 24, "failed": 2, "skipped": 0, "total": 26}
}
```
