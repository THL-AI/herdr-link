/**
 * The bridge: `herdr-link [run] [config.toml]`. Starts the adapters, connects to
 * herdr-core, listens for agent hooks and runs the bridge core.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer, Schedule, type Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { readFileSync } from "node:fs"
import * as Bridge from "./bridge/Bridge.ts"
import * as Hooks from "./bridge/Hooks.ts"
import * as LocalState from "./bridge/LocalState.ts"
import * as Adapters from "./chat/Adapters.ts"
import { Chat } from "./chat/Chat.ts"
import * as HookInstall from "./cli/hooks.ts"
import { BridgeConfig, defaultPath } from "./Config.ts"
import * as HerdrApp from "./core/HerdrApp.ts"
import * as HerdrCore from "./core/HerdrCore.ts"

const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version

/**
 * Keeps `status.json` current for the herdr-app mod and `herdr-link status`:
 * checked every 5 s, written on a change and at least every 30 s, and marked
 * stopped when the bridge exits.
 */
const reportStatus = (configPath: string) => Effect.gen(function*() {
  const config = yield* BridgeConfig
  const chat = yield* Chat
  const started = new Date().toISOString()
  let last: LocalState.Status | undefined
  let lastKey = ""
  let lastWrite = 0
  const write = (status: LocalState.Status) =>
    Effect.sync(() => LocalState.writeStatus(status)).pipe(
      Effect.catchDefect((error) => Effect.logWarning(`cannot write status.json: ${String(error)}`))
    )
  const check = Effect.gen(function*() {
    const states = yield* chat.states
    const hooks = yield* Effect.sync(() => HookInstall.status()).pipe(Effect.orElseSucceed(() => ({})))
    const adapters = Object.entries(config.adapters).map(([name, section]): LocalState.AdapterStatus => {
      const state = states.find((s) => s.name === name)
      return {
        name,
        enabled: section.enabled !== false,
        dashboard: section.dashboard !== false,
        connected: state?.connected ?? false,
        ...(state?.error === undefined ? {} : { error: state.error })
      }
    })
    const body = { running: true, pid: process.pid, version, config: configPath, started, desk: LocalState.atDesk(), adapters, hooks }
    const key = JSON.stringify(body)
    if (key === lastKey && Date.now() - lastWrite < 30_000) return
    last = { ...body, updated: new Date().toISOString() }
    lastKey = key
    lastWrite = Date.now()
    yield* write(last)
  })
  yield* Effect.addFinalizer(() =>
    last === undefined ? Effect.void : write({ ...last, running: false, updated: new Date().toISOString() })
  )
  yield* check.pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped)
})

const run = (hooks: Stream.Stream<Hooks.HookMessage>, configPath: string) => Effect.gen(function*() {
  const config = yield* BridgeConfig
  yield* reportStatus(configPath)
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const withSpawner = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
  yield* Bridge.run({
    chat: yield* Chat,
    core: yield* HerdrCore.HerdrCore,
    hooks,
    agents: config.agents ?? {},
    ...(config.machine === undefined ? {} : { machine: config.machine }),
    dashboardEvery: "10 seconds",
    withoutDashboard: Object.entries(config.adapters).filter(([, section]) => section.dashboard === false).map(([name]) => name),
    progressEvery: "15 seconds",
    atDesk: () => LocalState.atDesk(),
    app: {
      closeTab: (id) => HerdrApp.closeTab(id).pipe(withSpawner),
      newTab: (tab) => HerdrApp.newTab(tab).pipe(withSpawner),
      newSpace: (space) => HerdrApp.newSpace(space).pipe(withSpawner)
    }
  })
})

const main = (configPath: string | undefined) => Effect.gen(function*() {
  const path = configPath ?? (yield* defaultPath)
  yield* Effect.logInfo(`config: ${path}`)
  // First, so a second bridge stops before it starts adapters.
  const hooks = yield* Hooks.listen(Hooks.defaultSocket())
  return yield* run(hooks, path).pipe(
    Effect.provide(Layer.mergeAll(
      Adapters.layer.pipe(Layer.provideMerge(BridgeConfig.layerFile(path))),
      HerdrCore.layer()
    ))
  )
}).pipe(
  Effect.scoped,
  Effect.catchTag(["ConfigError", "HookServerError"], (error) =>
    Effect.logError(`${error.path}: ${error.message}`).pipe(
      Effect.andThen(Effect.sync(() => (process.exitCode = 1)))
    )),
  Effect.provide(NodeServices.layer)
)

/** Runs the bridge until interrupted (Ctrl-C, SIGTERM). */
export const start = (configPath?: string) => NodeRuntime.runMain(main(configPath))
