#!/usr/bin/env node

// Hello world braid-fuzz client
//
// Shows the basic structure: read JSON commands from stdin,
// write JSON responses to stdout.
//
// Run:  node braid-fuzz.js serve "node ./examples/hello-world.js"

require("readline").createInterface({ input: process.stdin }).on("line", line => {
    var msg = JSON.parse(line)

    // Every command gets a response with the same id
    var response = { id: msg.id, ok: true }

    // Handle specific commands
    if (msg.cmd === "state") response.state = "hello world"

    process.stdout.write(JSON.stringify(response) + "\n")
})
