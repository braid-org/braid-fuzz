// Editor Agent Bridge
//
// Spawns a headless editor process and communicates via JSON-lines
// over stdin/stdout. The editor plugin must include a compatible
// "agent shim" that reads JSON commands from stdin and writes
// JSON responses to stdout.
//
// Protocol:
//   -> {"id": 1, "cmd": "connect", "url": "https://..."}
//   <- {"id": 1, "ok": true}
//   -> {"id": 2, "cmd": "insert", "pos": 5, "text": "hello"}
//   <- {"id": 2, "ok": true}
//   -> {"id": 3, "cmd": "state"}
//   <- {"id": 3, "ok": true, "state": "buffer contents here"}

var { spawn } = require("child_process")
var { EventEmitter } = require("events")
var readline = require("readline")

class EditorBridge extends EventEmitter {
    constructor({ command, args = [], cwd, env, server_base_url }) {
        super()
        this.command = command
        this.args = args
        this.cwd = cwd
        this.env = env || process.env
        this.server_base_url = server_base_url || ""
        this.proc = null
        this.rl = null
        this._next_id = 1
        this._pending = new Map() // id -> { resolve, reject, timer }
        this._timeout_ms = 30000
        this.alive = false
        this.stderr_lines = []
    }

    start() {
        return new Promise((resolve, reject) => {
            this.proc = spawn(this.command, this.args, {
                cwd: this.cwd,
                env: this.env,
                stdio: ["pipe", "pipe", "pipe"]
            })

            this.alive = true

            this.proc.on("error", err => {
                this.alive = false
                this.emit("error", err)
                reject(err)
            })

            this.proc.on("exit", (code, signal) => {
                this.alive = false
                this._reject_all(`Editor exited (code=${code}, signal=${signal})`)
                this.emit("exit", code, signal)
            })

            // Capture stderr for debugging
            var stderr_rl = readline.createInterface({ input: this.proc.stderr })
            stderr_rl.on("line", line => {
                this.stderr_lines.push(line)
                this.emit("stderr", line)
            })

            // Parse JSON lines from stdout
            this.rl = readline.createInterface({ input: this.proc.stdout })
            this.rl.on("line", line => {
                line = line.trim()
                if (!line) return
                try {
                    var msg = JSON.parse(line)
                    this._handle_response(msg)
                } catch (e) {
                    this.emit("parse-error", line, e)
                }
            })

            // Give the editor a moment to start, then resolve
            setTimeout(() => {
                if (this.alive) resolve()
                else reject(new Error("Editor failed to start"))
            }, 200)
        })
    }

    _handle_response(msg) {
        if (msg.id && this._pending.has(msg.id)) {
            var { resolve, reject, timer } = this._pending.get(msg.id)
            clearTimeout(timer)
            this._pending.delete(msg.id)
            if (msg.error) reject(new Error(msg.error))
            else resolve(msg)
        } else {
            // Unsolicited message (event from editor)
            this.emit("event", msg)
        }
    }

    send(cmd, params = {}) {
        if (!this.alive) return Promise.reject(new Error("Editor not running"))

        var id = this._next_id++
        var msg = { id, cmd, ...params }

        return new Promise((resolve, reject) => {
            var timer = setTimeout(() => {
                this._pending.delete(id)
                reject(new Error(`Timeout waiting for response to "${cmd}" (id=${id})`))
            }, this._timeout_ms)

            this._pending.set(id, { resolve, reject, timer })
            this.proc.stdin.write(JSON.stringify(msg) + "\n")
        })
    }

    async connect(url, opts = {}) {
        var full_url = url.startsWith("http") ? url : this.server_base_url + url
        return this.send("connect", { url: full_url, ...opts })
    }
    async insert(pos, text) { return this.send("insert", { pos, text }) }
    async delete(pos, len) { return this.send("delete", { pos, len }) }
    async replace(pos, len, text) { return this.send("replace", { pos, len, text }) }
    async state() { return (await this.send("state")).state }
    async wait_ack() { return this.send("wait-ack") }
    async kill_sub() { return this.send("kill-sub") }
    async kill_put() { return this.send("kill-put") }

    _reject_all(reason) {
        for (var [, { reject, timer }] of this._pending) {
            clearTimeout(timer)
            reject(new Error(reason))
        }
        this._pending.clear()
    }

    async stop() {
        if (!this.alive) return
        try { await this.send("quit").catch(() => {}) } catch (e) {}
        await new Promise(resolve => setTimeout(resolve, 500))
        if (this.alive) {
            this.proc.kill("SIGTERM")
            await new Promise(resolve => setTimeout(resolve, 500))
            if (this.alive) this.proc.kill("SIGKILL")
        }
    }
}

module.exports = { EditorBridge }
