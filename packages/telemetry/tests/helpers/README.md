# tests/helpers/

Shared helpers used by `*.test.js` files. None of these are user-facing.

| File | Purpose |
|---|---|
| `test-harness.js` | Tiny `test()` runner + `summary()` exit + `assertEvent()` for waiting on EventEmitters |
| `tmp.js` | `makeTmp()`, `cleanupTmp()`, `withTmp()`, `makeFakeHome()` — all tests touching the filesystem must use these |
| `ports.js` | `findFreePort()` — never hardcode :7890 in tests |
| `server.js` | `startTestServer({ tmpHome })` — spawns a real server in a child process with isolated HOME |
| `ws-client.js` | `openTestWs(wsUrl)` — records frames, `waitFor(predicate)` to await a specific message |

**Isolation rule:** every test that needs a server, file, or port must use these helpers. Never read or write `~/.claude/`, never bind to `:7890`. Tests that violate this will pollute the developer's live environment.
