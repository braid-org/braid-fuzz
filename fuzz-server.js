#!/usr/bin/env node

// braid-fuzz server mode
//
// Instead of spawning a client subprocess, this starts an HTTP server
// that clients connect TO. The client opens a long-lived GET to receive
// JSON-line commands, and sends JSON-line responses back via PUT.
//
// Protocol:
//   GET  /fuzz          — long-lived response streaming JSON-line commands
//   PUT  /fuzz          — client sends JSON-line responses (one per PUT body)
//
// The first line of the GET response is a JSON object with a "session" field.
// The client must include this session ID in PUT requests (either as
// ?session=ID in the query string, or as an X-Session-Id header).
//
// Commands and responses use the same JSON-lines protocol as the subprocess
// mode (see README). Each command has an "id" and "cmd"; each response
// echoes the "id" and includes "ok": true or "error": "...".
//
// The test suite runs automatically when a client connects.
//
// Usage:
//   node fuzz-server.js [options]
//
// Options:
//   --port <n>          Port for the fuzz server (default: 4444)
//   --filter <pattern>  Only run tests matching pattern
//   --json              Output results as JSON
//   --timeout <ms>      Per-test timeout (default: 30000)
//   --server-port <n>   Fixed braid-text server port (default: auto)
//   --proxy-port <n>    Fixed proxy port (default: auto)

var http = require("http")
var { TestServer } = require("./server")
var { SocketProxy } = require("./proxy")
var { ClientBridge } = require("./lib/client-bridge")
var { HttpBridge } = require("./lib/http-bridge")
var { random_id, sleep } = require("./lib/assertions")

// ── Parse CLI args ──────────────────────────────────────────────

var args = process.argv.slice(2)
var opts = {
    port: 4444,
    filter: null,
    json: false,
    timeout: 30000,
    server_port: 0,
    proxy_port: 0,
}

for (var i = 0; i < args.length; i++) {
    switch (args[i]) {
        case "--port":        opts.port = parseInt(args[++i]); break
        case "--filter":      opts.filter = args[++i]; break
        case "--json":        opts.json = true; break
        case "--timeout":     opts.timeout = parseInt(args[++i]); break
        case "--server-port": opts.server_port = parseInt(args[++i]); break
        case "--proxy-port":  opts.proxy_port = parseInt(args[++i]); break
        default:
            if (!args[i].startsWith("-")) opts.filter = args[i]
    }
}

// ── Load test suites ────────────────────────────────────────────

var suites = [

    { name: "Subscriptions",   tests: require("./tests/subscriptions") },
    { name: "Reconnects",      tests: require("./tests/reconnects") },
    { name: "Simpleton",       tests: require("./tests/simpleton") },
]

function get_tests(filter) {
    var all = []
    for (var suite of suites) {
        for (var test of suite.tests) {
            test._suite = suite.name
            if (!filter || test.id.toLowerCase().includes(filter.toLowerCase()) ||
                test.name.toLowerCase().includes(filter.toLowerCase())) {
                all.push(test)
            }
        }
    }
    return all
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
    var server = new TestServer({ port: opts.server_port })
    var server_port = await server.start()

    var proxy = new SocketProxy({
        listen_port: opts.proxy_port,
        target_host: "127.0.0.1",
        target_port: server_port,
    })
    var proxy_port = await proxy.start()

    var base_url = `http://127.0.0.1:${proxy_port}`

    // ── Sessions ────────────────────────────────────────────

    var sessions = new Map()  // session_id -> session

    var fuzz_server = http.createServer(async (req, res) => {
        // CORS
        res.setHeader("Access-Control-Allow-Origin", "*")
        res.setHeader("Access-Control-Allow-Methods", "*")
        res.setHeader("Access-Control-Allow-Headers", "*")
        res.setHeader("Access-Control-Expose-Headers", "*")
        if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return }

        var url = new URL(req.url, "http://localhost")
        var pathname = url.pathname

        if (pathname !== "/fuzz") {
            res.writeHead(404)
            res.end("Not found. Connect to GET /fuzz to start a test session.\n")
            return
        }

        if (req.method === "GET") {
            await handle_get(req, res, url, { server, proxy, base_url, sessions })
        } else if (req.method === "PUT") {
            await handle_put(req, res, url, { sessions })
        } else {
            res.writeHead(405)
            res.end("Use GET to open a test session, PUT to send responses.\n")
        }
    })

    fuzz_server.listen(opts.port, "127.0.0.1", () => {
        opts.port = fuzz_server.address().port
        console.log(`\nbraid-fuzz server`)
        console.log(`  fuzz:    http://127.0.0.1:${opts.port}/fuzz`)
        console.log(`  server:  127.0.0.1:${server_port}`)
        console.log(`  proxy:   127.0.0.1:${proxy_port}`)
        console.log(`  tests:   ${get_tests(opts.filter).length}`)
        console.log()
        console.log(`Waiting for a client to connect...`)
        console.log()
    })
}

