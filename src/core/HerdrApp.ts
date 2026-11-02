/**
 * The herdr-app CLI, for what lives in the app rather than the core (spaces
 * and tabs). Needs the app window running; fails otherwise.
 */
import { Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** `herdr-app do <command> <json>`: exit 0 on success, `{"error": ...}` and exit 1 otherwise. */
export const run = Effect.fnUntraced(function*(command: string, args: Record<string, unknown>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(ChildProcess.make("herdr-app", ["do", command, JSON.stringify(args)]))
  const output = yield* handle.all.pipe(Stream.decodeText(), Stream.mkString)
  const code = yield* handle.exitCode
  if (code !== ChildProcessSpawner.ExitCode(0)) {
    return yield* Effect.fail(new Error(`herdr-app ${command}: ${output.trim() || `exit ${code}`}`))
  }
  return output
}, Effect.scoped)

export const closeTab = (id: string) => run("tab.close", { id, confirmed: true }).pipe(Effect.asVoid)

const Created = Schema.Struct({ space: Schema.String, tab: Schema.optionalKey(Schema.String), terminal: Schema.optionalKey(Schema.String) })

/** A tab in `space` running `argv` (wrapped by the app in the owner's login shell). */
export const newTab = (options: {
  readonly space: string
  readonly name: string
  readonly folder: string
  readonly argv: ReadonlyArray<string>
  readonly task?: string
}) =>
  run("tab.new", options).pipe(
    Effect.flatMap((output) => Schema.decodeUnknownEffect(Schema.fromJsonString(Created))(output.trim())),
    Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error))))
  )

export const newSpace = (options: {
  readonly name: string
  readonly folder: string
  readonly tab?: string
  readonly argv?: ReadonlyArray<string>
  readonly task?: string
}) => run("space.new", options).pipe(Effect.asVoid)

/** What the bridge core needs from the app. */
export interface HerdrApp {
  readonly closeTab: (id: string) => Effect.Effect<void, Error>
  readonly newTab: (options: Parameters<typeof newTab>[0]) => Effect.Effect<typeof Created.Type, Error>
  readonly newSpace: (options: Parameters<typeof newSpace>[0]) => Effect.Effect<void, Error>
}
