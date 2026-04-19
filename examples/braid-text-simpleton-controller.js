#!/usr/bin/env node

// Reference client agent for the braid-fuzz test runner.
//
// This is a standalone Node.js process that:
//   1. Reads JSON commands from stdin (one per line)
//   2. Uses the reference simpleton-sync client to talk to a braid-text server
//   3. Writes JSON responses to stdout (one per line)
//
// Usage:
//   braid-fuzz "node ./examples/braid-text-simpleton-controller.js"

var readline = require("readline")
var { fetch: braid_fetch } = require("braid-http")

// Load simpleton_client from braid-text
var fs = require("fs")
var path = require("path")
var vm = require("vm")

var simpleton_path = path.join(__dirname, "..", "node_modules", "braid-text", "client", "simpleton-sync.js")
var cursor_path = path.join(__dirname, "..", "node_modules", "braid-text", "client", "cursor-sync.js")
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
vm.runInContext(fs.readFileSync(simpleton_path, "utf8"), sandbox)
vm.runInContext(fs.readFileSync(cursor_path, "utf8"), sandbox)
var simpleton_client = sandbox.simpleton_client
var cursor_client = sandbox.cursor_client

// ── State ───────────────────────────────────────────────────────

var buffer = ""
var simpleton = null
var pending_puts = 0
var ack_waiters = []

// Cursor sync state. `cursors` is the cursor_client handle; `sync_url`
// is the url of the current simpleton subscription (we build the cursor
// subscription on the same url). `remote_cursors` tracks peer->ranges
// as reported by cursor_client's on_change callback.
var cursors = null
var sync_url = null
var cursor_peer = "client-" + Math.random().toString(36).slice(2, 8)
var remote_cursors = {}

// Raw fetch state — for subscription/http tests that bypass simpleton
var current_fetch = null  // { ac } — the active braid_fetch

// Webindex watches: { url -> { ac, names } }. We keep an open
// subscription per watched url so we can diff successive snapshots
// and emit child-added / child-removed events.
var webindex_watches = new Map()

