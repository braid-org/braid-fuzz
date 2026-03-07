# braid-fuzz

A browser-based dashboard for fuzz-testing simpleton-sync clients. It orchestrates randomized editing sessions, simulates network disruptions, and verifies that all clients converge to the correct document state.

Extracted from [`braid-text/test/simpleton-fuzz-server`](https://github.com/braid-org/braid-text).

## Setup

```
npm install
npm start
```

The server runs on `https://localhost:4920` with a self-signed cert (HTTP/2).

- Dashboard: `https://localhost:4920/`
- Test client: `https://localhost:4920/test`

To use a different port: `node server.js 8080`

## Configuration

The dashboard exposes the following tunable parameters:

| Parameter | Description |
|---|---|
| **Session duration** (ms) | How long a fuzz editing session runs |
| **Settle delay** (ms) | Time to wait after editing stops for clients to converge |
| **Edit interval** (ms, min-max) | Random range between simulated edits |
| **ACK delay** (ms, min-max) | Artificial delay on server acknowledgments |
| **Connected duration** (ms, min-max) | How long a client stays connected before a simulated disconnect (server waits for client to reconnect) |
| **PUT drop probability** (%) | Chance that a PUT (outgoing edit) is silently dropped |
| **ACK drop probability** (%) | Chance that an ACK (server acknowledgment) is silently dropped |
| **Silent disconnect probability** (%) | Chance that a disconnect is "silent" — server stops sending data but keeps the TCP socket open (simulates wifi going down) |

All parameters are live-editable and pushed to the server immediately on change.

## Connecting a Simpleton Client

1. **Subscribe** to `/fuzz-session` (GET with `Subscribe` header). Optionally set a `Peer` header to name your client.

2. **Receive start message** -- the server sends:
   ```json
   {"type": "start", "peer": "...", "doc_key": "/fuzz-doc-..."}
   ```
   Use `doc_key` to connect your simpleton-sync client.

3. **Apply edit commands** -- the server sends edit commands to simulate local user typing. Apply them to your document and call `changed()`:
   ```json
   {"type": "edit", "range": [5, 5], "content": "a"}       // insert
   {"type": "edit", "range": [3, 5], "content": ""}        // delete
   {"type": "edit", "range": [3, 5], "content": "x"}       // replace
   ```
   `range` is `[start, end]` in the text. Clamp both values to your actual text length.

4. **Handle remote edits** -- the server also makes remote edits (via PUT) which arrive through the normal simpleton-sync subscription. These updates include a `Repr-Digest` header (SHA-256). Your client should verify that the digest matches your document state after applying patches -- throw/crash on mismatch (don't try to recover).

5. **Upload final state** -- when you receive `{"type": "upload-state"}`, POST your final document text to `/fuzz-session` as:
   ```json
   {"type": "state", "peer": "...", "state": "..."}
   ```
   The server compares it to the expected state.

## Dashboard UI

Each connected client gets a status bar showing:

- **Connection indicator** (green = connected, orange = disconnected, grey = offline)
- **Progress bar** showing elapsed time in the current phase (green = fuzzing, blue = settling)
- **Status text** with time remaining and current phase
- **PASS/FAIL badge** after the session completes

On failure, the bar auto-expands to show the expected (server) state and actual (client) state side-by-side for debugging.

An error banner appears at the top if any errors occur during testing.

## How It Works

The dashboard subscribes to two Braid resources:

- **`/config`** -- live configuration and session state (peer connection details, progress)
- **`/fuzz-results`** -- pass/fail results for completed sessions

The `/test` endpoint runs the protocol using the JS reference implementation of simpleton-sync.
