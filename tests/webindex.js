// Test Suite: Webindex
//
// Tests for the Braid webindex protocol.
//
// These tests don't probe the wire format — they ask the *client* to
// integrate the protocol into a small task and check the result. The
// client is free to choose how (a single GET, a streaming subscription,
// recursive Range, polling, …); only the observable behavior matters.
//
// Controller commands used:
//   list-children   {url}              — respond {children: [...]}
//                                        (immediate-child names at url)
//   watch-children  {url}              — start watching; emit
//                                          child-added / child-removed
//                                          events as immediate children
//                                          appear/disappear
//   unwatch-children {url}             — stop watching url

var { assert_truthy, wait_for, sleep } = require("../lib/assertions")

// How long the client is allowed to take to react to a change.
var REACT_BUDGET_MS = 500

function sorted(arr) { return [...arr].sort() }

module.exports = [

    {
        id: "webindex-1",
        name: "list immediate children",
        description: "Client lists the immediate-child names at a sub-path",
        async run({ webindex, webindex_base_url, client }) {
            webindex.add("/a/b/x")
            webindex.add("/a/b/y")
            webindex.add("/a/b/z")
            // Sibling outside /a/b — must NOT appear in the result
            webindex.add("/a/other")

            var result = await client.send("list-children", {
                url: webindex_base_url + "/a/b",
            })

            assert_truthy(Array.isArray(result.children),
                `Expected children to be an array, got ${JSON.stringify(result.children)}`)

            var got = sorted(result.children)
            var want = ["x", "y", "z"]
            assert_truthy(JSON.stringify(got) === JSON.stringify(want),
                `Expected children ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
        }
    },

    {
        id: "webindex-2",
        name: "list children of empty path",
        description: "Listing a path that has no children yields []",
        async run({ webindex, webindex_base_url, client }) {
            // Populate something elsewhere so the index isn't entirely empty
            webindex.add("/elsewhere/leaf")

            var result = await client.send("list-children", {
                url: webindex_base_url + "/nothing-here",
            })

            assert_truthy(Array.isArray(result.children) && result.children.length === 0,
                `Expected [], got ${JSON.stringify(result.children)}`)
        }
    },

    {
        id: "webindex-3",
        name: "list dedups resource-and-collection",
        description: "When a path is both a resource and a collection, the client reports its name once",
        async run({ webindex, webindex_base_url, client }) {
            // /a is both a resource (it was added directly) and a
            // collection (it has /a/child). The protocol returns it as
            // two entries; the client should report a single child "a".
            webindex.add("/a")
            webindex.add("/a/child")

            var result = await client.send("list-children", {
                url: webindex_base_url + "/",
            })

            var got = sorted(result.children)
            assert_truthy(JSON.stringify(got) === JSON.stringify(["a"]),
                `Expected ["a"] (deduped), got ${JSON.stringify(got)}`)
        }
    },

    {
        id: "webindex-4",
        name: "watch fires on add",
        description: "Watcher reports the name of an added child within the react budget",
        async run({ webindex, webindex_base_url, client }) {
            var watch_url = webindex_base_url + "/b/c"

            // Pre-populate something so /b/c exists as a collection
            webindex.add("/b/c/seed")

            await client.send("watch-children", { url: watch_url })
            await sleep(200)  // give the watch time to settle

            var before = client.child_added.length
            webindex.add("/b/c/freshly-added")

            await wait_for(() =>
                client.child_added.slice(before).some(e => e.name === "freshly-added"),
                { timeout_ms: REACT_BUDGET_MS,
                  msg: `child-added for "freshly-added" should arrive within ${REACT_BUDGET_MS}ms` })

            await client.send("unwatch-children", { url: watch_url })
        }
    },

    {
        id: "webindex-5",
        name: "watch fires on remove",
        description: "Watcher reports the name of a removed child within the react budget",
        async run({ webindex, webindex_base_url, client }) {
            var watch_url = webindex_base_url + "/d"

            webindex.add("/d/keeper")
            webindex.add("/d/disappearing")

            await client.send("watch-children", { url: watch_url })
            await sleep(200)

            var before = client.child_removed.length
            webindex.remove("/d/disappearing")

            await wait_for(() =>
                client.child_removed.slice(before).some(e => e.name === "disappearing"),
                { timeout_ms: REACT_BUDGET_MS,
                  msg: `child-removed for "disappearing" should arrive within ${REACT_BUDGET_MS}ms` })

            await client.send("unwatch-children", { url: watch_url })
        }
    },

    {
        id: "webindex-6",
        name: "watch is scoped to its path",
        description: "A watch on /a does not fire when something is added under /b",
        async run({ webindex, webindex_base_url, client }) {
            webindex.add("/a/seed")

            await client.send("watch-children", { url: webindex_base_url + "/a" })
            await sleep(200)

            var before_added = client.child_added.length
            var before_removed = client.child_removed.length

            // Mutate a totally unrelated subtree
            webindex.add("/b/totally-unrelated")
            webindex.add("/c/also-unrelated/deeper")

            // Wait the full react budget — and a bit more — to be sure
            // no spurious event fires.
            await sleep(REACT_BUDGET_MS + 200)

            assert_truthy(client.child_added.length === before_added,
                `Expected no child-added events, got ${client.child_added.length - before_added}: ${JSON.stringify(client.child_added.slice(before_added))}`)
            assert_truthy(client.child_removed.length === before_removed,
                `Expected no child-removed events, got ${client.child_removed.length - before_removed}`)

            await client.send("unwatch-children", { url: webindex_base_url + "/a" })
        }
    },

    {
        id: "webindex-7",
        name: "unwatch stops further events",
        description: "After unwatch, the client emits no more child events for that url",
        async run({ webindex, webindex_base_url, client }) {
            var watch_url = webindex_base_url + "/e"
            webindex.add("/e/seed")

            await client.send("watch-children", { url: watch_url })
            await sleep(200)

            // First add — should be observed
            var before = client.child_added.length
            webindex.add("/e/first")
            await wait_for(() => client.child_added.slice(before).some(e => e.name === "first"),
                { timeout_ms: REACT_BUDGET_MS, msg: "first add should be reported" })

            // Unwatch, then mutate again
            await client.send("unwatch-children", { url: watch_url })
            await sleep(100)

            var after_unwatch = client.child_added.length
            webindex.add("/e/after-unwatch")
            await sleep(REACT_BUDGET_MS + 200)

            assert_truthy(client.child_added.length === after_unwatch,
                `Expected no events after unwatch, got ${client.child_added.length - after_unwatch}: ${JSON.stringify(client.child_added.slice(after_unwatch))}`)
        }
    },

    {
        id: "webindex-8",
        name: "watch reports each name in a burst of adds",
        description: "Several adds in quick succession all get reported individually",
        async run({ webindex, webindex_base_url, client }) {
            var watch_url = webindex_base_url + "/burst"
            webindex.add("/burst/seed")

            await client.send("watch-children", { url: watch_url })
            await sleep(200)

            var before = client.child_added.length
            var names = ["alpha", "bravo", "charlie", "delta"]
            for (var n of names) webindex.add("/burst/" + n)

            await wait_for(() => {
                var seen = new Set(client.child_added.slice(before).map(e => e.name))
                return names.every(n => seen.has(n))
            }, { timeout_ms: REACT_BUDGET_MS,
                 msg: `All of ${JSON.stringify(names)} should be reported within ${REACT_BUDGET_MS}ms` })

            await client.send("unwatch-children", { url: watch_url })
        }
    },

]
