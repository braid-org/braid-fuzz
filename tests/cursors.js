// Test Suite: Cursors
//
// Tests for multiplayer cursor synchronization. Cursors are synced
// as a separate subscription alongside text, using the
// application/text-cursors+json content type.
//
// Controller commands used:
//   connect-cursors  — start cursor sharing on the synced document
//   set-cursor    — set local cursor position {pos, end}
//   get-cursors   — return map of {peer: [{from, to}]}

var { assert_equal, assert_truthy, wait_for, sleep } = require("../lib/assertions")

module.exports = [

    {
        id: "cursors-1",
        name: "Send cursor",
        description: "Client sets cursor position; server sees it in cursor snapshot",
        async run({ server, client, doc }) {
            await client.connect(doc)
            await sleep(500)

            // Insert some text so cursor positions are meaningful
            await client.insert(0, "hello world")
            try { await client.wait_ack() } catch (e) {}
            await sleep(500)

            // Open cursor sharing
            await client.send("connect-cursors", { doc })
            await sleep(500)

            // Set cursor at position 5
            await client.send("set-cursor", { pos: 5 })
            await sleep(1000)

            // Check server-side cursor snapshot
            var snapshot = await server.get_cursors(doc)
            var found = false
            for (var [peer_id, sels] of Object.entries(snapshot)) {
                if (Array.isArray(sels) && sels.length > 0) {
                    if (sels[0].from === 5 && sels[0].to === 5) found = true
                }
            }
            assert_truthy(found, "Server should have client cursor at position 5")
        }
    },

    {
        id: "cursors-2",
        name: "Receive cursor",
        description: "Remote peer sets cursor; client receives it",
        async run({ server, client, doc }) {
            await client.connect(doc)
            await sleep(500)

            // Insert text
            await server.insert_at(doc, 0, "hello world")
            await wait_for(async () => (await client.state()) === "hello world",
                { timeout_ms: 5000, msg: "Client should receive text" })

            // Client opens cursor sharing
            await client.send("connect-cursors", { doc })
            await sleep(500)

            // Simulated remote peer subscribes then sets cursor at position 3
            var remote_peer = "test-remote-peer"
            await server.subscribe_cursors(doc, remote_peer)
            await sleep(300)
            await server.set_cursor(doc, remote_peer, [{from: 3, to: 3}])
            await sleep(1000)

            // Client should see the remote cursor
            var result = await client.send("get-cursors")
            var found = false
            var cursors = result.cursors || {}
            if (Array.isArray(cursors)) {
                for (var pair of cursors) {
                    var sels = pair[1] || pair
                    if (Array.isArray(sels)) {
                        for (var sel of sels) {
                            if (sel && sel.from === 3 && sel.to === 3) found = true
                        }
                    }
                }
            } else {
                for (var sels of Object.values(cursors)) {
                    if (Array.isArray(sels)) {
                        for (var sel of sels) {
                            if (sel && sel.from === 3 && sel.to === 3) found = true
                        }
                    }
                }
            }
            assert_truthy(found, "Client should see remote cursor at position 3")
        }
    },

    {
        id: "cursors-3",
        name: "Cursor transforms through text edits",
        description: "Remote cursor at position 5; client inserts before it; cursor shifts",
        async run({ server, client, doc }) {
            await client.connect(doc)
            await sleep(500)

            // Insert initial text: "abcdefghij"
            await client.insert(0, "abcdefghij")
            try { await client.wait_ack() } catch (e) {}
            await sleep(500)

            // Open cursors
            await client.send("connect-cursors", { doc })
            await sleep(500)

            // Remote peer subscribes then sets cursor at position 5 (between 'e' and 'f')
            var remote_peer = "test-xf-peer"
            await server.subscribe_cursors(doc, remote_peer)
            await sleep(300)
            await server.set_cursor(doc, remote_peer, [{from: 5, to: 5}])
            await sleep(500)

            // Verify initial cursor position
            var snapshot = await server.get_cursors(doc)
            assert_equal(snapshot[remote_peer]?.[0]?.from, 5,
                "Remote cursor should start at position 5")

            // Client inserts "XX" at position 2 (before the cursor)
            // "abcdefghij" → "abXXcdefghij"
            // Cursor should shift from 5 → 7
            await client.insert(2, "XX")
            try { await client.wait_ack() } catch (e) {}
            await sleep(1000)

            // Check that cursor transformed
            snapshot = await server.get_cursors(doc)
            assert_equal(snapshot[remote_peer]?.[0]?.from, 7,
                "Remote cursor should shift from 5 to 7 after insert at pos 2")
        }
    },

    {
        id: "cursors-4",
        name: "Cursor survives reconnect",
        description: "Client has cursor; connection drops; after reconnect, client can still set/receive cursors",
        async run({ server, proxy, client, doc }) {
            await client.connect(doc)
            await sleep(500)

            await server.insert_at(doc, 0, "hello world")
            await wait_for(async () => (await client.state()) === "hello world",
                { timeout_ms: 5000, msg: "Client should receive text" })

            // Open cursors and set initial position
            await client.send("connect-cursors", { doc })
            await sleep(500)
            await client.send("set-cursor", { pos: 3 })
            await sleep(500)

            // Kill connection
            proxy.disconnect_all()
            await sleep(1000)

            // Restore connection
            proxy.set_mode("passthrough")
            await sleep(2000)

            // Set cursor at new position after reconnect
            await client.send("set-cursor", { pos: 8 })
            await sleep(1000)

            // Server should have the updated cursor
            var snapshot = await server.get_cursors(doc)
            var found = false
            for (var [peer_id, sels] of Object.entries(snapshot)) {
                if (Array.isArray(sels) && sels.length > 0) {
                    if (sels[0].from === 8 && sels[0].to === 8) found = true
                }
            }
            assert_truthy(found, "Server should have client cursor at position 8 after reconnect")
        }
    },

    {
        id: "cursors-5",
        name: "Send selection",
        description: "Client sets a selection range (from > to for backward); server receives it faithfully",
        async run({ server, client, doc }) {
            await client.connect(doc)
            await sleep(500)

            await client.insert(0, "abcdefghij")
            try { await client.wait_ack() } catch (e) {}
            await sleep(500)

            await client.send("connect-cursors", { doc })
            await sleep(500)

            // Set a backward selection from edge 7 to edge 2
            // This selects "cdefg" (5 chars between edges 2 and 7)
            // from > to indicates backward direction
            await client.send("set-cursor", { pos: 7, end: 2 })
            await sleep(1000)

            var snapshot = await server.get_cursors(doc)
            var sel = null
            for (var [peer_id, sels] of Object.entries(snapshot)) {
                if (Array.isArray(sels) && sels.length > 0) sel = sels[0]
            }
            assert_truthy(sel, "Server should have client selection")
            assert_equal(sel.from, 7,
                `Selection from should be 7, got ${sel.from}`)
            assert_equal(sel.to, 2,
                `Selection to should be 2, got ${sel.to}`)
        }
    },

]
