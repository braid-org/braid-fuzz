#!/usr/bin/env node

// braid-fuzz — unified CLI
//
// Usage:
//   braid-fuzz serve                          Start server, clients connect to it
//   braid-fuzz serve <filter>                Start server, only run matching tests
//   braid-fuzz serve <cmd>                    Spawn client subprocess and run tests
//   braid-fuzz serve <cmd> <filter>          Subprocess + filter
//   braid-fuzz client <cmd|url>               (coming soon) Test a server

var args = process.argv.slice(2)

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
braid-fuzz — test framework for braid-http implementations

Usage:
  braid-fuzz serve                        Start server, wait for client to connect
  braid-fuzz serve <filter>              Start server, only run matching tests
  braid-fuzz serve <cmd>                  Spawn <cmd> as subprocess, run tests
  braid-fuzz serve <cmd> <filter>        Subprocess + filter
  braid-fuzz client <cmd|url>             (coming soon) Test a braid server

Options:
  --port <n>            WebSocket port (default: 4444, server mode only)
  --tcp-port <n>        TCP port (default: 4445, server mode only)
  --timeout <ms>        Per-test timeout (default: 30000)
  --json                Output results as JSON
  --server-port <n>     Fixed braid-text server port (default: auto)
  --proxy-port <n>      Fixed proxy port (default: auto)

Examples:
  braid-fuzz serve
  braid-fuzz serve simpleton
  braid-fuzz serve "node ./clients/js-simpleton.js"
  braid-fuzz serve "node ./clients/js-simpleton.js" reliable-updates
  braid-fuzz serve my-client-script subscriptions-3
`)
    process.exit(0)
}

// Test suite keywords — derived from filenames in tests/
var test_keywords = new Set(require("fs").readdirSync(require("path").join(__dirname, "tests"))
    .filter(f => f.endsWith(".js")).map(f => f.slice(0, -3)))

function is_test_filter(arg) {
    var lower = arg.toLowerCase()
    var keyword = lower.replace(/-\d+$/, "")
    return test_keywords.has(keyword)
}

var subcommand = args[0]

if (subcommand === "serve") {
    run_serve(args.slice(1))
} else if (subcommand === "client") {
    run_client(args.slice(1))
} else {
    console.error(`Unknown subcommand: "${subcommand}". Use "serve" or "client".`)
    console.error(`Run "braid-fuzz --help" for usage.`)
    process.exit(1)
}

// ── serve ───────────────────────────────────────────────────────

function run_serve(args) {
    var cmd = null
    var filter = null
    var child_args = []

    for (var i = 0; i < args.length; i++) {
        var arg = args[i]

        // Options with values
        if (arg === "--port" || arg === "--tcp-port" || arg === "--timeout" || arg === "--server-port" || arg === "--proxy-port") {
            child_args.push(arg, args[++i])
        }
        // Flags
        else if (arg === "--json") {
            child_args.push(arg)
        }
        // Recognized test filter
        else if (is_test_filter(arg)) {
            filter = arg
        }
        // Everything else is the subprocess command
        else if (!cmd) {
            cmd = arg
        }
    }

    var { spawn } = require("child_process")
    var script = cmd
        ? require("path").join(__dirname, "test-runner.js")
        : require("path").join(__dirname, "fuzz-server.js")
    var spawn_args = cmd ? ["--cmd", cmd, ...child_args] : [...child_args]
    if (filter) spawn_args.push(filter)

    var child = spawn(process.execPath, [script, ...spawn_args], { stdio: "inherit" })
    child.on("exit", (code) => process.exit(code || 0))
}

// ── client (stub) ───────────────────────────────────────────────

function run_client(args) {
    if (args.length === 0) {
        console.error(`Usage: braid-fuzz client <cmd|url>`)
        console.error(``)
        console.error(`  braid-fuzz client "node ./servers/my-server.js"   Test a server via subprocess`)
        console.error(`  braid-fuzz client http://localhost:3000           Test a server at a URL`)
        process.exit(1)
    }

    var target = args[0]
    var is_url = target.startsWith("http://") || target.startsWith("https://")

    if (is_url) {
        console.log(`Server testing at ${target} — coming soon!`)
    } else {
        console.log(`Server testing via subprocess "${target}" — coming soon!`)
    }
    console.log()
    console.log(`This will run braid-fuzz as a client, testing a braid server implementation.`)
    console.log(`Currently, only "braid-fuzz serve" (testing clients) is implemented.`)
    process.exit(0)
}
