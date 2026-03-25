// Test Suite: Reliable Updates
//
// Tests for reliable update delivery: subscription reconnection,
// heartbeat liveness detection, PUT retry, and PUT queue ordering.
//
// All tests use the "open-http" command — with subscribe: true
// for subscriptions, or method: "PUT" for PUTs.
//
// (See specs.md sections 1-10)

var { assert_truthy, assert_equal, wait_for, wait_for_convergence, sleep } = require("../lib/assertions")

module.exports = [

    // ── Subscription reconnection ───────────────────────────────

    {
        id: "reliable-updates-1",
        name: "Reconnect after connection close",
        description: "Server closes the subscription; client reconnects (specs.md 3.1)",
        async run({ server, proxy, client, doc, base_url }) {
            var connections = 0
            server._on_subscribe = (req, res, url) => {
                if (url === doc) connections++
            }

            await client.send("open-http", {
                url: base_url + doc,
                subscribe: true,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => connections >= 1,
                { timeout_ms: 5000, msg: "Client should connect" })

            proxy.disconnect_all()
            await sleep(500)
            proxy.set_mode("passthrough")

            await wait_for(() => connections >= 2,
                { timeout_ms: 10000, msg: "Client should reconnect after disconnect" })

            server._on_subscribe = null
        }
    },

    {
        id: "reliable-updates-2",
        name: "Reconnect after TCP RST mid-stream",
        description: "Proxy injects TCP RST when data flows; client reconnects (specs.md 3.2)",
        async run({ server, proxy, client, doc, base_url }) {
            var connections = 0
            server._on_subscribe = (req, res, url) => {
                if (url === doc) connections++
            }

            await client.send("open-http", {
                url: base_url + doc,
                subscribe: true,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => connections >= 1,
                { timeout_ms: 5000, msg: "Client should connect" })

            proxy.set_mode("rst")
            await server.insert_at(doc, 0, "trigger-rst")
            await sleep(500)
            proxy.set_mode("passthrough")

            await wait_for(() => connections >= 2,
                { timeout_ms: 10000, msg: "Client should reconnect after RST" })

            server._on_subscribe = null
        }
    },

    {
        id: "reliable-updates-3",
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

            await client.send("open-http", {
                url: base_url + doc,
                subscribe: true,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => successful_connections >= 1,
                { timeout_ms: 10000, msg: "Client should retry after 503 and connect" })

            assert_truthy(attempts >= 2, "Client should have made at least 2 attempts")
            server._on_subscribe = null
        }
    },

    {
        id: "reliable-updates-4",
        name: "Rapid disconnect cycling",
        description: "3 disconnects in quick succession; client reconnects each time",
        async run({ server, proxy, client, doc, base_url }) {
            var connections = 0
            server._on_subscribe = (req, res, url) => {
                if (url === doc) connections++
            }

            await client.send("open-http", {
                url: base_url + doc,
                subscribe: true,
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
        id: "reliable-updates-5",
        name: "Client can unsubscribe",
        description: "Client aborts a subscription via unsubscribe; no reconnect attempts after",
        async run({ server, proxy, client, doc, base_url }) {
            var connections = 0
            server._on_subscribe = (req, res, url) => {
                if (url === doc) connections++
            }

            await client.send("open-http", {
                url: base_url + doc,
                subscribe: true,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => connections >= 1,
                { timeout_ms: 5000, msg: "Client should connect" })

            await client.send("close-http")

            var connections_after = connections
            await sleep(3000)

            assert_equal(connections, connections_after,
                "Client should not reconnect after unsubscribe")
            server._on_subscribe = null
        }
    },

    {
        id: "reliable-updates-6",
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

            await client.send("open-http", {
                url: base_url + doc,
                subscribe: true,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => successful_connections >= 1,
                { timeout_ms: 10000, msg: "Client should retry after 500 and connect" })

            assert_truthy(attempts >= 2, "Client should have made at least 2 attempts")
            server._on_subscribe = null
        }
    },

    {
        id: "reliable-updates-7",
        name: "Blackhole detected via heartbeat timeout",
        description: "Proxy blackholes traffic; client detects dead connection via heartbeat timeout and reconnects (specs.md 4.2)",
        async run({ server, proxy, client, doc, base_url }) {
            var connections = 0
            server._on_subscribe = (req, res, url) => {
                if (url === doc) connections++
            }

            // Use a short heartbeat so the test doesn't take too long.
            // Client should set timeout = 1.2 * N + 3 seconds.
            // With N=2: timeout = 5.4s
            var heartbeat_s = 2
            var expected_timeout_s = 1.2 * heartbeat_s + 3

            await client.send("open-http", {
                url: base_url + doc,
                subscribe: true,
                heartbeats: heartbeat_s,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => connections >= 1,
                { timeout_ms: 5000, msg: "Client should connect" })

            // Wait for at least one heartbeat to arrive so the client
            // has established its liveness timer
            await sleep(heartbeat_s * 1000 + 500)

            // Blackhole — no more data reaches the client.
            // Don't disconnect_all() — the client must detect this on
            // its own via the heartbeat timeout.
            proxy.set_mode("blackhole")

            // The heartbeat timeout fires after ~expected_timeout_s.
            // The client will retry while still blackholed — those
            // retry connections get swallowed. After restoring passthrough,
            // disconnect stale sockets so the next retry gets a clean path.
            await sleep((expected_timeout_s + 2) * 1000)
            proxy.set_mode("passthrough")
            proxy.disconnect_all()

            await wait_for(() => connections >= 2,
                { timeout_ms: 15000, msg: "Client should reconnect after heartbeat timeout detects blackhole" })

            server._on_subscribe = null
        }
    },

    {
        id: "reliable-updates-8",
        name: "Close between patches",
        description: "Server sends a complete patch, then connection closes; client applies the patch and reconnects (specs.md 3.5)",
        async run({ server, proxy, client, doc, base_url }) {
            var connections = 0
            server._on_subscribe = (req, res, url) => {
                if (url === doc) connections++
            }

            await client.send("open-http", {
                url: base_url + doc,
                subscribe: true,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => connections >= 1,
                { timeout_ms: 5000, msg: "Client should connect" })

            await server.insert_at(doc, 0, "complete")

            await wait_for(() =>
                client.updates.some(u =>
                    (u.patches && u.patches.some(p => p.content === "complete")) ||
                    (u.body && u.body.includes("complete"))
                ),
                { timeout_ms: 5000, msg: "Client should receive the patch" })

            proxy.disconnect_all()
            await sleep(500)
            proxy.set_mode("passthrough")

            await wait_for(() => connections >= 2,
                { timeout_ms: 10000, msg: "Client should reconnect after close between patches" })
        }
    },

    {
        id: "reliable-updates-9",
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

            await client.send("open-http", {
                url: base_url + doc,
                subscribe: true,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => successful_connections >= 1,
                { timeout_ms: 15000, msg: "Client should eventually connect after multiple errors" })

            assert_truthy(attempts >= 3, "Client should have made at least 3 attempts")
            server._on_subscribe = null
        }
    },

    {
        id: "reliable-updates-10",
        name: "Reconnect after connection refused",
        description: "Proxy is down when client subscribes; client retries until proxy comes back (specs.md 1.2)",
        async run({ server, proxy, client, doc, base_url }) {
            var connections = 0
            server._on_subscribe = (req, res, url) => {
                if (url === doc) connections++
            }

            var proxy_port = proxy.listen_port
            await proxy.stop()

            await client.send("open-http", {
                url: base_url + doc,
                subscribe: true,
                headers: { "Merge-Type": "simpleton" }
            })

            await sleep(2000)

            proxy.listen_port = proxy_port
            proxy.connections = []
            proxy.mode = "passthrough"
            await proxy.start()

            await wait_for(() => connections >= 1,
                { timeout_ms: 15000, msg: "Client should connect after proxy comes back" })

            server._on_subscribe = null
        }
    },

    // ── PUT retry ───────────────────────────────────────────────

    {
        id: "reliable-updates-11",
        name: "PUT delivered successfully",
        description: "Client sends a PUT via braid_fetch; server receives it and ACKs (specs.md 8)",
        async run({ server, proxy, client, doc, base_url }) {
            var received_puts = 0
            server._on_put = (req, res, url) => {
                if (url === doc) received_puts++
            }

            var peer = Math.random().toString(36).slice(2)
            await client.send("open-http", {
                method: "PUT",
                url: base_url + doc,
                version: [peer + "-5"],
                parents: [],
                patches: [{ unit: "text", range: "[0:0]", content: "hello" }],
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => client.acks.length >= 1,
                { timeout_ms: 5000, msg: "Client should receive PUT ACK" })

            assert_truthy(received_puts >= 1, "Server should have received the PUT")
            server._on_put = null
        }
    },

    {
        id: "reliable-updates-12",
        name: "PUT retried after connection dies",
        description: "Client sends PUT, connection dies before ACK; PUT is retried (specs.md 8.1)",
        async run({ server, proxy, client, doc, base_url }) {
            var received_puts = 0
            server._on_put = (req, res, url) => {
                if (url === doc) received_puts++
            }

            // Delay ACK so the PUT is in flight when we disconnect
            server.ack_delay_ms = 5000

            var peer = Math.random().toString(36).slice(2)
            await client.send("open-http", {
                method: "PUT",
                url: base_url + doc,
                version: [peer + "-5"],
                parents: [],
                patches: [{ unit: "text", range: "[0:0]", content: "retry-me" }],
                headers: { "Merge-Type": "simpleton" }
            })

            await sleep(200)

            // Kill the connection while PUT is in flight
            proxy.disconnect_all()
            await sleep(500)

            server.ack_delay_ms = 0
            proxy.set_mode("passthrough")

            // The PUT should be retried and eventually ACKed
            await wait_for(() => client.acks.length >= 1,
                { timeout_ms: 15000, msg: "Client should eventually receive PUT ACK after retry" })

            assert_truthy(received_puts >= 2,
                "Server should have received the PUT at least twice (original + retry)")

            server._on_put = null
        }
    },

    {
        id: "reliable-updates-13",
        name: "PUT retried after 503",
        description: "Server returns 503 for a PUT; client retries and PUT eventually succeeds (specs.md 8.6)",
        async run({ server, proxy, client, doc, base_url }) {
            var put_attempts = 0
            server._on_put = (req, res, url) => {
                if (url !== doc) return
                put_attempts++
                if (put_attempts === 1) {
                    res.writeHead(503, { "Retry-After": "1" })
                    res.end("Service Unavailable")
                    req.url = "/dev/null-put"
                }
            }

            var peer = Math.random().toString(36).slice(2)
            await client.send("open-http", {
                method: "PUT",
                url: base_url + doc,
                version: [peer + "-5"],
                parents: [],
                patches: [{ unit: "text", range: "[0:0]", content: "after-503" }],
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => client.acks.length >= 1,
                { timeout_ms: 15000, msg: "Client should eventually receive PUT ACK after 503 retry" })

            assert_truthy(put_attempts >= 2,
                "Client should have retried the PUT at least once")

            server._on_put = null
        }
    },

    // ── Advanced failure scenarios ────────────────────────────────

    {
        id: "reliable-updates-14",
        name: "Full network outage with edits on both sides",
        description: "Both subscription and PUT connections die; client and server both edit; on recovery, states converge",
        async run({ server, proxy, client, doc, base_url }) {
            // This test uses simpleton-level sync to verify data integrity
            await client.connect(doc)
            await sleep(500)

            await server.insert_at(doc, 0, "base")
            await wait_for(async () => (await client.state()) === "base",
                { timeout_ms: 5000, msg: "Client should see 'base'" })

            // Kill everything — RST both directions
            proxy.set_mode("rst")
            proxy.disconnect_all()
            await sleep(500)

            // Both sides edit while fully disconnected
            await client.insert(4, "-client")
            await server.insert_at(doc, 0, "server-")

            // Wait a bit to let edits settle, then restore
            await sleep(1000)
            proxy.set_mode("passthrough")

            await wait_for_convergence(
                () => client.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 20000, label: "Full outage recovery" }
            )

            var state = await client.state()
            assert_truthy(state.includes("base"), "Should contain 'base'")
            assert_truthy(state.includes("client"), "Should contain 'client'")
            assert_truthy(state.includes("server"), "Should contain 'server'")
        }
    },

    {
        id: "reliable-updates-15",
        name: "Network flapping with edits",
        description: "5 rapid disconnect/reconnect cycles; client edits during each disconnected phase; all edits survive",
        async run({ server, proxy, client, doc, base_url }) {
            await client.connect(doc)
            await sleep(500)

            var all_edit_texts = []

            for (var i = 0; i < 5; i++) {
                // Disconnect
                proxy.disconnect_all()
                await sleep(300)

                // Client edits while disconnected
                var text = `flap${i}`
                all_edit_texts.push(text)
                await client.insert(0, text + " ")

                // Also server edits
                var server_text = `srv${i}`
                all_edit_texts.push(server_text)
                await server.insert_at(doc, 0, server_text + " ")

                // Reconnect
                proxy.set_mode("passthrough")
                await sleep(500)
            }

            await wait_for_convergence(
                () => client.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 20000, label: "Network flapping convergence" }
            )

            var state = await client.state()
            for (var text of all_edit_texts) {
                assert_truthy(state.includes(text),
                    `Final state should contain "${text}"`)
            }
        }
    },

]
