#!/usr/bin/env node

// Reference client agent for the braid-fuzz test runner.
//
// This is a standalone Node.js process that:
//   1. Reads JSON commands from stdin (one per line)
//   2. Uses the reference simpleton-sync client to talk to a braid-text server
//   3. Writes JSON responses to stdout (one per line)
//
// Usage with the test runner:
//   node test-runner.js --cmd "node ./clients/js-simpleton.js"

var readline = require("readline")
var { fetch: braid_fetch } = require("braid-http")

// Load simpleton_client from braid-text
var fs = require("fs")
var path = require("path")
var vm = require("vm")

var simpleton_path = path.join(__dirname, "..", "node_modules", "braid-text", "client", "simpleton-sync.js")
var code = fs.readFileSync(simpleton_path, "utf8")
var sandbox = {
    braid_fetch,
    console: { ...console, log: (...args) => process.stderr.write(args.join(" ") + "\n") },
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, TextDecoder, TextEncoder,
    crypto: globalThis.crypto || require("crypto"),
    Math, Error, TypeError, RangeError, ReferenceError,
    Promise, Array, Object, String, Number, Boolean,
    JSON, parseInt, parseFloat, isNaN, isFinite,
    Uint8Array, Map, Set, RegExp, Date,
    btoa: globalThis.btoa, atob: globalThis.atob, Buffer,
}
vm.createContext(sandbox)
vm.runInContext(code, sandbox)
var simpleton_client = sandbox.simpleton_client

// ── State ───────────────────────────────────────────────────────

var buffer = ""
var simpleton = null
var pending_puts = 0
var ack_waiters = []

// ── Command handler ─────────────────────────────────────────────

function reply(id, data) {
    process.stdout.write(JSON.stringify({ id, ok: true, ...data }) + "\n")
}

function reply_error(id, msg) {
    process.stdout.write(JSON.stringify({ id, error: msg }) + "\n")
}

async function handle(msg) {
    try {
        switch (msg.cmd) {
            case "connect": {
                buffer = ""
                simpleton = simpleton_client(msg.url, {
                    on_state: (state) => { buffer = state },
                    get_state: () => buffer,
                    on_error: (e) => {
                        process.stderr.write(`simpleton error: ${e.message || e}\n`)
                    },
                    on_online: (online) => {
                        process.stderr.write(`online: ${online}\n`)
                    },
                    on_ack: () => {
                        pending_puts--
                        if (pending_puts <= 0) {
                            pending_puts = 0
                            for (var w of ack_waiters.splice(0)) w()
                        }
                    }
                })
                reply(msg.id)
                break
            }

            case "insert": {
                var chars = [...buffer]
                var pos = Math.min(msg.pos, chars.length)
                chars.splice(pos, 0, ...msg.text)
                buffer = chars.join("")
                if (simpleton) { pending_puts++; simpleton.changed() }
                reply(msg.id)
                break
            }

            case "delete": {
                var chars = [...buffer]
                var pos = Math.min(msg.pos, chars.length)
                var len = Math.min(msg.len, chars.length - pos)
                chars.splice(pos, len)
                buffer = chars.join("")
                if (simpleton) { pending_puts++; simpleton.changed() }
                reply(msg.id)
                break
            }

            case "replace": {
                var chars = [...buffer]
                var pos = Math.min(msg.pos, chars.length)
                var len = Math.min(msg.len, chars.length - pos)
                chars.splice(pos, len, ...msg.text)
                buffer = chars.join("")
                if (simpleton) { pending_puts++; simpleton.changed() }
                reply(msg.id)
                break
            }

            case "state": {
                reply(msg.id, { state: buffer })
                break
            }

            case "wait-ack": {
                if (pending_puts <= 0) {
                    reply(msg.id)
                } else {
                    await new Promise((resolve) => {
                        ack_waiters.push(() => { reply(msg.id); resolve() })
                    })
                }
                break
            }

            case "kill-sub": {
                if (simpleton) simpleton.abort()
                reply(msg.id)
                break
            }

            case "kill-put": {
                reply(msg.id)
                break
            }

            case "quit": {
                reply(msg.id)
                if (simpleton) { try { simpleton.abort() } catch (e) {} }
                setTimeout(() => process.exit(0), 100)
                break
            }

            default:
                reply_error(msg.id, `unknown command: ${msg.cmd}`)
        }
    } catch (e) {
        reply_error(msg.id, e.message)
    }
}

// ── Read commands from stdin ────────────────────────────────────

var rl = readline.createInterface({ input: process.stdin })
rl.on("line", line => {
    line = line.trim()
    if (!line) return
    try {
        handle(JSON.parse(line))
    } catch (e) {
        process.stderr.write(`parse error: ${e.message}\n`)
    }
})
