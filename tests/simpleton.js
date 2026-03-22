// Test Suite: Simpleton
//
// Tests for the simpleton merge protocol built on top of
// braid subscriptions. These use the "connect" command to
// start a simpleton_client, and "insert"/"delete"/"state"
// to drive local edits and check convergence.

var { assert_equal, assert_truthy, wait_for, wait_for_convergence, sleep } = require("../lib/assertions")

module.exports = [

    {
        id: "simpleton-1",
        name: "Initial subscribe",
        description: "Client subscribes via simpleton; buffer matches server state",
        async run({ server, client, doc }) {
            await server.insert_at(doc, 0, "initial content")
            await client.connect(doc)

            await wait_for(async () => (await client.state()) === "initial content",
                { timeout_ms: 5000, msg: "Client buffer should match server state" })

            assert_equal(await client.state(), await server.get_doc_state(doc),
                "Client and server should match on initial subscribe")
        }
    },

    {
        id: "simpleton-2",
        name: "Local edit round-trip",
        description: "Client inserts text; server receives PUT; states converge",
        async run({ server, client, doc }) {
            await client.connect(doc)
            await sleep(500)

            await client.insert(0, "hello")

            await wait_for(async () => (await server.get_doc_state(doc)).includes("hello"),
                { timeout_ms: 5000, msg: "Server should receive the client's edit" })

            try { await client.wait_ack() } catch (e) {}
            await sleep(500)

            assert_equal(await client.state(), await server.get_doc_state(doc),
                "States should match after local edit round-trip")
        }
    },

    {
        id: "simpleton-3",
        name: "Receive remote edit",
        description: "Server edits; client receives patch and buffer updates",
        async run({ server, client, doc }) {
            await client.connect(doc)
            await sleep(500)

            await server.insert_at(doc, 0, "remote edit")

            await wait_for(async () => (await client.state()) === "remote edit",
                { timeout_ms: 5000, msg: "Client should receive remote patch" })
        }
    },

    {
        id: "simpleton-4",
        name: "Concurrent edits converge",
        description: "Client and server both insert at pos 0 simultaneously; both converge to the same state",
        async run({ server, client, doc }) {
            await client.connect(doc)
            await sleep(500)

            var p1 = client.insert(0, "CLIENT")
            var p2 = server.insert_at(doc, 0, "SERVER")
            await Promise.all([p1, p2])

            await wait_for_convergence(
                () => client.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 10000, label: "Concurrent insert convergence" }
            )

            var state = await client.state()
            assert_truthy(state.includes("CLIENT"), "State should contain CLIENT")
            assert_truthy(state.includes("SERVER"), "State should contain SERVER")
        }
    },

    {
        id: "simpleton-5",
        name: "Interleaved edits",
        description: "Alternating client/server edits (5 each); all present in final state",
        async run({ server, client, doc }) {
            await client.connect(doc)
            await sleep(500)

            for (var i = 0; i < 5; i++) {
                await client.insert(0, `c${i}`)
                await sleep(200)
                await server.insert_at(doc, 0, `S${i}`)
                await sleep(200)
            }

            await wait_for_convergence(
                () => client.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 10000, label: "Interleaved edits" }
            )

            var state = await client.state()
            for (var i = 0; i < 5; i++) {
                assert_truthy(state.includes(`c${i}`), `Should contain c${i}`)
                assert_truthy(state.includes(`S${i}`), `Should contain S${i}`)
            }
        }
    },

    {
        id: "simpleton-6",
        name: "Edit during reconnect",
        description: "Client makes local edit while disconnected; on reconnect, edit merges with server's edits",
        async run({ server, proxy, client, doc }) {
            await client.connect(doc)
            await sleep(500)

            await server.insert_at(doc, 0, "base")
            await wait_for(async () => (await client.state()) === "base",
                { timeout_ms: 5000, msg: "Client should see 'base'" })

            proxy.disconnect_all()
            await sleep(500)

            await client.insert(4, "-offline")
            await server.insert_at(doc, 0, "prefix-")

            proxy.set_mode("passthrough")

            await wait_for_convergence(
                () => client.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 15000, label: "Edit during disconnect" }
            )

            var state = await client.state()
            assert_truthy(state.includes("base"), "Should contain 'base'")
            assert_truthy(state.includes("offline"), "Should contain 'offline'")
            assert_truthy(state.includes("prefix"), "Should contain 'prefix'")
        }
    },

    {
        id: "simpleton-7",
        name: "Multi-client fuzz",
        description: "3 clients + server all make random edits concurrently; all converge to the same state",
        needs_extra_clients: 2,
        async run({ server, client, doc, extra_clients }) {
            var clients = [client, ...extra_clients]
            var labels = ["alpha", "beta", "gamma"]
            var edits = []  // track all edits for verification

            // Connect all clients
            for (var c of clients) {
                await c.connect(doc)
            }
            await sleep(1000)

            // 3 rounds: each round, every client and the server insert at pos 0
            for (var round = 0; round < 3; round++) {
                for (var ci = 0; ci < clients.length; ci++) {
                    var text = `${labels[ci]}${round}`
                    edits.push(text)
                    await clients[ci].insert(0, text)
                    await sleep(100)
                }
                // Server also inserts
                var server_text = `server${round}`
                edits.push(server_text)
                await server.insert_at(doc, 0, server_text)
                await sleep(300)
            }

            // Wait for all to converge
            var converged = false
            for (var attempt = 0; attempt < 60; attempt++) {
                var states = []
                for (var c of clients) states.push(await c.state())
                states.push(await server.get_doc_state(doc))

                if (states.every(s => s === states[0])) {
                    converged = true
                    break
                }
                await sleep(500)
            }

            assert_truthy(converged, "All 3 clients + server should converge")

            // Verify all edits are present in the final state
            var final_state = await client.state()
            for (var text of edits) {
                assert_truthy(final_state.includes(text),
                    `Final state should contain "${text}"`)
            }
        }
    },

]
