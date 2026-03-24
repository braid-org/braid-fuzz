#!/usr/bin/env node

// braid-fuzz — test framework for braid-http client implementations
//
// Usage:
//   braid-fuzz                              Start server, clients connect to it
//   braid-fuzz <filter>                    Start server, only run matching tests
//   braid-fuzz <cmd>                        Spawn client subprocess and run tests
//   braid-fuzz <cmd> <filter>              Subprocess + filter

var args = process.argv.slice(2)

if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
braid-fuzz — test framework for braid-http implementations

Usage:
  braid-fuzz                              Start server, wait for client to connect
  braid-fuzz <filter>                    Start server, only run matching tests
  braid-fuzz <cmd>                        Spawn <cmd> as subprocess, run tests
  braid-fuzz <cmd> <filter>              Subprocess + filter

Options:
  --port <n>            WebSocket port (default: 4444, server mode only)
  --tcp-port <n>        TCP port (default: 4445, server mode only)
  --timeout <ms>        Per-test timeout (default: 30000)
  --json                Output results as JSON
  --server-port <n>     Fixed braid-text server port (default: auto)
  --proxy-port <n>      Fixed proxy port (default: auto)

Examples:
  braid-fuzz
  braid-fuzz simpleton
  braid-fuzz ./examples/braid-text-simpleton-launcher.sh
  braid-fuzz ./examples/braid-text-simpleton-launcher.sh reliable-updates
  braid-fuzz my-client-script subscriptions-3
`)
    process.exit(0)
}

// Test suite keywords — derived from filenames in tests/
var test_keywords = new Set(require("fs").readdirSync(require("path").join(__dirname, "tests"))
    .filter(f => f.endsWith(".js")).map(f => f.slice(0, -3)))
test_keywords.add("everything")

function is_test_filter(arg) {
    var lower = arg.toLowerCase()
    var keyword = lower.replace(/-\d+$/, "")
    return test_keywords.has(keyword)
}

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
    // Recognized test filter ("everything" means no filter)
    else if (is_test_filter(arg)) {
        if (arg.toLowerCase() !== "everything") filter = arg
    }
    // Everything else is the subprocess command
    else if (!cmd) {
        cmd = arg
    }
}

var { spawn } = require("child_process")
var path = require("path")
var script = cmd
    ? path.join(__dirname, "test-runner.js")
    : path.join(__dirname, "fuzz-server.js")
var spawn_args = cmd ? ["--cmd", cmd, ...child_args] : [...child_args]
if (filter) spawn_args.push(filter)

var child = spawn(process.execPath, [script, ...spawn_args], { stdio: "inherit" })
child.on("exit", (code) => process.exit(code || 0))

// ── Download spec files in the background ───────────────────

var fs = require("fs")
var https = require("https")

var specs_dir = path.join(__dirname, "specs")
if (!fs.existsSync(specs_dir)) fs.mkdirSync(specs_dir)

var spec_urls = [
    "https://braid.org/protocol/simpleton",
    "https://braid.org/protocol/subscriptions",
    "https://braid.org/protocol/reliable-updates",
    "https://braid.org/protocol/reliable-updates/tests",
]

for (var url of spec_urls) {
    var filename = url.replace("https://braid.org/protocol/", "").replace(/\//g, "-") + ".md"
    var filepath = path.join(specs_dir, filename)
    ;(function (url, filepath) {
        https.get(url, { headers: { "Accept": "text/plain" } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                https.get(res.headers.location, { headers: { "Accept": "text/plain" } }, res2 => {
                    var data = ""
                    res2.on("data", d => data += d)
                    res2.on("end", () => fs.writeFile(filepath, data, () => {}))
                }).on("error", () => {})
                return
            }
            var data = ""
            res.on("data", d => data += d)
            res.on("end", () => fs.writeFile(filepath, data, () => {}))
        }).on("error", () => {})
    })(url, filepath)
}
