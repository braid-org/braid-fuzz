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

// Raw fetch state — for subscription tests that bypass simpleton
var fetch_subscriptions = new Map()  // name -> { ac, updates }
var fetch_counter = 0

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
            case "hello": {
                reply(msg.id)
                break
            }

            case "simpleton": {
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

            case "replace": {
                var chars = [...buffer]
                var pos = Math.min(msg.pos || 0, chars.length)
                var len = Math.min(msg.len || 0, chars.length - pos)
                var text = msg.text || ""
                chars.splice(pos, len, ...text)
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

            // ── Raw braid_fetch commands (for subscription tests) ──

            case "braid_fetch": {
                // Call braid_fetch with the given options.
                // Mirrors the braid_fetch API directly:
                //   msg.url: URL
                //   msg.method: "GET" (default) or "PUT"
                //   msg.subscribe: true to open a subscription
                //   msg.version: version array (for PUTs)
                //   msg.parents: parent version array (for PUTs)
                //   msg.patches: array of { unit, range, content } (for PUTs)
                //   msg.headers: extra headers (optional)
                //   msg.peer: peer ID (optional)
                //
                // For subscriptions (subscribe: true):
                //   Updates are pushed as {"event": "fetch-update", ...}
                //   Errors are pushed as {"event": "fetch-error", ...}
                //
                // For PUTs (method: "PUT"):
                //   Success is pushed as {"event": "fetch-ack", ...}
                //   Errors are pushed as {"event": "fetch-error", ...}

                var name = msg.name || ("fetch-" + (++fetch_counter))
                var method = (msg.method || "GET").toUpperCase()
                var ac = new AbortController()
                var last_version = null

                fetch_subscriptions.set(name, { ac })

                var fetch_opts = {
                    method,
                    headers: msg.headers || {},
                    signal: ac.signal,
                }

                if (msg.subscribe) {
                    fetch_opts.subscribe = true
                    fetch_opts.retry = () => true
                    fetch_opts.parents = () => last_version
                }
                if (msg.heartbeats != null) fetch_opts.heartbeats = msg.heartbeats

                if (msg.version) {
                    var v = msg.version
                    fetch_opts.version = typeof v === "string" ? [v] : v
                }
                if (msg.parents) {
                    var p = msg.parents
                    fetch_opts.parents = typeof p === "string" ? [p] : p
                }
                if (msg.patches) {
                    fetch_opts.patches = msg.patches.map(p => ({
                        unit: p.unit || "text",
                        range: p.range,
                        content: p.content,
                    }))
                }
                if (msg.peer) fetch_opts.peer = msg.peer

                if (method === "PUT") {
                    // PUT: retry by default (except 550)
                    if (!fetch_opts.retry) fetch_opts.retry = (res) => res.status !== 550

                    ;(async () => {
                        try {
                            var r = await braid_fetch(msg.url, fetch_opts)
                            process.stdout.write(JSON.stringify({
                                event: "fetch-ack", name, data: { status: r.status }
                            }) + "\n")
                        } catch (e) {
                            if (e.name === "AbortError") return
                            process.stdout.write(JSON.stringify({
                                event: "fetch-error", name, data: { message: e.message || String(e) }
                            }) + "\n")
                        }
                    })()
                } else {
                    // GET (subscription): stream updates
                    braid_fetch(msg.url, fetch_opts).then(res => {
                        res.subscribe(update => {
                            if (update.version) last_version = update.version

                            var item = {
                                version: update.version || null,
                                parents: update.parents || null,
                            }
                            if (update.patches) {
                                item.patches = update.patches.map(p => ({
                                    range: p.range ? p.range.match(/\d+/g).map(Number) : null,
                                    content: p.content_text,
                                    unit: p.unit || null,
                                }))
                            }
                            if (update.body != null) {
                                item.body = update.body_text
                            }
                            if (update.extra_headers) {
                                item.extra_headers = update.extra_headers
                            }
                            process.stdout.write(JSON.stringify({
                                event: "fetch-update", name, data: item
                            }) + "\n")
                        }, (e) => {
                            if (e.name === "AbortError") return
                            process.stdout.write(JSON.stringify({
                                event: "fetch-error", name, data: { message: e.message || String(e) }
                            }) + "\n")
                        })
                    }).catch(e => {
                        if (e.name === "AbortError") return
                        process.stdout.write(JSON.stringify({
                            event: "fetch-error", name, data: { message: e.message || String(e) }
                        }) + "\n")
                    })
                }

                reply(msg.id, { name })
                break
            }

            case "unsubscribe": {
                // Abort a subscription.
                var name = msg.name
                if (!name) {
                    var keys = [...fetch_subscriptions.keys()]
                    name = keys[keys.length - 1]
                }
                var sub = name ? fetch_subscriptions.get(name) : null
                if (sub) {
                    sub.ac.abort()
                    fetch_subscriptions.delete(name)
                }
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
