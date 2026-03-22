#!/usr/bin/env node

// braid-fuzz — unified CLI
//
// Usage:
//   braid-fuzz serve                          Start HTTP server, clients connect to it
//   braid-fuzz serve <cmd> [filter]           Spawn client subprocess and run tests
//   braid-fuzz client <cmd>                   (coming soon) Test a server via subprocess
//   braid-fuzz client <url>                   (coming soon) Test a server at a URL

var args = process.argv.slice(2)

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
braid-fuzz — test framework for braid-http implementations

Usage:
  braid-fuzz serve                        Start HTTP server, wait for client to connect
  braid-fuzz serve <cmd> [options]        Spawn <cmd> as subprocess, run tests against it
  braid-fuzz client <cmd|url>             (coming soon) Test a braid server implementation

Options:
  -<pattern>            Only run tests matching pattern (e.g. -reconnect, -BIS, -C)
  --port <n>            Fuzz server port (default: 4444, server mode only)
  --timeout <ms>        Per-test timeout (default: 30000)
  --json                Output results as JSON
  --server-port <n>     Fixed braid-text server port (default: auto)
  --proxy-port <n>      Fixed proxy port (default: auto)

Examples:
  braid-fuzz serve
  braid-fuzz serve "node ./clients/js-simpleton.js"
  braid-fuzz serve "node ./clients/js-simpleton.js" -reconnect
  braid-fuzz serve "emacs --batch --load ./clients/emacs-agent.el" -BIS
`)
    process.exit(0)
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
    // Separate our -filter args from passthrough options
    var cmd = null
    var child_args = []

    for (var i = 0; i < args.length; i++) {
        var arg = args[i]

        // Passthrough options (with values)
        if (arg === "--port" || arg === "--tcp-port" || arg === "--timeout" || arg === "--server-port" || arg === "--proxy-port") {
            child_args.push(arg, args[++i])
        }
        // Passthrough flags
        else if (arg === "--json") {
            child_args.push(arg)
        }
        // Filter: -something (single dash, not a known option)
        else if (arg.startsWith("-") && !arg.startsWith("--")) {
            child_args.push("--filter", arg.slice(1))
        }
        // First non-option, non-flag argument is the command
        else if (!cmd) {
            cmd = arg
        }
        // Additional positional args are also treated as filter
        else {
            child_args.push("--filter", arg)
        }
    }

    if (!cmd) {
        // Server mode — no subprocess
        var { spawn } = require("child_process")
        var child = spawn(process.execPath, [require("path").join(__dirname, "fuzz-server.js"), ...child_args], {
            stdio: "inherit"
        })
        child.on("exit", (code) => process.exit(code || 0))
    } else {
        // Subprocess mode
        var { spawn } = require("child_process")
        var child = spawn(process.execPath, [require("path").join(__dirname, "test-runner.js"), "--cmd", cmd, ...child_args], {
            stdio: "inherit"
        })
        child.on("exit", (code) => process.exit(code || 0))
    }
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
