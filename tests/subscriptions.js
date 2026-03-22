// Test Suite: Subscriptions
//
// Tests for braid subscription parsing — the core protocol layer.
// These test the client's braid_fetch / subscription parser directly,
// independent of any merge protocol like simpleton.
//
// Uses the "subscribe" command to tell the client to open a braid_fetch
// subscription. The client pushes each received update back to the
// harness as it arrives, collected in client.updates[].
//
// (See specs.md sections 2, 3, 5, 6)

var { assert_equal, assert_truthy, wait_for } = require("../lib/assertions")

module.exports = [

    {
        id: "subscriptions-1",
        name: "Receive snapshot body",
        description: "Client subscribes to a resource; server sends initial state as a full body (Content-Length, no Patches header); client receives it",
        async run({ server, proxy, client, doc, base_url }) {
            await server.insert_at(doc, 0, "hello world")

            await client.send("subscribe", {
                url: base_url + doc,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => client.updates.length >= 1,
                { timeout_ms: 5000, msg: "Client should receive initial snapshot" })

            var first = client.updates[0]
            assert_truthy(first.body != null,
                "First update should be a full body snapshot")
            assert_equal(first.body, "hello world",
                "Snapshot body should match server state")
        }
    },

    {
        id: "subscriptions-2",
        name: "Receive incremental patch",
        description: "After the initial snapshot, server edits the document; client receives an incremental patch with Content-Range",
        async run({ server, proxy, client, doc, base_url }) {
            await server.insert_at(doc, 0, "hello")

            await client.send("subscribe", {
                url: base_url + doc,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => client.updates.length >= 1,
                { timeout_ms: 5000, msg: "Client should receive initial snapshot" })

            await server.insert_at(doc, 5, " world")

            await wait_for(() => client.updates.length >= 2,
                { timeout_ms: 5000, msg: "Client should receive incremental patch" })

            var patch = client.updates[1]
            assert_truthy(patch.patches && patch.patches.length === 1,
                "Second update should have exactly 1 patch")
            assert_truthy(patch.version && patch.version.length > 0,
                "Patch should have a Version")
            assert_truthy(patch.parents && patch.parents.length > 0,
                "Patch should have Parents")
            assert_equal(patch.patches[0].content, " world",
                "Patch content should be the inserted text")
        }
    },

    {
        id: "subscriptions-3",
        name: "Receive multi-patch update (Patches: N)",
        description: "Server sends two patches in a single update (Patches: 2); client parses both patches",
        async run({ server, proxy, client, doc, base_url }) {
            await server.insert_at(doc, 0, "ABCDEF")

            await client.send("subscribe", {
                url: base_url + doc,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => client.updates.length >= 1,
                { timeout_ms: 5000, msg: "Client should receive initial snapshot" })

            await server.edit_doc(doc, [
                { unit: "text", range: "[0:0]", content: "XXX" },
                { unit: "text", range: "[6:6]", content: "YYY" },
            ])

            await wait_for(() => client.updates.length >= 2,
                { timeout_ms: 5000, msg: "Client should receive multi-patch update" })

            var multi = client.updates[client.updates.length - 1]
            assert_equal(multi.patches.length, 2,
                "Update should contain exactly 2 patches")
            assert_equal(multi.patches[0].content, "XXX",
                "First patch content should be XXX")
            assert_equal(multi.patches[1].content, "YYY",
                "Second patch content should be YYY")
        }
    },

]
