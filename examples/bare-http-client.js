#!/usr/bin/env node

// Bare HTTP braid-fuzz client — no braid libraries at all
//
// Passes subscriptions-1 using only Node's built-in http module.
// Shows what braid_fetch does under the hood: a long-lived GET
// with a Subscribe header, parsing the multiresponse body.
//
// Run it:
//   node braid-fuzz.js serve "node ./examples/bare-http-client.js" -subscriptions-1

var readline = require("readline")
var http = require("http")

var rl = readline.createInterface({ input: process.stdin })

rl.on("line", line => {
    if (!line.trim()) return
    var msg = JSON.parse(line)

    switch (msg.cmd) {

        case "braid_fetch": {
            var url = new URL(msg.url)

            var req = http.request({
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                headers: { "Subscribe": "true", ...msg.headers }
            })

            req.end()

            req.on("response", res => {
                // Parse the braid multiresponse stream
                var buf = ""
                var headers = {}
                var state = "headers"  // "headers" or "body"
                var body_len = 0
                var body = ""

                res.on("data", chunk => {
                    buf += chunk
                    parse()
                })

                function parse() {
                    while (buf.length > 0) {
                        if (state === "headers") {
                            var nl = buf.indexOf("\r\n")
                            if (nl === -1) return  // need more data
                            var line = buf.slice(0, nl)
                            buf = buf.slice(nl + 2)

                            if (line === "") {
                                // Blank line = end of headers
                                if (Object.keys(headers).length === 0) continue  // heartbeat

                                var cl = parseInt(headers["content-length"] || "0")
                                if (cl > 0) {
                                    state = "body"
                                    body_len = cl
                                    body = ""
                                } else {
                                    emit_update(headers, "")
                                    headers = {}
                                }
                            } else {
                                var colon = line.indexOf(":")
                                if (colon > 0) {
                                    var key = line.slice(0, colon).trim().toLowerCase()
                                    var val = line.slice(colon + 1).trim()
                                    headers[key] = val
                                }
                            }
                        } else if (state === "body") {
                            var need = body_len - body.length
                            body += buf.slice(0, need)
                            buf = buf.slice(need)
                            if (body.length >= body_len) {
                                emit_update(headers, body)
                                headers = {}
                                state = "headers"
                            }
                        }
                    }
                }

                function emit_update(h, body_text) {
                    var data = { version: null, parents: null }
                    if (body_text) data.body = body_text

                    process.stdout.write(JSON.stringify({
                        event: "fetch-update", data
                    }) + "\n")
                }
            })

            process.stdout.write(JSON.stringify({ id: msg.id, ok: true }) + "\n")
            break
        }

        default:
            process.stdout.write(JSON.stringify({ id: msg.id, ok: true }) + "\n")
    }
})
