// Test Suite: Reconnects
//
// Tests for reliable reconnection behavior. These track connections
// at the server level (via _on_subscribe) rather than checking
// patch content, so they test the reconnection mechanism itself.
//
// Uses the "subscribe" command to test braid_fetch reconnection
// directly, independent of simpleton.
//
// (See specs.md sections 3, 4, 5, 8, 9, 10)

var { assert_truthy, assert_equal, wait_for, sleep } = require("../lib/assertions")

module.exports = [

    {
        id: "reconnects-1",
        name: "Reconnect after connection close",
        description: "Server closes the subscription; client reconnects (specs.md 3.1)",
        async run({ server, proxy, client, doc, base_url }) {
            var connections = 0
            server._on_subscribe = (req, res, url) => {
                if (url === doc) connections++
            }

            await client.send("subscribe", {
                url: base_url + doc,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => connections >= 1,
                { timeout_ms: 5000, msg: "Client should connect" })

            // Kill the connection
            proxy.disconnect_all()
            await sleep(500)
            proxy.set_mode("passthrough")

            // Client should reconnect — a second subscribe request arrives
            await wait_for(() => connections >= 2,
                { timeout_ms: 10000, msg: "Client should reconnect after disconnect" })

            server._on_subscribe = null
        }
    },

    {
        id: "reconnects-2",
        name: "Reconnect after TCP RST",
        description: "Proxy injects a TCP RST; client reconnects (specs.md 3.2)",
        async run({ server, proxy, client, doc, base_url }) {
            var connections = 0
            server._on_subscribe = (req, res, url) => {
                if (url === doc) connections++
            }

            await client.send("subscribe", {
                url: base_url + doc,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => connections >= 1,
                { timeout_ms: 5000, msg: "Client should connect" })

            // RST the connection — set mode then trigger it
            proxy.set_mode("rst")
            proxy.disconnect_all()
            await sleep(500)
            proxy.set_mode("passthrough")

            await wait_for(() => connections >= 2,
                { timeout_ms: 10000, msg: "Client should reconnect after RST" })

            server._on_subscribe = null
        }
    },

    {
        id: "reconnects-3",
        name: "Reconnect sends Parents header",
        description: "After reconnecting, client sends Parents with last received version (specs.md 10.1)",
        async run({ server, proxy, client, doc, base_url }) {
            var connections = []
            server._on_subscribe = (req, res, url) => {
                if (url === doc) connections.push({ parents: req.headers.parents || null })
            }

            // Seed doc so the initial subscription delivers a version
            await server.insert_at(doc, 0, "hello")

            await client.send("subscribe", {
                url: base_url + doc,
                headers: { "Merge-Type": "simpleton" }
            })

            // Wait for first connection and at least one update received
            await wait_for(() => connections.length >= 1 && client.updates.length >= 1,
                { timeout_ms: 5000, msg: "Client should connect and receive data" })

            // Disconnect
            proxy.disconnect_all()
            await sleep(500)
            proxy.set_mode("passthrough")

            // Wait for reconnection
            await wait_for(() => connections.length >= 2,
                { timeout_ms: 10000, msg: "Client should reconnect" })

            // The reconnect request should have Parents
            var reconnect = connections[connections.length - 1]
            assert_truthy(reconnect.parents,
                "Reconnect request should include a Parents header")
            assert_truthy(reconnect.parents.length > 0,
                "Parents header should contain version info")

            server._on_subscribe = null
        }
    },

    {
        id: "reconnects-4",
        name: "503 then recovery",
        description: "Server returns 503 on first attempt; client retries and connects (specs.md 2.6)",
        async run({ server, proxy, client, doc, base_url }) {
            var attempts = 0
            var successful_connections = 0
            server._on_subscribe = (req, res, url) => {
                if (url !== doc) return
                attempts++
                if (attempts === 1) {
                    res.writeHead(503, { "Retry-After": "1" })
                    res.end("Service Unavailable")
                    req.url = "/dev/null"
                } else {
                    successful_connections++
                }
            }

            await client.send("subscribe", {
                url: base_url + doc,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => successful_connections >= 1,
                { timeout_ms: 10000, msg: "Client should retry after 503 and connect" })

            assert_truthy(attempts >= 2, "Client should have made at least 2 attempts")

            server._on_subscribe = null
        }
    },

    {
        id: "reconnects-5",
        name: "Rapid disconnect cycling",
        description: "3 disconnects in quick succession; client reconnects each time",
        async run({ server, proxy, client, doc, base_url }) {
            var connections = 0
            server._on_subscribe = (req, res, url) => {
                if (url === doc) connections++
            }

            await client.send("subscribe", {
                url: base_url + doc,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => connections >= 1,
                { timeout_ms: 5000, msg: "Client should connect" })

            for (var i = 0; i < 3; i++) {
                proxy.disconnect_all()
                await sleep(300)
                proxy.set_mode("passthrough")
                await wait_for(() => connections >= i + 2,
                    { timeout_ms: 10000, msg: `Client should reconnect (cycle ${i + 1})` })
            }

            assert_truthy(connections >= 4,
                `Expected at least 4 connections (1 initial + 3 reconnects), got ${connections}`)

            server._on_subscribe = null
        }
    },

    {
        id: "reconnects-6",
        name: "Client can unsubscribe",
        description: "Client aborts a subscription via unsubscribe; no reconnect attempts after",
        async run({ server, proxy, client, doc, base_url }) {
            var connections = 0
            server._on_subscribe = (req, res, url) => {
                if (url === doc) connections++
            }

            await client.send("subscribe", {
                url: base_url + doc,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => connections >= 1,
                { timeout_ms: 5000, msg: "Client should connect" })

            // Unsubscribe from the client side
            await client.send("unsubscribe")

            var connections_after_abort = connections
            await sleep(3000)

            // No new connections should have been made
            assert_equal(connections, connections_after_abort,
                "Client should not reconnect after unsubscribe")

            server._on_subscribe = null
        }
    },

    // Coming soon:
    //
    // - Close after partial patch → discard partial, retry (3.4)
    // - RST mid-patch → discard partial, retry (3.6)
    // - Blackhole → heartbeat timeout → retry (4.2)
    // - Heartbeat timing: timeout = 1.2 * N + 3 (4.H1)
    // - PUT queue retried in order after disconnect (9.1)
    // - Retry-After delay respected (specs.md retry delay)

]
