// Test assertion and utility helpers

function assert_equal(actual, expected, msg) {
    if (actual !== expected) {
        var err = new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
        err.actual = actual
        err.expected = expected
        throw err
    }
}

function assert_truthy(val, msg) {
    if (!val) throw new Error(msg || `Expected truthy value, got ${JSON.stringify(val)}`)
}

function assert_includes(str, substr, msg) {
    if (typeof str !== "string" || !str.includes(substr)) {
        throw new Error(msg || `Expected ${JSON.stringify(str)} to include ${JSON.stringify(substr)}`)
    }
}

// Wait for a condition to become true, polling every interval_ms.
// Rejects after timeout_ms with the given message.
function wait_for(condition_fn, { timeout_ms = 10000, interval_ms = 100, msg = "Timed out waiting for condition" } = {}) {
    return new Promise((resolve, reject) => {
        var start = Date.now()
        var check = async () => {
            try {
                var result = await condition_fn()
                if (result) return resolve(result)
            } catch (e) {
                // condition threw, keep waiting
            }
            if (Date.now() - start > timeout_ms) {
                return reject(new Error(`${msg} (after ${timeout_ms}ms)`))
            }
            setTimeout(check, interval_ms)
        }
        check()
    })
}

// Wait for two states to converge (become equal)
async function wait_for_convergence(get_state_a, get_state_b, opts = {}) {
    var { timeout_ms = 15000, interval_ms = 200, label = "states" } = opts
    return wait_for(async () => {
        var a = await get_state_a()
        var b = await get_state_b()
        return a === b ? a : false
    }, { timeout_ms, interval_ms, msg: `${label} did not converge` })
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// Generate a short random string
function random_id(len = 6) {
    return Math.random().toString(36).slice(2, 2 + len)
}

module.exports = { assert_equal, assert_truthy, assert_includes, wait_for, wait_for_convergence, sleep, random_id }
