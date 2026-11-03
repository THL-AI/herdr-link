/**
 * Runs one adapter process: spawns it from its config section, speaks the
 * Chat protocol over its stdin/stdout, forwards its stderr to the log and does
 * the `hello` handshake. The process lives as long as the surrounding scope;
 * closing the scope closes its stdin, then kills it if it does not exit.
 */
import { type Cause, Duration, Effect, Queue, Schema, type Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { fileURLToPath } from "node:url"
import { type AdapterSection, adapterConfig } from "../Config.ts"
import type { AdapterInfo, AgentInfo, Capabilities, CommandSpec } from "../protocol/Chat.ts"
import { ErrorCode } from "../protocol/JsonRpc.ts"
import { AdapterToBridge, BridgeToAdapter } from "../protocol/Methods.ts"
import * as Peer from "../protocol/Peer.ts"
import { type Transport, TransportError, lines } from "../protocol/Transport.ts"

export class AdapterFailed extends Schema.TaggedError<AdapterFailed>()("AdapterFailed", {
  adapter: Schema.String,
  message: Schema.String,
  /** Restarting will not help (bad config, wrong protocol version). */
  fatal: Schema.Boolean
}) {}

export interface Connection {
  readonly name: string
  readonly info: AdapterInfo
  readonly capabilities: Capabilities
  readonly peer: Peer.Peer<typeof BridgeToAdapter>
}

/** Variables every adapter gets; anything else must be listed in its `env`. */
const baseEnv = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "NODE_OPTIONS"]

const environment = (section: AdapterSection) => {
  const env: Record<string, string> = {}
  for (const key of [...baseEnv, ...(section.env ?? [])]) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

/** Adapters shipped in this repo, runnable by name without being on PATH. */
export const builtIn: Record<string, string> = {
  "herdr-link-discord": fileURLToPath(new URL("../../bin/herdr-link-discord.mjs", import.meta.url)),
  "herdr-link-telegram": fileURLToPath(new URL("../../bin/herdr-link-telegram.mjs", import.meta.url))
}

const resolveCommand = (command: AdapterSection["command"]): readonly [string, ...Array<string>] => {
  const script = builtIn[command[0]]
  return script === undefined ? command : [process.execPath, script, ...command.slice(1)]
}

const helloTimeout = Duration.seconds(30)
const exitGrace = Duration.seconds(3)

export const connect = Effect.fn("AdapterProcess.connect")(function*<R>(options: {
  readonly name: string
  readonly section: AdapterSection
  readonly commands: ReadonlyArray<CommandSpec>
  readonly agents: ReadonlyArray<AgentInfo>
  readonly handlers: (peer: Peer.Peer<typeof BridgeToAdapter>) => Peer.Handlers<typeof AdapterToBridge, R>
}): Effect.fn.Return<Connection, AdapterFailed, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | R> {
  const { name, section } = options
  const failed = (message: string, fatal = false) => new AdapterFailed({ adapter: name, message, fatal })

  const stdin = yield* Queue.unbounded<string, Cause.Done>()
  const [command, ...args] = resolveCommand(section.command)
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(
    ChildProcess.make(command, args, {
      env: environment(section),
      extendEnv: false,
      stdin: Stream.fromQueue(stdin).pipe(Stream.map((line) => `${line}\n`), Stream.encodeText),
      forceKillAfter: exitGrace
    })
  ).pipe(Effect.mapError((error) => failed(`cannot start ${section.command.join(" ")}: ${error.message}`)))

  // Runs before the spawner's own release: ask politely (EOF on stdin) first.
  yield* Effect.addFinalizer(() =>
    Queue.end(stdin).pipe(
      Effect.andThen(handle.exitCode.pipe(Effect.timeoutOption(exitGrace))),
      Effect.ignore
    )
  )

  yield* lines(handle.stderr).pipe(
    Stream.runForEach((line) => Effect.logInfo(line)),
    Effect.ignore,
    Effect.annotateLogs({ adapter: name, stream: "stderr" }),
    Effect.forkScoped
  )

  const transport: Transport = {
    incoming: lines(handle.stdout).pipe(
      Stream.mapError((error) => new TransportError({ message: error.message, cause: error }))
    ),
    send: (line) =>
      Queue.offer(stdin, line).pipe(
        Effect.flatMap((accepted) =>
          accepted ? Effect.void : Effect.fail(new TransportError({ message: "stdin closed" }))
        )
      )
  }

  const peer = yield* Peer.make({
    transport,
    outgoing: BridgeToAdapter,
    incoming: AdapterToBridge,
    handlers: options.handlers
  })

  const hello = yield* peer.request("hello", {
    protocol: 1,
    config: adapterConfig(section),
    commands: options.commands,
    agents: options.agents
  }).pipe(
    Effect.timeoutOrElse({
      duration: helloTimeout,
      orElse: () => Effect.fail(failed(`no answer to hello in ${Duration.format(helloTimeout)}`))
    }),
    Effect.mapError((error) => {
      if (error._tag === "AdapterFailed") return error
      if (error._tag === "PeerClosed") return failed(`exited during hello: ${error.message}`)
      const fatal = error.code === ErrorCode.InvalidConfig || error.code === ErrorCode.UnsupportedProtocol
      return failed(`hello failed: ${error.message}`, fatal)
    })
  )

  return { name, info: hello.adapter, capabilities: hello.capabilities, peer }
})