// ── GET /fuzz — open a test session ─────────────────────────────

async function handle_get(req, res, url, { server, proxy, base_url, sessions }) {
    var filter = url.searchParams.get("filter") || opts.filter

    var session_id = random_id(12)
    var session = {
        id: session_id,
        pending: new Map(),
        server_base_url: base_url,
        bridge: null,
        closed: false,
    }
    sessions.set(session_id, session)

    // Long-lived response
    res.writeHead(200, {
        "Content-Type": "application/json-lines",
        "Cache-Control": "no-cache",
        "Transfer-Encoding": "chunked",
        "X-Session-Id": session_id,
    })

    // First message: session ID so the client knows where to PUT
    res.write(JSON.stringify({ session: session_id }) + "\n")

    res.on("close", () => {
        session.closed = true
        sessions.delete(session_id)
        for (var [, { reject, timer }] of session.pending) {
            clearTimeout(timer)
            reject(new Error("Client disconnected"))
        }
        session.pending.clear()
    })

    // Run tests
    var all_tests = get_tests(filter)

    console.log(`Client connected (session ${session_id}), running ${all_tests.length} tests...`)
    console.log()

    var results = []
    var passed = 0, failed = 0, skipped = 0

    for (var test of all_tests) {
        if (session.closed) break

        var result = await run_test(test, { server, proxy, base_url, session, res })
        results.push(result)

        if (result.status === "pass") passed++
        else if (result.status === "fail") failed++
        else skipped++

        if (!opts.json) {
            var tag = result.status === "pass" ? "PASS" :
                      result.status === "fail" ? "FAIL" : "SKIP"
            var dots = ".".repeat(Math.max(1, 50 - test.id.length - test.name.length))
            console.log(`  ${test.id}  ${test.name} ${dots} ${tag}`)
            if (result.status === "fail") {
                console.log(`        ${result.error}`)
            }
        }
    }

    if (!opts.json) {
        console.log()
        console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped (${all_tests.length} total)`)
        console.log()
    }

    // Final message: results summary
    var summary = { results, summary: { passed, failed, skipped, total: all_tests.length } }
    res.write(JSON.stringify({ done: true, ...summary }) + "\n")

    if (opts.json) {
        console.log(JSON.stringify(summary, null, 2))
    }

    res.end()
    sessions.delete(session_id)
}

// ── PUT /fuzz — receive a response from the client ──────────────

async function handle_put(req, res, url, { sessions }) {
    var session_id = url.searchParams.get("session")
        || req.headers["x-session-id"]

    if (!session_id || !sessions.has(session_id)) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: "Unknown session. Include ?session=ID or X-Session-Id header." }) + "\n")
        return
    }

    var session = sessions.get(session_id)

    var body = ""
    req.on("data", d => body += d)
    await new Promise(resolve => req.on("end", resolve))

    var lines = body.split("\n").filter(l => l.trim())
    for (var line of lines) {
        try {
            var msg = JSON.parse(line)
            if (session.bridge) {
                session.bridge._handle_response(msg)
            }
        } catch (e) {
            // ignore parse errors
        }
    }

    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: true }) + "\n")
}

// ── Run a single test ───────────────────────────────────────────

async function run_test(test, { server, proxy, base_url, session, res }) {
    var doc = `/test-doc-${test.id.toLowerCase()}-${random_id()}`
    var client = null
    var extra_clients = []
    var start_time = Date.now()

    try {
        // Reset state between tests
        proxy.reset()
        server.ack_delay_ms = 0
        server.drop_puts = false
        server.drop_acks = false
        server.heartbeat_seconds = 0
        server._on_put = null
        server._on_get = null
        server._on_subscribe = null

        // The client under test talks over HTTP
        client = new HttpBridge({ res, session })
        session.bridge = client
        await client.start()

        // Extra clients (for multi-client tests like CMC) use the
        // reference JS implementation as a local subprocess
        if (test.needs_extra_client) {
            var extra = new ClientBridge({
                command: process.execPath,
                args: [require("path").join(__dirname, "clients", "js-simpleton.js")],
                server_base_url: base_url,
            })
            await extra.start()
            extra_clients.push(extra)
        }

        await Promise.race([
            test.run({ server, proxy, client, doc, base_url, extra_clients }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Test timed out after ${opts.timeout}ms`)), opts.timeout)
            ),
        ])

        return {
            id: test.id, name: test.name, status: "pass",
            duration_ms: Date.now() - start_time,
        }
    } catch (e) {
        return {
            id: test.id, name: test.name, status: "fail",
            error: e.message,
            duration_ms: Date.now() - start_time,
        }
    } finally {
        if (client) await client.stop().catch(() => {})
        for (var ex of extra_clients) await ex.stop().catch(() => {})
        session.bridge = null
    }
}

main().catch(e => { console.error(e); process.exit(1) })