// Strip the trailing-bare-link duplicate that appears when a path is
// both a resource and a collection. We treat each name as a single
// child regardless of how many representations the protocol gives it.
function snapshot_to_names(body_text) {
    try {
        var arr = JSON.parse(body_text)
        if (!Array.isArray(arr)) return []
        var seen = new Set()
        for (var entry of arr) {
            if (entry && typeof entry.link === "string") seen.add(entry.link)
        }
        return [...seen]
    } catch (e) { return [] }
}

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

            case "sync-text": {
                buffer = ""
                sync_url = msg.url
                simpleton = simpleton_client(msg.url, {
                    on_state: (state) => { buffer = state },
                    on_patches: (patches) => {
                        // Apply patches to the local buffer and feed
                        // them through the cursor client so remote
                        // cursors shift when remote edits arrive.
                        var shaped = []
                        for (var p of patches) {
                            var range = typeof p.range === "string"
                                ? p.range.match(/\d+/g).map(Number)
                                : p.range
                            var content = p.content_text != null ? p.content_text : (p.content || "")
                            shaped.push({ range, content })
                            var chars = [...buffer]
                            chars.splice(range[0], range[1] - range[0], ...content)
                            buffer = chars.join("")
                        }
                        if (cursors) cursors.changed(shaped)
                    },
                    get_state: () => buffer,
                    on_error: (e) => {
                        process.stderr.write(`simpleton error: ${e.message || e}\n`)
                    },
                    on_online: (online) => {
                        process.stderr.write(`online: ${online}\n`)
                        if (cursors) {
                            if (online) cursors.online()
                            else cursors.offline()
                        }
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

            case "edit": {
                var chars = [...buffer]
                var pos = Math.min(msg.pos || 0, chars.length)
                var len = Math.min(msg.len || 0, chars.length - pos)
                var text = msg.text || ""
                chars.splice(pos, len, ...text)
                buffer = chars.join("")
                if (cursors) cursors.changed([{ range: [pos, pos + len], content: text }])
                if (simpleton) { pending_puts++; simpleton.changed() }
                reply(msg.id)
                break
            }

            case "send-text": {
                reply(msg.id, { state: buffer })
                break
            }

            case "ack": {
                if (pending_puts <= 0) {
                    reply(msg.id)
                } else {
                    await new Promise((resolve) => {
                        ack_waiters.push(() => { reply(msg.id); resolve() })
                    })
                }
                break
            }

            case "end-sync": {
                if (simpleton) simpleton.abort()
                if (cursors) { try { cursors.destroy() } catch (e) {} cursors = null }
                sync_url = null
                reply(msg.id)
                break
            }

            case "kill-put": {
                reply(msg.id)
                break
            }

            // ── Cursor commands ────────────────────────────────────

            case "connect-cursors": {
                if (!sync_url) { reply_error(msg.id, "no active sync-text"); break }
                if (cursors) { try { cursors.destroy() } catch (e) {} cursors = null }
                remote_cursors = {}
                cursors = await cursor_client(sync_url, {
                    peer: cursor_peer,
                    get_text: () => buffer,
                    on_change: (changed) => {
                        for (var id of Object.keys(changed)) {
                            var sels = changed[id]
                            if (!sels || sels.length === 0) delete remote_cursors[id]
                            else remote_cursors[id] = sels
                        }
                    },
                })
                if (!cursors) { reply_error(msg.id, "server does not support cursors"); break }
                // The simpleton subscription is the source of online/offline
                // signals. If it's already running, consider it online.
                cursors.online()
                reply(msg.id)
                break
            }

            case "set-cursor": {
                if (!cursors) { reply_error(msg.id, "cursors not connected"); break }
                var from = msg.pos || 0
                var to = (msg.end != null) ? msg.end : from
                cursors.set(from, to)
                reply(msg.id)
                break
            }

            case "get-cursors": {
                if (!cursors) { reply(msg.id, { cursors: {} }); break }
                var snap = cursors.get_selections ? cursors.get_selections() : remote_cursors
                reply(msg.id, { cursors: snap })
                break
            }

            // ── Raw braid_fetch commands (for subscription tests) ──

            case "open-http": {
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
                //   Updates are pushed as {"event": "update", ...}
                //   Errors are pushed as {"event": "error", ...}
                //
                // For PUTs (method: "PUT"):
                //   Success is pushed as {"event": "ack", ...}
                //   Errors are pushed as {"event": "error", ...}

                var method = (msg.method || "GET").toUpperCase()
                var ac = new AbortController()
                var last_version = null

                current_fetch = { ac }

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
                                event: "ack", data: { status: r.status }
                            }) + "\n")
                        } catch (e) {
                            if (e.name === "AbortError") return
                            process.stdout.write(JSON.stringify({
                                event: "error", data: { message: e.message || String(e) }
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
                                event: "update", data: item
                            }) + "\n")
                        }, (e) => {
                            if (e.name === "AbortError") return
                            process.stdout.write(JSON.stringify({
                                event: "error", data: { message: e.message || String(e) }
                            }) + "\n")
                        })
                    }).catch(e => {
                        if (e.name === "AbortError") return
                        process.stdout.write(JSON.stringify({
                            event: "error", name, data: { message: e.message || String(e) }
                        }) + "\n")
                    })
                }

                reply(msg.id)
                break
            }

            case "close-http": {
                // Abort the current braid_fetch subscription.
                if (current_fetch) {
                    current_fetch.ac.abort()
                    current_fetch = null
                }
                reply(msg.id)
                break
            }

            // ── Webindex commands ──────────────────────────────────

            case "list-children": {
                // One-shot: return the names of immediate children at
                // msg.url. We open a short-lived subscription, take the
                // first snapshot, and close.
                var ac = new AbortController()
                var done = false
                var finish = (names) => {
                    if (done) return
                    done = true
                    ac.abort()
                    reply(msg.id, { children: names })
                }
                braid_fetch(msg.url, {
                    subscribe: true,
                    headers: { "Accept": "application/webindex+linked+json" },
                    signal: ac.signal,
                    retry: false,
                }).then(res => {
                    res.subscribe(update => {
                        if (update.body != null) finish(snapshot_to_names(update.body_text))
                    }, e => {
                        if (e.name !== "AbortError" && !done) {
                            done = true
                            reply_error(msg.id, e.message || String(e))
                        }
                    })
                }).catch(e => {
                    if (e.name !== "AbortError" && !done) {
                        done = true
                        reply_error(msg.id, e.message || String(e))
                    }
                })
                break
            }

            case "watch-children": {
                // Subscribe to msg.url; emit child-added / child-removed
                // events as the set of immediate-child names changes.
                if (webindex_watches.has(msg.url)) {
                    webindex_watches.get(msg.url).ac.abort()
                    webindex_watches.delete(msg.url)
                }
                var ac = new AbortController()
                var state = { ac, names: null }
                webindex_watches.set(msg.url, state)

                braid_fetch(msg.url, {
                    subscribe: true,
                    headers: { "Accept": "application/webindex+linked+json" },
                    signal: ac.signal,
                    retry: () => true,
                }).then(res => {
                    res.subscribe(update => {
                        if (update.body == null) return
                        var next = new Set(snapshot_to_names(update.body_text))
                        if (state.names === null) {
                            state.names = next
                            return
                        }
                        for (var n of next) {
                            if (!state.names.has(n)) {
                                process.stdout.write(JSON.stringify({
                                    event: "child-added", data: { url: msg.url, name: n }
                                }) + "\n")
                            }
                        }
                        for (var n of state.names) {
                            if (!next.has(n)) {
                                process.stdout.write(JSON.stringify({
                                    event: "child-removed", data: { url: msg.url, name: n }
                                }) + "\n")
                            }
                        }
                        state.names = next
                    }, e => {
                        if (e.name === "AbortError") return
                        process.stdout.write(JSON.stringify({
                            event: "error", data: { message: e.message || String(e) }
                        }) + "\n")
                    })
                }).catch(e => {
                    if (e.name === "AbortError") return
                    process.stdout.write(JSON.stringify({
                        event: "error", data: { message: e.message || String(e) }
                    }) + "\n")
                })
                reply(msg.id)
                break
            }

            case "unwatch-children": {
                var w = webindex_watches.get(msg.url)
                if (w) { w.ac.abort(); webindex_watches.delete(msg.url) }
                reply(msg.id)
                break
            }

            case "results": {
                reply(msg.id)
                if (simpleton) { try { simpleton.abort() } catch (e) {} }
                if (cursors) { try { cursors.destroy() } catch (e) {} }
                for (var w of webindex_watches.values()) { try { w.ac.abort() } catch (e) {} }
                webindex_watches.clear()
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
