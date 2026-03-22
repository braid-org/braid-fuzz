// Test Suite: HTTP
//
// Basic HTTP tests — can the client make open-http requests?
// This is the lowest layer, below subscription parsing or reliable updates.

var { assert_truthy, wait_for } = require("../lib/assertions")

module.exports = [

    {
        id: "http-1",
        name: "Connect to server",
        description: "Client makes a braid_fetch request and connects to the server",
        async run({ server, proxy, client, doc, base_url }) {
            var connected = false
            server._on_subscribe = (req, res, url) => {
                if (url === doc) connected = true
            }

            await client.send("open-http", {
                url: base_url + doc,
                subscribe: true,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => connected,
                { timeout_ms: 5000, msg: "Client should connect to server" })

            server._on_subscribe = null
        }
    },

    {
        id: "http-2",
        name: "Send a PUT",
        description: "Client sends a braid_fetch PUT and receives an acknowledgment",
        async run({ server, proxy, client, doc, base_url }) {
            var received = 0
            server._on_put = (req, res, url) => {
                if (url === doc) received++
            }

            var peer = Math.random().toString(36).slice(2)
            await client.send("open-http", {
                url: base_url + doc,
                method: "PUT",
                version: [peer + "-1"],
                parents: [],
                patches: [{ unit: "text", range: "[0:0]", content: "hello" }],
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => client.acks.length >= 1,
                { timeout_ms: 5000, msg: "Client should receive PUT acknowledgment" })

            assert_truthy(received >= 1, "Server should have received the PUT")

            server._on_put = null
        }
    },

]
