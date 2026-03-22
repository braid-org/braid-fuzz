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
        name: "Reconnect after TCP RST mid-stream",
        description: "Proxy injects TCP RST when data flows; client reconnects (specs.md 3.2)",
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

            // Arm RST mode — next data on the connection triggers the RST
            proxy.set_mode("rst")

            // Server edit causes data to flow on the subscription → hits RST
            await server.insert_at(doc, 0, "trigger-rst")
            await sleep(500)

            // Restore so the client can reconnect
            proxy.set_mode("passthrough")

            await wait_for(() => connections >= 2,
                { timeout_ms: 10000, msg: "Client should reconnect after RST" })

            server._on_subscribe = null
        }
    },

    {
        id: "reconnects-3",
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
        id: "reconnects-4",
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
        id: "reconnects-5",
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

    {
        id: "reconnects-6",
        name: "500 then recovery",
        description: "Server returns 500 on first attempt; client warns and retries (specs.md 2.9)",
        async run({ server, proxy, client, doc, base_url }) {
            var attempts = 0
            var successful_connections = 0
            server._on_subscribe = (req, res, url) => {
                if (url !== doc) return
                attempts++
                if (attempts === 1) {
                    res.writeHead(500)
                    res.end("Internal Server Error")
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
                { timeout_ms: 10000, msg: "Client should retry after 500 and connect" })

            assert_truthy(attempts >= 2, "Client should have made at least 2 attempts")

            server._on_subscribe = null
        }
    },

    {
        id: "reconnects-7",
        name: "Blackhole then disconnect triggers reconnect",
        description: "Proxy blackholes traffic, then kills connections; client reconnects (specs.md 4.2)",
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

            // Blackhole — data goes nowhere, connection stays open
            proxy.set_mode("blackhole")
            await sleep(1000)

            // Kill the blackholed connections so the client detects failure
            proxy.disconnect_all()
            await sleep(500)
            proxy.set_mode("passthrough")

            await wait_for(() => connections >= 2,
                { timeout_ms: 10000, msg: "Client should reconnect after blackhole + disconnect" })

            server._on_subscribe = null
        }
    },

    {
        id: "reconnects-8",
        name: "Close between patches",
        description: "Server sends a complete patch, then connection closes; client applies the patch and reconnects (specs.md 3.5)",
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

            // Send a complete patch
            await server.insert_at(doc, 0, "complete")

            // Wait for client to receive it
            await wait_for(() =>
                client.updates.some(u =>
                    (u.patches && u.patches.some(p => p.content === "complete")) ||
                    (u.body && u.body.includes("complete"))
                ),
                { timeout_ms: 5000, msg: "Client should receive the patch" })

            // Now close the connection
            proxy.disconnect_all()
            await sleep(500)
            proxy.set_mode("passthrough")

            // Client should reconnect
            await wait_for(() => connections >= 2,
                { timeout_ms: 10000, msg: "Client should reconnect after close between patches" })
        }
    },

    {
        id: "reconnects-9",
        name: "Multiple error statuses then recovery",
        description: "Server returns 503, then 500, then succeeds; client keeps retrying through different error codes",
        async run({ server, proxy, client, doc, base_url }) {
            var attempts = 0
            var successful_connections = 0
            server._on_subscribe = (req, res, url) => {
                if (url !== doc) return
                attempts++
                if (attempts === 1) {
                    res.writeHead(503)
                    res.end("Service Unavailable")
                    req.url = "/dev/null"
                } else if (attempts === 2) {
                    res.writeHead(500)
                    res.end("Internal Server Error")
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
                { timeout_ms: 15000, msg: "Client should eventually connect after multiple errors" })

            assert_truthy(attempts >= 3, "Client should have made at least 3 attempts")

            server._on_subscribe = null
        }
    },

    {
        id: "reconnects-10",
        name: "Reconnect after connection refused",
        description: "Proxy is down when client subscribes; client retries until proxy comes back (specs.md 1.2)",
        async run({ server, proxy, client, doc, base_url }) {
            var connections = 0
            server._on_subscribe = (req, res, url) => {
                if (url === doc) connections++
            }

            // Stop the proxy so nothing is listening on the proxy port
            var proxy_port = proxy.listen_port
            await proxy.stop()

            // Client tries to subscribe — connection refused
            await client.send("subscribe", {
                url: base_url + doc,
                headers: { "Merge-Type": "simpleton" }
            })

            await sleep(2000)

            // Restart the proxy on the same port
            proxy.listen_port = proxy_port
            proxy.connections = []
            proxy.mode = "passthrough"
            await proxy.start()

            // Client should eventually reconnect
            await wait_for(() => connections >= 1,
                { timeout_ms: 15000, msg: "Client should connect after proxy comes back" })

            server._on_subscribe = null
        }
    },

]
