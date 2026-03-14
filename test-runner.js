#!/usr/bin/env node

// braid-fuzz — Test Runner
//
// Orchestrates the test server, socket proxy, and editor bridge to run
// named, discrete tests against a headless editor plugin.
//
// Usage:
//   node test-runner.js [options]
//
// Options:
//   --cmd <command>      Command to spawn (required — see examples below)
//   --filter <pattern>   Only run tests matching pattern (e.g. "A1", "A", "reconnect")
//   --json               Output results as JSON (for machine consumption)
//   --verbose            Show detailed output for each test
//   --timeout <ms>       Per-test timeout (default: 30000)
//   --server-port <n>    Fixed server port (default: auto)
//   --proxy-port <n>     Fixed proxy port (default: auto)
//
// Examples:
//   node test-runner.js --cmd "node ./shims/js-simpleton.js"
//   node test-runner.js --cmd "emacs --batch --load ./shims/emacs-agent.el"
//   node test-runner.js --cmd "nvim --headless -u ./shims/nvim-agent.lua"
//   node test-runner.js --cmd "node ./shims/js-simpleton.js" A1

var { TestServer } = require("./server")
var { SocketProxy } = require("./proxy")
var { EditorBridge } = require("./lib/editor-bridge")
var { random_id, sleep } = require("./lib/assertions")

// ── Parse CLI args ──────────────────────────────────────────────

var args = process.argv.slice(2)
var opts = {
    cmd: null,
    filter: null,
    json: false,
    verbose: false,
    timeout: 30000,
    server_port: 0,
    proxy_port: 0,
}

for (var i = 0; i < args.length; i++) {
    switch (args[i]) {
        case "--cmd":        opts.cmd = args[++i]; break
        case "--filter":     opts.filter = args[++i]; break
        case "--json":       opts.json = true; break
        case "--verbose":    opts.verbose = true; break
        case "--timeout":    opts.timeout = parseInt(args[++i]); break
        case "--server-port": opts.server_port = parseInt(args[++i]); break
        case "--proxy-port":  opts.proxy_port = parseInt(args[++i]); break
        default:
            if (!args[i].startsWith("-")) opts.filter = args[i]
    }
}

if (!opts.cmd) {
    console.error("Error: --cmd is required. Example: --cmd \"node ./shims/js-simpleton.js\"")
    process.exit(1)
}

// Split command string into command + args
var cmd_parts = opts.cmd.match(/(?:[^\s"]+|"[^"]*")+/g) || []
var cmd_program = cmd_parts[0]
var cmd_args = cmd_parts.slice(1).map(s => s.replace(/^"|"$/g, ""))

// ── Load test suites ────────────────────────────────────────────

var suites = [
    { name: "A: Reconnect Scenarios",    tests: require("./tests/a-reconnect") },
    { name: "B: Subscription Behavior",  tests: require("./tests/b-subscription") },
    { name: "C: Convergence",            tests: require("./tests/c-convergence") },
]

var all_tests = []
for (var suite of suites) {
    for (var test of suite.tests) {
        test._suite = suite.name
        if (!opts.filter || test.id.toLowerCase().includes(opts.filter.toLowerCase()) ||
            test.name.toLowerCase().includes(opts.filter.toLowerCase())) {
            all_tests.push(test)
        }
    }
}

// ── Run ─────────────────────────────────────────────────────────

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

    if (!opts.json) {
        console.log(`\nbraid-fuzz test runner`)
        console.log(`  server:  127.0.0.1:${server_port}`)
        console.log(`  proxy:   127.0.0.1:${proxy_port}`)
        console.log(`  cmd:     ${opts.cmd}`)
        console.log(`  tests:   ${all_tests.length}`)
        console.log()
    }

    var results = []
    var passed = 0, failed = 0, skipped = 0

    for (var test of all_tests) {
        var result = await run_test(test, { server, proxy, base_url })
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

    if (opts.json) {
        console.log(JSON.stringify({
            results,
            summary: { passed, failed, skipped, total: all_tests.length }
        }, null, 2))
    }

    await proxy.stop()
    await server.stop()

    process.exit(failed > 0 ? 1 : 0)
}

async function run_test(test, { server, proxy, base_url }) {
    var doc = `/test-doc-${test.id.toLowerCase()}-${random_id()}`
    var editor = null
    var extra_editors = []
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

        editor = create_editor(base_url)
        await editor.start()

        if (test.needs_extra_editor) {
            var extra = create_editor(base_url)
            await extra.start()
            extra_editors.push(extra)
        }

        await Promise.race([
            test.run({ server, proxy, editor, doc, base_url, extra_editors }),
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
        if (editor) await editor.stop().catch(() => {})
        for (var ex of extra_editors) await ex.stop().catch(() => {})
    }
}

function create_editor(base_url) {
    return new EditorBridge({ command: cmd_program, args: cmd_args, server_base_url: base_url })
}

main().catch(e => { console.error(e); process.exit(1) })
