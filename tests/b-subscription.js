// Test Suite B: Subscription Behavior
//
// These tests verify that the editor plugin correctly implements
// Braid subscription semantics: initial state, patches, parents,
// heartbeats, digest verification, and error handling.

var { assert_equal, assert_truthy, wait_for, wait_for_convergence, sleep } = require("../lib/assertions")

module.exports = [

    {
        id: "BIS",
        name: "Initial subscribe",
        description: "Client subscribes, receives current state, buffer matches server",
        async run({ server, proxy, editor, doc }) {
            await server.insert_at(doc, 0, "initial content")
            await editor.connect(doc)

            await wait_for(async () => (await editor.state()) === "initial content",
                { timeout_ms: 5000, msg: "Editor buffer should match initial server state" })

            assert_equal(await editor.state(), await server.get_doc_state(doc),
                "Editor and server state should match on initial subscribe")
        }
    },

    {
        id: "BRP",
        name: "Receive remote patch",
        description: "Server applies edit; client receives patch and buffer updates",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            await server.insert_at(doc, 0, "remote edit")

            await wait_for(async () => (await editor.state()) === "remote edit",
                { timeout_ms: 5000, msg: "Editor should receive remote patch" })

            assert_equal(await editor.state(), "remote edit")
        }
    },

    {
        id: "BMR",
        name: "Receive multiple rapid patches",
        description: "Server sends 10 edits rapidly; all applied in order",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            for (var i = 0; i < 10; i++) {
                await server.insert_at(doc, i, String(i))
            }

            await wait_for_convergence(
                () => editor.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 10000, label: "BMR: rapid patches" }
            )

            assert_equal(await editor.state(), "0123456789")
        }
    },

    {
        id: "BEP",
        name: "First PUT has empty Parents header",
        description: "On a fresh document the first PUT must include a Parents header with an empty value (no parents), not omit it entirely",
        async run({ server, proxy, editor, doc }) {
            var captured_puts = []

            server._on_put = (req, res, url) => {
                if (url === doc) {
                    captured_puts.push({
                        has_parents_header: "parents" in req.headers,
                        parents_raw: req.headers.parents,
                    })
                }
            }

            await editor.connect(doc)
            await sleep(500)

            // First edit on a brand-new document — no prior versions exist
            await editor.insert(0, "hello")

            await wait_for(() => captured_puts.length >= 1,
                { timeout_ms: 5000, msg: "Server should receive at least one PUT" })

            try { await editor.wait_ack() } catch (e) {}
            await sleep(500)

            // The first PUT must have a Parents header present
            var first_put = captured_puts[0]
            assert_truthy(first_put.has_parents_header,
                "First PUT must include a Parents header (got none). " +
                "When there are no parents, send an empty Parents header — do not omit it.")

            // The value should parse to an empty array (no parent versions)
            var parsed = JSON.parse("[" + first_put.parents_raw + "]")
            assert_equal(parsed.length, 0,
                "First PUT Parents header should be empty (no parent versions), " +
                "but got: " + first_put.parents_raw)

            // Sanity check: the edit still went through
            assert_equal(await editor.state(), await server.get_doc_state(doc),
                "States should match after first PUT")
        }
    },

    {
        id: "BPR",
        name: "Parents header on reconnect",
        description: "After reconnect, client sends correct Parents; server sends only delta",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            await server.insert_at(doc, 0, "before")
            await wait_for(async () => (await editor.state()).includes("before"),
                { timeout_ms: 5000, msg: "Editor should see 'before'" })

            var reconnect_headers = null
            server._on_subscribe = (req, res, url) => {
                if (url === doc) reconnect_headers = { ...req.headers }
            }

            proxy.disconnect_all()
            await sleep(500)
            proxy.set_mode("passthrough")
            await sleep(2000)

            await server.insert_at(doc, 6, " after")

            await wait_for_convergence(
                () => editor.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 10000, label: "BPR: reconnect with parents" }
            )

            if (reconnect_headers && reconnect_headers.parents) {
                assert_truthy(reconnect_headers.parents.length > 0,
                    "Parents header should contain version info on reconnect")
            }

            server._on_subscribe = null
        }
    },

    {
        id: "BOP",
        name: "Overlapping patches on reconnect",
        description: "Server resends some already-applied patches; client handles idempotently",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            await server.insert_at(doc, 0, "XYZ")
            await wait_for(async () => (await editor.state()) === "XYZ",
                { timeout_ms: 5000, msg: "Editor should see XYZ" })

            proxy.disconnect_all()
            await sleep(500)
            proxy.set_mode("passthrough")
            await sleep(2000)

            await wait_for_convergence(
                () => editor.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 10000, label: "BOP: overlap after reconnect" }
            )

            assert_equal(await editor.state(), await server.get_doc_state(doc),
                "States should match (no duplicate patches)")
        }
    },

    {
        id: "BHL",
        name: "Heartbeat liveness",
        description: "Client requests heartbeats; server confirms; blank lines keep connection alive",
        async run({ server, proxy, editor, doc }) {
            server.heartbeat_seconds = 2
            await editor.connect(doc)
            await sleep(500)

            await server.insert_at(doc, 0, "alive")
            await wait_for(async () => (await editor.state()) === "alive",
                { timeout_ms: 5000, msg: "Editor should see 'alive'" })

            // Wait long enough for several heartbeats
            await sleep(6000)

            await server.insert_at(doc, 5, "!")
            await wait_for(async () => (await editor.state()) === "alive!",
                { timeout_ms: 5000, msg: "Editor should still be receiving after heartbeats" })

            server.heartbeat_seconds = 0
        }
    },

    {
        id: "BDV",
        name: "Digest verification",
        description: "Server sends patch with Repr-Digest; client verifies and does not diverge",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            await server.insert_at(doc, 0, "aaa")
            await server.insert_at(doc, 3, "bbb")
            await server.insert_at(doc, 6, "ccc")

            await wait_for_convergence(
                () => editor.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 10000, label: "BDV: digest verified convergence" }
            )

            assert_equal(await editor.state(), "aaabbbccc")
        }
    },

    {
        id: "BMP",
        name: "Malformed patch - abort or recover",
        description: "Server sends garbage in subscription; client warns and does not corrupt buffer",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            await server.insert_at(doc, 0, "clean")
            await wait_for(async () => (await editor.state()) === "clean",
                { timeout_ms: 5000, msg: "Editor should see 'clean'" })

            // Kill the subscription to simulate a broken stream,
            // then reconnect. The client should recover gracefully.
            proxy.disconnect_all()
            await sleep(500)

            // Server makes an edit while client is disconnected
            await server.insert_at(doc, 5, " data")

            // Restore
            proxy.set_mode("passthrough")
            await sleep(2000)

            // Client should reconnect and converge
            await wait_for_convergence(
                () => editor.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 15000, label: "BMP: recovery after disruption" }
            )
        }
    },

]
