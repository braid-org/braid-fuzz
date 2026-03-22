#!/usr/bin/env node

// Minimal braid-fuzz client — hello world example
//
// This is the smallest possible client that can pass a braid-fuzz test.
// It handles the "braid_fetch" command by subscribing to a URL using
// braid-http's braid_fetch, and pushes updates back to the test harness.
//
// Run it:
//   node braid-fuzz.js serve "node ./examples/minimal-client.js" -subscriptions-1
//
// Or connect to the server:
//   node braid-fuzz.js serve -subscriptions-1
//   # then in another terminal:
//   node ./examples/minimal-client.js < /dev/null  # (stdin/stdout mode needs the test runner)

var readline = require("readline")
var { fetch: braid_fetch } = require("braid-http")

// Read JSON commands from stdin, write JSON responses to stdout
var rl = readline.createInterface({ input: process.stdin })

rl.on("line", line => {
    if (!line.trim()) return
    var msg = JSON.parse(line)

    switch (msg.cmd) {

        case "braid_fetch": {
            // Subscribe to a URL using braid_fetch
            braid_fetch(msg.url, {
                subscribe: msg.subscribe,
                headers: msg.headers || {},
                retry: () => true,
            }).then(res => {
                res.subscribe(update => {
                    // Push each update to the test harness
                    var data = {
                        version: update.version || null,
                        parents: update.parents || null,
                    }
                    if (update.body != null) data.body = update.body_text
                    if (update.patches) {
                        data.patches = update.patches.map(p => ({
                            range: p.range.match(/\d+/g).map(Number),
                            content: p.content_text,
                        }))
                    }
                    process.stdout.write(JSON.stringify({
                        event: "fetch-update", data
                    }) + "\n")
                })
            })

            // Acknowledge the command
            process.stdout.write(JSON.stringify({ id: msg.id, ok: true }) + "\n")
            break
        }

        default:
            process.stdout.write(JSON.stringify({ id: msg.id, ok: true }) + "\n")
    }
})
