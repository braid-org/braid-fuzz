// Stream Bridge
//
// Same interface as ClientBridge (send, connect, insert, delete, state, etc.)
// but communicates over any bidirectional stream using JSON-lines.
//
// Works with WebSockets, raw TCP sockets, or any object that has:
//   - write(data) or send(data)  — to send a JSON line to the client
//   - an "on message" mechanism  — to receive JSON lines from the client
//
// The constructor takes a `send_fn` (how to write) and the caller
// feeds incoming messages via `_handle_response(msg)`.

var { EventEmitter } = require("events")

class StreamBridge extends EventEmitter {
    constructor({ send_fn, session }) {
        super()
        this.send_fn = send_fn   // function(string) — send a line to the client
        this.session = session   // session object (holds pending map, etc.)
        this._next_id = 1
        this._timeout_ms = 30000
        this.alive = false
        this.stderr_lines = []
        this.updates = []      // fetch-update events pushed by the client
        this.errors = []       // fetch-error events pushed by the client
        this.fetch_acks = []   // fetch-ack events (PUT responses)
    }

    start() {
        this.alive = true
        return Promise.resolve()
    }

    _handle_response(msg) {
        if (msg.id && this.session.pending.has(msg.id)) {
            var { resolve, reject, timer } = this.session.pending.get(msg.id)
            clearTimeout(timer)
            this.session.pending.delete(msg.id)
            if (msg.error) reject(new Error(msg.error))
            else resolve(msg)
        } else {
            if (msg.event === "fetch-update") this.updates.push(msg.data)
            if (msg.event === "fetch-error") this.errors.push(msg.data)
            if (msg.event === "fetch-ack") this.fetch_acks.push(msg.data)
            this.emit("event", msg)
        }
    }

    send(cmd, params = {}) {
        if (!this.alive) return Promise.reject(new Error("Client not connected"))

        var id = this._next_id++
        var msg = { id, cmd, ...params }

        return new Promise((resolve, reject) => {
            var timer = setTimeout(() => {
                this.session.pending.delete(id)
                reject(new Error(`Timeout waiting for response to "${cmd}" (id=${id})`))
            }, this._timeout_ms)

            this.session.pending.set(id, { resolve, reject, timer })

            try {
                this.send_fn(JSON.stringify(msg) + "\n")
            } catch (e) {
                this.session.pending.delete(id)
                clearTimeout(timer)
                reject(new Error("Failed to write to client: " + e.message))
            }
        })
    }

    async connect(url, opts = {}) {
        var full_url = url.startsWith("http") ? url : this.session.server_base_url + url
        return this.send("simpleton", { url: full_url, ...opts })
    }
    async insert(pos, text) { return this.send("replace", { pos, len: 0, text }) }
    async delete(pos, len) { return this.send("replace", { pos, len, text: "" }) }
    async replace(pos, len, text) { return this.send("replace", { pos, len, text }) }
    async state() { return (await this.send("state")).state }
    async wait_ack() { return this.send("wait-ack") }
    async kill_sub() { return this.send("kill-sub") }
    async kill_put() { return this.send("kill-put") }

    async stop() {
        if (!this.alive) return
        try { await this.send("kill-sub").catch(() => {}) } catch (e) {}
        this.alive = false
    }

    _reject_all(reason) {
        for (var [, { reject, timer }] of this.session.pending) {
            clearTimeout(timer)
            reject(new Error(reason))
        }
        this.session.pending.clear()
    }
}

module.exports = { StreamBridge }
