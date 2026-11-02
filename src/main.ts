/**
 * Entry point: `herdr-link [config.toml]`. Starts the adapters, connects to
 * herdr-core, listens for agent hooks and runs the bridge core.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer, type Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import * as Bridge from "./bridge/Bridge.ts"
import * as Hooks from "./bridge/Hooks.ts"
import * as Adapters from "./chat/Adapters.ts"
import { Chat } from "./chat/Chat.ts"
import { BridgeConfig, defaultPath } from "./Config.ts"
import * as HerdrApp from "./core/HerdrApp.ts"
import * as HerdrCore from "./core/HerdrCore.ts"

const run = (hooks: Stream.Stream<Hooks.HookMessage>) => Effect.gen(function*() {
  const config = yield* BridgeConfig
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const withSpawner = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
  yield* Bridge.run({
    chat: yield* Chat,
    core: yield* HerdrCore.HerdrCore,
    hooks,
    agents: config.agents ?? {},
    dashboardEvery: "10 seconds",
    app: {
      closeTab: (id) => HerdrApp.closeTab(id).pipe(withSpawner),
      newTab: (tab) => HerdrApp.newTab(tab).pipe(withSpawner),
      newSpace: (space) => HerdrApp.newSpace(space).pipe(withSpawner)
    }
  })
})

const main = Effect.gen(function*() {
  const path = process.argv[2] ?? (yield* defaultPath)
  yield* Effect.logInfo(`config: ${path}`)
  // First, so a second bridge stops before it starts adapters.
  const hooks = yield* Hooks.listen(Hooks.defaultSocket())
  return yield* run(hooks).pipe(
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

NodeRuntime.runMain(main)
