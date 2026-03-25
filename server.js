// Test server for braid-fuzz.
// Wraps braid-text with a control API so tests can:
//   - create/destroy documents
//   - make server-side edits
//   - read server-side state
//   - configure behavior (delays, drops, heartbeats)
//
// Plain HTTP/1.1 (no TLS) — the socket proxy sits between this
// and the client for fault injection.

var http = require("http")
var braid_text = require("braid-text")
var { http_server: braidify } = require("braid-http")

class TestServer {
    constructor(opts = {}) {
        this.port = opts.port || 0 // 0 = auto-assign
        this.host = opts.host || "127.0.0.1"
        this.server = null
        this.docs = new Set()

        // Configurable behavior
        this.ack_delay_ms = 0
        this.drop_puts = false
        this.drop_acks = false
        this.heartbeat_seconds = 0

        // Per-request hooks for tests to observe traffic
        this._on_put = null
        this._on_get = null
        this._on_subscribe = null

        // Track active subscriptions so we can force-close them
        this._subscriptions = []

        braid_text.db_folder = null
    }

    start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer(async (req, res) => {
                try {
                    await this._handle(req, res)
                } catch (e) {
                    console.error(`server error: ${req.method} ${req.url}: ${e.message}`)
                    if (!res.headersSent) { res.writeHead(500); res.end() }
                }
            })
            this.server.on("error", reject)
            this.server.listen(this.port, this.host, () => {
                this.port = this.server.address().port
                resolve(this.port)
            })
        })
    }

    async _handle(req, res) {
        // CORS
        res.setHeader("Access-Control-Allow-Origin", "*")
        res.setHeader("Access-Control-Allow-Methods", "*")
        res.setHeader("Access-Control-Allow-Headers", "*")
        res.setHeader("Access-Control-Expose-Headers", "*")
        if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return }

        var url = req.url

        // ── Control API (/control/*) ─────────────────────────────
        if (url.startsWith("/control/")) {
            await this._handle_control(req, res, url)
            return
        }

        // ── Document endpoints (everything else goes to braid-text) ──

        // Track the doc
        this.docs.add(url)

        // Notify test hooks
        if (req.method === "PUT" && this._on_put) this._on_put(req, res, url)
        if (req.method === "GET" && this._on_get) this._on_get(req, res, url)

        // Drop PUTs entirely if configured
        if (req.method === "PUT" && this.drop_puts) {
            req.on("data", () => {})
            req.on("end", () => res.destroy())
            return
        }

        // For PUTs, optionally delay the ACK or drop it
        if (req.method === "PUT") {
            if (this.drop_acks) {
                // Process the PUT but destroy the response instead of acknowledging
                res.writeHead = function () {} // swallow
                res.end = function () { res.destroy() }
            } else if (this.ack_delay_ms > 0) {
                var delay = this.ack_delay_ms
                var orig_writeHead = res.writeHead.bind(res)
                var orig_end = res.end.bind(res)
                var buffered_args = null
                res.writeHead = function (...args) { buffered_args = args }
                res.end = function (...args) {
                    setTimeout(() => {
                        if (buffered_args) orig_writeHead(...buffered_args)
                        orig_end(...args)
                    }, delay)
                }
            }
        }

        // For subscriptions, track them and optionally add heartbeat header
        braidify(req, res)
        if (req.method === "GET" && req.subscribe) {
            if (this._on_subscribe) this._on_subscribe(req, res, url)
            var sub = { res, url }
            this._subscriptions.push(sub)
            var orig_start = res.startSubscription.bind(res)
            res.startSubscription = (opts) => {
                var orig_onClose = opts && opts.onClose
                orig_start({
                    ...opts,
                    onClose: () => {
                        this._subscriptions = this._subscriptions.filter(s => s !== sub)
                        if (orig_onClose) orig_onClose()
                    }
                })
            }

            // Add heartbeat support
            if (this.heartbeat_seconds > 0) {
                res.setHeader("Heartbeats", String(this.heartbeat_seconds))
                var hb_interval = setInterval(() => {
                    try { res.write("\n") } catch (e) { clearInterval(hb_interval) }
                }, this.heartbeat_seconds * 1000)
                res.on("close", () => clearInterval(hb_interval))
            }
        }

        await braid_text.serve(req, res)
    }

    async _handle_control(req, res, url) {
        var body = await read_body(req)

        // GET /control/state?doc=/path — get server's copy of a doc
        if (url.startsWith("/control/state")) {
            var doc = new URL(url, "http://localhost").searchParams.get("doc")
            if (!doc) { res.writeHead(400); res.end("missing ?doc= param"); return }
            var state = await braid_text.get(doc)
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ doc, state: state || "" }))
            return
        }

        // POST /control/edit — make a server-side edit
        if (url === "/control/edit" && req.method === "POST") {
            var { doc, patches } = JSON.parse(body)
            await braid_text.put(doc, { patches })
            var state = await braid_text.get(doc)
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ ok: true, state }))
            return
        }

        // POST /control/configure — change server behavior
        if (url === "/control/configure" && req.method === "POST") {
            var cfg = JSON.parse(body)
            if (cfg.ack_delay_ms != null) this.ack_delay_ms = cfg.ack_delay_ms
            if (cfg.drop_puts != null) this.drop_puts = cfg.drop_puts
            if (cfg.drop_acks != null) this.drop_acks = cfg.drop_acks
            if (cfg.heartbeat_seconds != null) this.heartbeat_seconds = cfg.heartbeat_seconds
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ ok: true }))
            return
        }

        // POST /control/kill-subscriptions — force-close all active subscriptions for a doc
        if (url === "/control/kill-subscriptions" && req.method === "POST") {
            var { doc } = JSON.parse(body)
            var killed = 0
            for (var sub of this._subscriptions.slice()) {
                if (!doc || sub.url === doc) {
                    try { sub.res.destroy() } catch (e) {}
                    killed++
                }
            }
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ ok: true, killed }))
            return
        }

        // POST /control/reset — reset all server state
        if (url === "/control/reset" && req.method === "POST") {
            for (var sub of this._subscriptions.slice()) {
                try { sub.res.destroy() } catch (e) {}
            }
            this._subscriptions = []
            this.ack_delay_ms = 0
            this.drop_puts = false
            this.drop_acks = false
            this.docs.clear()
            this._on_put = null
            this._on_get = null
            this._on_subscribe = null
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ ok: true }))
            return
        }

        // GET /control/digest?doc=/path — get SHA-256 digest of doc state
        if (url.startsWith("/control/digest")) {
            var doc = new URL(url, "http://localhost").searchParams.get("doc")
            if (!doc) { res.writeHead(400); res.end("missing ?doc= param"); return }
            var state = await braid_text.get(doc)
            var digest = get_digest(state || "")
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ doc, digest }))
            return
        }

        res.writeHead(404)
        res.end("unknown control endpoint")
    }

    // Get server state for a doc directly (for tests running in-process)
    async get_doc_state(doc) {
        return (await braid_text.get(doc)) || ""
    }

    // Get SHA-256 digest of doc state (for tests running in-process)
    async get_doc_digest(doc) {
        var state = await this.get_doc_state(doc)
        return get_digest(state)
    }

    // Make a server-side edit directly (for tests running in-process)
    async edit_doc(doc, patches) {
        await braid_text.put(doc, { patches })
        return await this.get_doc_state(doc)
    }

    // Insert text at position
    async insert_at(doc, pos, text) {
        return this.edit_doc(doc, [{ unit: "text", range: `[${pos}:${pos}]`, content: text }])
    }

    // Delete text at range
    async delete_range(doc, start, end) {
        return this.edit_doc(doc, [{ unit: "text", range: `[${start}:${end}]`, content: "" }])
    }

    // Replace text at range
    async replace_range(doc, start, end, text) {
        return this.edit_doc(doc, [{ unit: "text", range: `[${start}:${end}]`, content: text }])
    }

    // Write a raw update directly to active subscriptions for a doc.
    // Useful for sending updates that braid-text doesn't support natively
    // (e.g. Patches: 0).
    send_raw_update(doc, update_str) {
        for (var sub of this._subscriptions) {
            if (sub.url === doc) {
                try { sub.res.write(update_str) } catch (e) {}
            }
        }
    }

    // Get cursor snapshot for a doc via regular HTTP GET
    async get_cursors(doc) {
        return new Promise((resolve, reject) => {
            var req = http.request({
                hostname: this.host,
                port: this.port,
                path: doc,
                method: "GET",
                headers: { "Accept": "application/text-cursors+json" }
            }, res => {
                var body = ""
                res.on("data", d => body += d)
                res.on("end", () => {
                    try { resolve(JSON.parse(body)) }
                    catch (e) { resolve({}) }
                })
            })
            req.on("error", reject)
            req.end()
        })
    }

    // Subscribe a simulated peer to cursors (required before set_cursor)
    async subscribe_cursors(doc, peer) {
        return new Promise((resolve, reject) => {
            var req = http.request({
                hostname: this.host,
                port: this.port,
                path: doc,
                method: "GET",
                headers: {
                    "Accept": "application/text-cursors+json",
                    "Subscribe": "true",
                    "Peer": peer
                }
            }, res => {
                // Keep the subscription open (don't consume/close)
                resolve(res)
            })
            req.on("error", reject)
            req.end()
        })
    }

    // Set cursor for a peer via regular HTTP PUT
    async set_cursor(doc, peer, selections) {
        return new Promise((resolve, reject) => {
            var body = JSON.stringify(selections)
            var req = http.request({
                hostname: this.host,
                port: this.port,
                path: doc,
                method: "PUT",
                headers: {
                    "Content-Type": "application/text-cursors+json",
                    "Content-Range": `json ["${peer}"]`,
                    "Peer": peer,
                    "Content-Length": Buffer.byteLength(body)
                }
            }, res => {
                res.resume()
                resolve(res.statusCode)
            })
            req.on("error", reject)
            req.end(body)
        })
    }

    subscription_count(doc) {
        if (doc) return this._subscriptions.filter(s => s.url === doc).length
        return this._subscriptions.length
    }

    async stop() {
        for (var sub of this._subscriptions.slice()) {
            try { sub.res.destroy() } catch (e) {}
        }
        if (this.server) {
            await new Promise(resolve => this.server.close(resolve))
            this.server = null
        }
    }
}

function get_digest(text) {
    var buffer = Buffer.from(text, "utf8")
    return `sha-256=:${require("crypto").createHash("sha256").update(buffer).digest("base64")}:`
}

function read_body(req) {
    return new Promise((resolve) => {
        var body = ""
        req.on("data", d => body += d)
        req.on("end", () => resolve(body))
    })
}

module.exports = { TestServer }
