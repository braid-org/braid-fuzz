// Test Suite: Subscriptions
//
// Tests for braid subscription parsing — the core protocol layer.
// These test the client's braid_fetch / subscription parser directly,
// independent of any merge protocol like simpleton.
//
// Uses the "braid_fetch" command with subscribe: true to test the
// client's braid_fetch directly. The client pushes each received
// update back to the harness as it arrives, collected in client.updates[].
//
// (See specs.md sections 2, 3, 5, 6)

var { assert_equal, assert_truthy, wait_for, sleep } = require("../lib/assertions")

module.exports = [

    {
        id: "subscriptions-1",
        name: "Receive snapshot body",
        description: "Client subscribes to a resource; server sends initial state as a full body (Content-Length, no Patches header); client receives it",
        async run({ server, proxy, client, doc, base_url }) {
            await server.insert_at(doc, 0, "hello world")

            await client.send("braid_fetch", {
                url: base_url + doc,
                subscribe: true,
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

            await client.send("braid_fetch", {
                url: base_url + doc,
                subscribe: true,
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

            await client.send("braid_fetch", {
                url: base_url + doc,
                subscribe: true,
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

    {
        id: "subscriptions-4",
        name: "Receive Patches: 0 update",
        description: "Server sends an update with Patches: 0 (no content changes); client receives it with a version but no patches",
        async run({ server, proxy, client, doc, base_url }) {
            await server.insert_at(doc, 0, "hello")

            await client.send("braid_fetch", {
                url: base_url + doc,
                subscribe: true,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => client.updates.length >= 1,
                { timeout_ms: 5000, msg: "Client should receive initial snapshot" })

            // Get the current version from the last update the client received
            var last_version = client.updates[client.updates.length - 1].version

            // Send a raw Patches: 0 update directly on the subscription stream
            var version = '"patches0-test-' + Date.now() + '"'
            var parents = last_version ? last_version.map(v => '"' + v + '"').join(", ") : ""
            server.send_raw_update(doc,
                `Version: ${version}\r\n` +
                `Parents: ${parents}\r\n` +
                `Patches: 0\r\n` +
                `\r\n`
            )

            await wait_for(() => client.updates.length >= 2,
                { timeout_ms: 5000, msg: "Client should receive Patches: 0 update" })

            var update = client.updates[client.updates.length - 1]
            assert_truthy(update.version && update.version.length > 0,
                "Patches: 0 update should have a version")
            assert_equal(update.patches.length, 0,
                "Patches: 0 update should have an empty patches array")
        }
    },

    {
        id: "subscriptions-5",
        name: "Unsubscribe",
        description: "Client opens a subscription, then closes it with unsubscribe; no reconnect after",
        async run({ server, proxy, client, doc, base_url }) {
            var connections = 0
            server._on_subscribe = (req, res, url) => {
                if (url === doc) connections++
            }

            await client.send("braid_fetch", {
                url: base_url + doc,
                subscribe: true,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => connections >= 1,
                { timeout_ms: 5000, msg: "Client should connect" })

            await client.send("unsubscribe")

            var connections_after = connections
            await sleep(3000)

            assert_truthy(connections === connections_after,
                "Client should not reconnect after unsubscribe")

            server._on_subscribe = null
        }
    },

    {
        id: "subscriptions-6",
        name: "Subscribe with Parents header",
        description: "Client subscribes with a Parents header; server sends only updates since that version (patches, not a full snapshot)",
        async run({ server, proxy, client, doc, base_url }) {
            // Subscribe first, then make two edits so we see distinct versions
            await client.send("braid_fetch", {
                url: base_url + doc,
                subscribe: true,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => client.updates.length >= 1,
                { timeout_ms: 5000, msg: "Probe should receive initial snapshot" })

            await server.insert_at(doc, 0, "hello")
            await wait_for(() => client.updates.length >= 2,
                { timeout_ms: 5000, msg: "Probe should receive first edit" })

            // Grab the version after "hello" — we'll resume from here
            var mid_version = client.updates[1].version
            assert_truthy(mid_version && mid_version.length > 0,
                "Edit update should have a version")

            await server.insert_at(doc, 5, " world")
            await wait_for(() => client.updates.length >= 3,
                { timeout_ms: 5000, msg: "Probe should receive second edit" })

            // Clean up probe
            await client.send("unsubscribe")
            client.updates.length = 0

            // Now subscribe with Parents set to mid_version
            var parents_value = mid_version.map(v => '"' + v + '"').join(", ")
            await client.send("braid_fetch", {
                url: base_url + doc,
                subscribe: true,
                headers: { "Merge-Type": "simpleton", "Parents": parents_value }
            })

            await wait_for(() => client.updates.length >= 1,
                { timeout_ms: 5000, msg: "Client should receive update since Parents" })

            // Should get a patch (the " world" edit), not a full body snapshot
            var update = client.updates[0]
            assert_truthy(update.patches && update.patches.length > 0,
                "First update after Parents should be a patch, not a full body")
        }
    },

    {
        id: "subscriptions-7",
        name: "Receive multiple updates in one stream",
        description: "Server makes several edits while subscribed; client receives all of them as separate updates in order",
        async run({ server, proxy, client, doc, base_url }) {
            await client.send("braid_fetch", {
                url: base_url + doc,
                subscribe: true,
                headers: { "Merge-Type": "simpleton" }
            })

            await wait_for(() => client.updates.length >= 1,
                { timeout_ms: 5000, msg: "Client should receive initial snapshot" })

            // Fire 5 edits
            for (var i = 0; i < 5; i++) {
                await server.insert_at(doc, i, String(i))
            }

            await wait_for(() => client.updates.length >= 6,
                { timeout_ms: 10000, msg: "Client should receive all 5 patches plus initial" })

            // Verify ordering: each update's parents should match the previous version
            for (var i = 2; i < client.updates.length; i++) {
                assert_equal(
                    JSON.stringify(client.updates[i].parents),
                    JSON.stringify(client.updates[i - 1].version),
                    `Update ${i} parents should match update ${i - 1} version`
                )
            }

            // Verify all patches arrived with content
            for (var i = 1; i < client.updates.length; i++) {
                assert_truthy(client.updates[i].patches && client.updates[i].patches.length > 0,
                    `Update ${i} should have patches`)
            }
        }
    },

]
