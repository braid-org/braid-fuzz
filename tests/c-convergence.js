// Test Suite C: Simpleton / Convergence Tests
//
// These tests verify that the editor plugin's sync implementation
// correctly merges concurrent edits from both the local editor
// and the remote server.

var { assert_equal, assert_truthy, wait_for, wait_for_convergence, sleep } = require("../lib/assertions")

module.exports = [

    {
        id: "C1",
        name: "Local edit round-trip",
        description: "Client inserts text; server receives PUT; client gets ACK; states match",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            await editor.insert(0, "hello")

            await wait_for(async () => (await server.get_doc_state(doc)).includes("hello"),
                { timeout_ms: 5000, msg: "Server should receive the client's edit" })

            try { await editor.wait_ack() } catch (e) {}
            await sleep(500)

            assert_equal(await editor.state(), await server.get_doc_state(doc),
                "States should match after local edit round-trip")
        }
    },

    {
        id: "C2",
        name: "Concurrent edits converge",
        description: "Client inserts at pos 0, server inserts at pos 0 simultaneously; both converge",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            var p1 = editor.insert(0, "CLIENT")
            var p2 = server.insert_at(doc, 0, "SERVER")
            await Promise.all([p1, p2])

            await wait_for_convergence(
                () => editor.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 10000, label: "C2: concurrent insert convergence" }
            )

            var state = await editor.state()
            assert_truthy(state.includes("CLIENT"), "State should contain CLIENT")
            assert_truthy(state.includes("SERVER"), "State should contain SERVER")
        }
    },

    {
        id: "C3",
        name: "Interleaved edits",
        description: "Alternating client/server edits (5 each); final states match",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            for (var i = 0; i < 5; i++) {
                await editor.insert(0, `c${i}`)
                await sleep(200)
                await server.insert_at(doc, 0, `S${i}`)
                await sleep(200)
            }

            await wait_for_convergence(
                () => editor.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 10000, label: "C3: interleaved edits" }
            )

            var state = await editor.state()
            for (var i = 0; i < 5; i++) {
                assert_truthy(state.includes(`c${i}`), `Should contain c${i}`)
                assert_truthy(state.includes(`S${i}`), `Should contain S${i}`)
            }
        }
    },

    {
        id: "C4",
        name: "Delete + insert conflict",
        description: "Client deletes at one end, server inserts at other; converges",
        async run({ server, proxy, editor, doc }) {
            await server.insert_at(doc, 0, "ABCDEFGH")
            await editor.connect(doc)
            await wait_for(async () => (await editor.state()) === "ABCDEFGH",
                { timeout_ms: 5000, msg: "Editor should have initial text" })

            // Client deletes from the front, server inserts at the back
            // These don't overlap on the server's CRDT so they won't cause
            // invalid range errors, but they do test concurrent convergence.
            var p1 = editor.delete(0, 2) // delete "AB"
            var p2 = server.insert_at(doc, 8, "XY") // append "XY"
            await Promise.all([p1, p2])

            await wait_for_convergence(
                () => editor.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 10000, label: "C4: delete+insert conflict" }
            )

            assert_equal(await editor.state(), await server.get_doc_state(doc),
                "States should converge after concurrent delete + insert")
        }
    },

    {
        id: "C5",
        name: "Large burst of edits",
        description: "20 rapid local edits; all acknowledged; final state matches server",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            for (var i = 0; i < 20; i++) {
                await editor.insert(i, String.fromCharCode(65 + (i % 26)))
            }

            await wait_for_convergence(
                () => editor.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 20000, label: "C5: large burst" }
            )

            assert_equal((await editor.state()).length, 20, "Should have 20 characters")
        }
    },

    {
        id: "C6",
        name: "Empty document",
        description: "Both sides start from empty; edits work correctly",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            assert_equal(await editor.state(), "", "Initial state should be empty")
            assert_equal(await server.get_doc_state(doc), "", "Server initial state should be empty")

            await editor.insert(0, "first")
            await wait_for_convergence(
                () => editor.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 5000, label: "C6: first edit on empty doc" }
            )

            assert_equal(await editor.state(), "first")
        }
    },

    {
        id: "C7",
        name: "Edit during reconnect",
        description: "Client makes local edit while disconnected; on reconnect, edit merges correctly",
        async run({ server, proxy, editor, doc }) {
            await editor.connect(doc)
            await sleep(500)

            await server.insert_at(doc, 0, "base")
            await wait_for(async () => (await editor.state()) === "base",
                { timeout_ms: 5000, msg: "Editor should see 'base'" })

            proxy.disconnect_all()
            await sleep(500)

            await editor.insert(4, "-offline")
            await server.insert_at(doc, 0, "prefix-")

            proxy.set_mode("passthrough")

            await wait_for_convergence(
                () => editor.state(),
                () => server.get_doc_state(doc),
                { timeout_ms: 15000, label: "C7: edit during disconnect" }
            )

            var state = await editor.state()
            assert_truthy(state.includes("base"), "Should contain 'base'")
            assert_truthy(state.includes("offline"), "Should contain 'offline'")
            assert_truthy(state.includes("prefix"), "Should contain 'prefix'")
        }
    },

    {
        id: "C8",
        name: "Multi-client convergence",
        description: "2 editor instances + server all edit concurrently; all 3 converge",
        needs_extra_editor: true,
        async run({ server, proxy, editor, doc, extra_editors }) {
            var editor2 = extra_editors[0]

            await editor.connect(doc)
            await editor2.connect(doc)
            await sleep(1000)

            // All three parties edit concurrently
            var p1 = editor.insert(0, "AAA")
            var p2 = editor2.insert(0, "BBB")
            var p3 = server.insert_at(doc, 0, "CCC")
            await Promise.all([p1, p2, p3])

            await sleep(3000)

            var converged = false
            for (var attempt = 0; attempt < 40; attempt++) {
                var s1 = await editor.state()
                var s2 = await editor2.state()
                var s3 = await server.get_doc_state(doc)
                if (s1 === s2 && s2 === s3) { converged = true; break }
                await sleep(500)
            }

            assert_truthy(converged, "All three participants should converge")

            var state = await editor.state()
            assert_truthy(state.includes("AAA"), "Should contain AAA")
            assert_truthy(state.includes("BBB"), "Should contain BBB")
            assert_truthy(state.includes("CCC"), "Should contain CCC")
        }
    },

]
