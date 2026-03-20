// TCP socket proxy with programmable fault injection.
// Sits between client and braid-text server, allowing tests
// to inject disconnects, delays, blackholes, RSTs, and corruption.

var net = require("net")
var { EventEmitter } = require("events")

class SocketProxy extends EventEmitter {
    constructor({ listen_port, target_host, target_port }) {
        super()
        this.listen_port = listen_port
        this.target_host = target_host || "127.0.0.1"
        this.target_port = target_port
        this.mode = "passthrough" // passthrough | blackhole | delay | rst | close | corrupt
        this.delay_ms = 0
        this.connections = []
        this.server = null
    }

    start() {
        return new Promise((resolve, reject) => {
            this.server = net.createServer(client_sock => {
                var target_sock = net.createConnection(this.target_port, this.target_host)
                var conn = { client: client_sock, target: target_sock, alive: true }
                this.connections.push(conn)

                var cleanup = () => {
                    conn.alive = false
                    this.connections = this.connections.filter(c => c !== conn)
                    client_sock.destroy()
                    target_sock.destroy()
                }

                client_sock.on("error", cleanup)
                target_sock.on("error", cleanup)
                client_sock.on("close", cleanup)
                target_sock.on("close", cleanup)

                // client -> server
                client_sock.on("data", data => {
                    if (!conn.alive) return
                    this._forward(data, target_sock, conn, "c2s")
                })

                // server -> client
                target_sock.on("data", data => {
                    if (!conn.alive) return
                    this._forward(data, client_sock, conn, "s2c")
                })

                this.emit("connection", conn)
            })

            this.server.on("error", reject)
            this.server.listen(this.listen_port, "127.0.0.1", () => {
                this.listen_port = this.server.address().port
                resolve(this.listen_port)
            })
        })
    }

    _forward(data, dest, conn, direction) {
        switch (this.mode) {
            case "passthrough":
                dest.write(data)
                break

            case "blackhole":
                // silently drop all data
                break

            case "delay":
                setTimeout(() => {
                    if (conn.alive) dest.write(data)
                }, this.delay_ms)
                break

            case "rst":
                // send a TCP RST by destroying with an error
                conn.client.destroy()
                conn.target.destroy()
                break

            case "close":
                // graceful close
                conn.client.end()
                conn.target.end()
                break

            case "corrupt":
                // flip some bits
                var corrupted = Buffer.from(data)
                if (corrupted.length > 0) {
                    var idx = Math.floor(Math.random() * corrupted.length)
                    corrupted[idx] ^= 0xff
                }
                dest.write(corrupted)
                break

            case "close-server-side":
                // only kill the server->client direction
                if (direction === "s2c") {
                    conn.client.destroy()
                    conn.target.destroy()
                } else {
                    dest.write(data)
                }
                break

            default:
                dest.write(data)
        }
    }

    // Switch proxy mode. Returns previous mode.
    set_mode(mode, opts) {
        var prev = this.mode
        this.mode = mode
        if (opts && opts.delay_ms) this.delay_ms = opts.delay_ms
        return prev
    }

    // Kill all current connections
    disconnect_all() {
        for (var conn of this.connections.slice()) {
            conn.client.destroy()
            conn.target.destroy()
            conn.alive = false
        }
        this.connections = []
    }

    // Kill connections then restore passthrough
    reset() {
        this.disconnect_all()
        this.mode = "passthrough"
        this.delay_ms = 0
    }

    connection_count() {
        return this.connections.filter(c => c.alive).length
    }

    async stop() {
        this.disconnect_all()
        if (this.server) {
            await new Promise(resolve => this.server.close(resolve))
            this.server = null
        }
    }
}

module.exports = { SocketProxy }
