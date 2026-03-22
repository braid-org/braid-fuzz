// Test Suite: Basics
//
// Smoke tests — can the client connect and respond to commands?

module.exports = [

    {
        id: "basics-1",
        name: "Hello",
        description: "Client receives a hello command and responds",
        async run({ client }) {
            await client.send("hello")
        }
    },

]
