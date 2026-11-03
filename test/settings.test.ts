import { assert, describe, it } from "@effect/vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as LocalState from "../src/bridge/LocalState.ts"
import { setAdapterKey } from "../src/cli/settings.ts"

const config = `# mine
[adapters.discord]
command = ["herdr-link-discord"]
owner = "1"   # me

[adapters.telegram]
command = ["herdr-link-telegram"]
enabled = false   # later

[agents.claude]
template = "claude"
emoji = "✳️"
`

describe("settings", () => {
  it("sets one key in an adapter's section and keeps the rest of the file", () => {
    const on = setAdapterKey(config, "telegram", "enabled", true)
    assert.strictEqual(on, config.replace("enabled = false   # later", "enabled = true"))
    const noDashboard = setAdapterKey(config, "discord", "dashboard", false)
    assert.strictEqual(noDashboard, config.replace("[adapters.discord]\n", "[adapters.discord]\ndashboard = false\n"))
    assert.throws(() => setAdapterKey(config, "slack", "enabled", true), /no \[adapters.slack\] section/)
  })

  it("keeps the desk switch and the status in the state folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-state-"))
    assert.isFalse(LocalState.atDesk(dir))
    LocalState.setDesk(true, dir)
    assert.isTrue(LocalState.atDesk(dir))
    LocalState.setDesk(false, dir)
    assert.isFalse(LocalState.atDesk(dir))

    assert.isUndefined(LocalState.readStatus(dir))
    const now = Date.parse("2026-11-03T10:00:00Z")
    const status: LocalState.Status = {
      running: true,
      pid: 1,
      version: "0.5.0",
      config: "/c.toml",
      started: "2026-11-03T09:00:00Z",
      updated: "2026-11-03T09:59:30Z",
      desk: false,
      adapters: [{ name: "discord", enabled: true, dashboard: true, connected: true }],
      hooks: { claude: "ok" }
    }
    LocalState.writeStatus(status, dir)
    assert.deepStrictEqual(LocalState.readStatus(dir), status)
    assert.isTrue(LocalState.isAlive(status, now))
    assert.isFalse(LocalState.isAlive({ ...status, updated: "2026-11-03T09:58:00Z" }, now)) // stopped writing
    assert.isFalse(LocalState.isAlive({ ...status, running: false }, now))
  })
})
