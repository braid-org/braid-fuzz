#!/usr/bin/env node

// braid-fuzz server mode
//
// Starts a server that clients connect TO for testing. Supports three
// transports — clients can connect via whichever is easiest for them:
//
//   WebSocket   ws://127.0.0.1:4444
//   TCP         127.0.0.1:4445
//
// All transports use the same protocol: newline-delimited JSON.
// The test suite runs automatically when a client connects.
//
// Usage:
//   node fuzz-server.js [options]
//
// Options:
//   --port <n>          WebSocket port (default: 4444)
//   --tcp-port <n>      TCP port (default: 4445)
//   <filter>            Only run tests matching filter (e.g. simpleton, subscriptions-3)
//   --json              Output results as JSON
//   --timeout <ms>      Per-test timeout (default: 30000)
//   --server-port <n>   Fixed braid-text server port (default: auto)
//   --proxy-port <n>    Fixed proxy port (default: auto)

var net = require("net")
var http = require("http")
var { WebSocketServer } = require("ws")
var { TestServer } = require("./server")
var { SocketProxy } = require("./proxy")
var { ClientBridge } = require("./lib/client-bridge")
var { StreamBridge } = require("./lib/stream-bridge")
var { random_id, sleep } = require("./lib/assertions")

// ── Parse CLI args ──────────────────────────────────────────────

var args = process.argv.slice(2)
var opts = {
    port: 4444,
    tcp_port: 4445,
    filter: null,
    json: false,
    timeout: 30000,
    server_port: 0,
    proxy_port: 0,
}

for (var i = 0; i < args.length; i++) {
    switch (args[i]) {
        case "--port":        opts.port = parseInt(args[++i]); break
        case "--tcp-port":    opts.tcp_port = parseInt(args[++i]); break
        case "--json":        opts.json = true; break
        case "--timeout":     opts.timeout = parseInt(args[++i]); break
        case "--server-port": opts.server_port = parseInt(args[++i]); break
        case "--proxy-port":  opts.proxy_port = parseInt(args[++i]); break
        default:
            if (!args[i].startsWith("-")) opts.filter = args[i]
    }
}

// ── Load test suites ────────────────────────────────────────────

var suites = require("fs").readdirSync(require("path").join(__dirname, "tests"))
    .filter(f => f.endsWith(".js")).sort()
    .map(f => ({ name: f.slice(0, -3), tests: require("./tests/" + f) }))

function get_tests(filter) {
    var all = []
    for (var suite of suites) {
        for (var test of suite.tests) {
            test._suite = suite.name
            if (!filter || test.id.toLowerCase().startsWith(filter.toLowerCase())) {
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
    var context = { server, proxy, base_url }

    // ── WebSocket server ────────────────────────────────────

    var http_server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" })
        res.end("braid-fuzz server. Connect via WebSocket or TCP.\n")
    })

    var wss = new WebSocketServer({ server: http_server })

    wss.on("connection", (ws, req) => {
        var url = new URL(req.url || "/", "http://localhost")
        var filter = url.searchParams.get("filter") || opts.filter

        handle_connection(
            "WebSocket",
            data => ws.send(data),
            handler => {
                ws.on("message", data => handler(data.toString()))
                ws.on("close", () => handler(null))
            },
            filter,
            context
        )
    })

    http_server.listen(opts.port, "127.0.0.1", () => {
        opts.port = http_server.address().port
    })

    // ── TCP server ──────────────────────────────────────────

    var tcp_server = net.createServer(socket => {
        var buf = ""

        handle_connection(
            "TCP",
            data => socket.write(data),
            handler => {
                socket.on("data", chunk => {
                    buf += chunk
                    var lines = buf.split("\n")
                    buf = lines.pop()  // keep incomplete line
                    for (var line of lines) {
                        if (line.trim()) handler(line)
                    }
                })
                socket.on("close", () => handler(null))
                socket.on("error", () => handler(null))
            },
            opts.filter,
            context
        )
    })

    tcp_server.listen(opts.tcp_port, "127.0.0.1", () => {
        opts.tcp_port = tcp_server.address().port

        console.log(`\nbraid-fuzz server`)
        console.log(`  ws:      ws://127.0.0.1:${opts.port}`)
        console.log(`  tcp:     127.0.0.1:${opts.tcp_port}`)
        console.log(`  server:  127.0.0.1:${server_port}`)
        console.log(`  proxy:   127.0.0.1:${proxy_port}`)
        console.log(`  tests:   ${get_tests(opts.filter).length}`)
        console.log()
        console.log(`Waiting for a client to connect...`)
        console.log()
    })
}

// ── Handle a new client connection (any transport) ──────────────

function handle_connection(transport, send_fn, on_message, filter, { server, proxy, base_url }) {
    var session = {
        id: random_id(12),
        pending: new Map(),
        server_base_url: base_url,
        bridge: null,
        closed: false,
    }

    // Route incoming messages to the bridge
    on_message(data => {
        if (data === null) {
            // Connection closed
            session.closed = true
            for (var [, { reject, timer }] of session.pending) {
                clearTimeout(timer)
                reject(new Error("Client disconnected"))
            }
            session.pending.clear()
            return
        }

        var lines = data.split ? data.split("\n") : [data]
        for (var line of lines) {
            if (typeof line !== "string") line = line.toString()
            line = line.trim()
            if (!line) continue
            try {
                var msg = JSON.parse(line)
                if (session.bridge) session.bridge._handle_response(msg)
            } catch (e) {}
        }
    })

    // Run tests
    run_session(transport, send_fn, session, filter, { server, proxy, base_url })
}

async function run_session(transport, send_fn, session, filter, { server, proxy, base_url }) {
    var all_tests = get_tests(filter)

    console.log(`${transport} client connected (${session.id}), running ${all_tests.length} tests...`)
    console.log()

    var results = []
    var passed = 0, failed = 0, skipped = 0

    for (var test of all_tests) {
        if (session.closed) break

        var result = await run_test(test, { server, proxy, base_url, session, send_fn })
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

    var summary = { results, summary: { passed, failed, skipped, total: all_tests.length } }
    send_fn(JSON.stringify({ cmd: "results", ...summary }) + "\n")

    if (opts.json) {
        console.log(JSON.stringify(summary, null, 2))
    }
}

// ── Run a single test ───────────────────────────────────────────

async function run_test(test, { server, proxy, base_url, session, send_fn }) {
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

        client = new StreamBridge({ send_fn, session })
        session.bridge = client
        await client.start()

        // Extra clients use the reference JS implementation as local subprocesses
        var num_extra = test.needs_extra_clients || (test.needs_extra_client ? 1 : 0)
        for (var ei = 0; ei < num_extra; ei++) {
            var extra = new ClientBridge({
                command: process.execPath,
                args: [require("path").join(__dirname, "examples", "braid-text-simpleton-controller.js")],
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
