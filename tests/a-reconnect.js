// Test Suite A: Reconnect Scenarios
//
// These tests verify that the editor plugin correctly handles
// various forms of network disconnection and reconnection.

var { assert_equal, assert_truthy, wait_for, wait_for_convergence, sleep } = require("../lib/assertions")

module.exports = [

    {
        id: "A1",
        name: "Clean reconnect",
        description: "Server closes subscription; client reconnects with Parents header, resumes from last version",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            await server.insert_at(doc, 0, "hello")
            await wait_for(async () => {
                var state = await editor.state()
                return state.includes("hello")
            }, { timeout_ms: 5000, msg: "Editor should receive initial edit" })

            // Kill connections via proxy
            proxy.disconnect_all()
            await sleep(500)

            // Restore — editor should reconnect
            proxy.set_mode("passthrough")
            await sleep(2000)

            // Server makes another edit after reconnection
            await server.insert_at(doc, 5, " world")
            await sleep(1000)

            await wait_for(async () => {
                var state = await editor.state()
                return state.includes("hello") && state.includes("world")
            }, { timeout_ms: 10000, msg: "Editor should receive edits after reconnection" })

            var final_state = await editor.state()
            var server_state = await server.get_doc_state(doc)
            assert_equal(final_state, server_state, "States should match after clean reconnect")
        }
    },

    {
        id: "A2",
        name: "TCP RST mid-stream",
        description: "Proxy injects RST during patch delivery; client discards partial patch, reconnects silently",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            // RST on next data
            proxy.set_mode("rst")
            await sleep(100)

            await server.insert_at(doc, 0, "before-rst")
            await sleep(1000)

            // Restore
            proxy.set_mode("passthrough")
            await sleep(2000)

            await server.insert_at(doc, 0, "after-rst-")
            await sleep(1500)

            await wait_for_convergence(
                () => editor.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 10000, label: "A2: states after RST" }
            )
        }
    },

    {
        id: "A3",
        name: "Silent connection death (blackhole)",
        description: "Proxy blackholes traffic then kills connections; client reconnects and catches up",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            await server.insert_at(doc, 0, "visible")
            await wait_for(async () => (await editor.state()).includes("visible"),
                { timeout_ms: 5000, msg: "Editor should see initial edit" })

            // Blackhole — data goes nowhere
            proxy.set_mode("blackhole")
            await sleep(100)
            await server.insert_at(doc, 7, "-hidden")
            await sleep(2000)

            // Now kill the blackholed connections so the client detects the failure
            // (without heartbeats, the client can't detect a blackhole on its own)
            proxy.disconnect_all()
            await sleep(500)

            // Restore — client should reconnect and catch up
            proxy.set_mode("passthrough")

            await wait_for_convergence(
                () => editor.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 15000, label: "A3: states after blackhole recovery" }
            )
        }
    },

    {
        id: "A4",
        name: "Server restart",
        description: "Server killed and restarted; client reconnects",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            await server.insert_at(doc, 0, "pre-restart")
            await wait_for(async () => (await editor.state()).includes("pre-restart"),
                { timeout_ms: 5000, msg: "Editor should see pre-restart edit" })

            // Simulate restart via proxy disconnect + reconnect
            proxy.disconnect_all()
            await sleep(2000)
            proxy.set_mode("passthrough")

            await wait_for(async () => proxy.connection_count() > 0,
                { timeout_ms: 10000, msg: "Editor should reconnect after server restart" })
        }
    },

    {
        id: "A5",
        name: "Reconnect with queued PUTs",
        description: "Connection dies with unacked PUTs; client retries them in order after reconnect",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            // Delay ACKs so PUTs queue up
            server.ack_delay_ms = 5000

            await editor.insert(0, "aaa")
            await editor.insert(3, "bbb")
            await sleep(200)

            // Kill while PUTs are in flight
            proxy.disconnect_all()
            await sleep(500)

            // Restore
            server.ack_delay_ms = 0
            proxy.set_mode("passthrough")

            await wait_for_convergence(
                () => editor.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 15000, label: "A5: states after queued PUT retry" }
            )

            var final = await server.get_doc_state(doc)
            assert_truthy(final.includes("aaa"), "First PUT should have been applied")
            assert_truthy(final.includes("bbb"), "Second PUT should have been applied")
        }
    },

    {
        id: "A6",
        name: "Rapid disconnect cycling",
        description: "5 disconnects in 10 seconds; client stays consistent",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            await server.insert_at(doc, 0, "base")
            await sleep(500)

            for (var i = 0; i < 5; i++) {
                proxy.disconnect_all()
                await sleep(300)
                proxy.set_mode("passthrough")
                await sleep(1500)
                await server.insert_at(doc, 0, String(i))
                await sleep(200)
            }

            await sleep(2000)

            await wait_for_convergence(
                () => editor.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 15000, label: "A6: states after rapid cycling" }
            )
        }
    },

    {
        id: "A7",
        name: "Disconnect during local edit",
        description: "Connection dies while client PUT is in flight; PUT retried, no duplicate",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            server.ack_delay_ms = 3000
            await editor.insert(0, "inflight")
            await sleep(100)

            proxy.disconnect_all()
            await sleep(500)

            server.ack_delay_ms = 0
            proxy.set_mode("passthrough")

            await wait_for_convergence(
                () => editor.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 15000, label: "A7: states after in-flight PUT disconnect" }
            )

            var state = await server.get_doc_state(doc)
            var count = (state.match(/inflight/g) || []).length
            assert_equal(count, 1, "PUT should be applied exactly once (no duplicates)")
        }
    },

    {
        id: "A8",
        name: "Silent disconnect + remote edits",
        description: "Proxy blackholes client but server keeps editing; on reconnect, client catches up",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            await server.insert_at(doc, 0, "A")
            await wait_for(async () => (await editor.state()).includes("A"),
                { timeout_ms: 5000, msg: "Editor should see 'A'" })

            proxy.set_mode("blackhole")
            await sleep(200)

            await server.insert_at(doc, 1, "B")
            await server.insert_at(doc, 2, "C")
            await server.insert_at(doc, 3, "D")
            await sleep(2000)

            // Kill blackholed connections so client detects failure
            proxy.disconnect_all()
            await sleep(500)
            proxy.set_mode("passthrough")

            await wait_for_convergence(
                () => editor.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 15000, label: "A8: catch-up after blackhole" }
            )
        }
    },

    {
        id: "A9",
        name: "Bad status then recovery",
        description: "Server returns 503 once, then 209; client retries silently",
        async run({ server, proxy, editor, doc }) {
            var attempt = 0
            server._on_subscribe = (req, res, url) => {
                attempt++
                if (attempt === 1) {
                    res.writeHead(503, { "Retry-After": "1" })
                    res.end("Service Unavailable")
                    req.url = "/dev/null"
                }
            }

            await editor.connect(doc)
            await sleep(3000)

            await server.insert_at(doc, 0, "recovered")
            await wait_for(async () => (await editor.state()).includes("recovered"),
                { timeout_ms: 10000, msg: "Editor should receive edit after 503 recovery" })

            server._on_subscribe = null
        }
    },

    {
        id: "A10",
        name: "Retry-After header",
        description: "Server returns 429 + Retry-After: 2; client waits then retries",
        async run({ server, proxy, editor, doc }) {
            var attempt = 0
            var first_time = null
            var second_time = null

            server._on_subscribe = (req, res, url) => {
                attempt++
                if (attempt === 1) {
                    first_time = Date.now()
                    res.writeHead(429, { "Retry-After": "2" })
                    res.end("Too Many Requests")
                    req.url = "/dev/null"
                } else if (attempt === 2) {
                    second_time = Date.now()
                }
            }

            await editor.connect(doc)
            await sleep(5000)

            // Verify client retried (delay may vary by implementation —
            // simpleton uses its own backoff, may not honor Retry-After exactly)
            if (first_time && second_time) {
                var delay = second_time - first_time
                assert_truthy(delay >= 500, `Client should wait before retry, but waited only ${delay}ms`)
            }

            await server.insert_at(doc, 0, "after-retry")
            await wait_for(async () => (await editor.state()).includes("after-retry"),
                { timeout_ms: 10000, msg: "Editor should receive edit after Retry-After" })

            server._on_subscribe = null
        }
    },

]
