// Test fixture for the Braid webindex protocol.
//
// Wraps `braid-webindex` in a tiny HTTP server so tests can:
//   - add/remove paths to the index
//   - have the client subscribe via braid_fetch
//
// `reset()` swaps in a fresh index between tests, so leftover paths
// from one test don't bleed into the next.

var http = require("http")
var braid_webindex = require("braid-webindex")

class WebindexServer {
    constructor(opts = {}) {
        this.port = opts.port || 0
        this.host = opts.host || "127.0.0.1"
        this.server = null
        this.index = braid_webindex()
    }

    start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                this.index.serve(req, res, () => {
                    res.statusCode = 404
                    res.end("Not found")
                })
            })
            this.server.on("error", reject)
            this.server.listen(this.port, this.host, () => {
                this.port = this.server.address().port
                resolve(this.port)
            })
        })
    }

    add(path) { this.index.add(path) }
    remove(path) { this.index.remove(path) }
    set(paths) { this.index.set(paths) }

    reset() { this.index = braid_webindex() }

    async stop() {
        if (this.server) {
            await new Promise(resolve => this.server.close(resolve))
            this.server = null
        }
    }
}

module.exports = { WebindexServer }
