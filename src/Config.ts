/**
 * The bridge config: a TOML file, decoded with Schema. Secrets stay in the
 * environment (`.env`); an adapter sees only the variables its section lists
 * in `env`.
 */
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import * as Toml from "effect/encoding/Toml"

const Argv = Schema.NonEmptyArray(Schema.NonEmptyString)

/** Keys the bridge reads itself; everything else goes to the adapter in `hello`. */
export const bridgeKeys = ["command", "env"] as const

export const AdapterSection = Schema.StructWithRest(
  Schema.Struct({
    command: Argv.annotate({ description: "argv of the adapter process." }),
    env: Schema.optionalKey(
      Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u))).annotate({
        description: "Names of environment variables passed to the adapter (e.g. its token)."
      })
    )
  }),
  [Schema.Record(Schema.String, Schema.Json)]
)
export type AdapterSection = typeof AdapterSection.Type

export const Agent = Schema.Struct({
  template: Schema.optionalKey(Schema.NonEmptyString),
  argv: Schema.optionalKey(Argv),
  emoji: Schema.NonEmptyString,
  logo: Schema.optionalKey(Schema.NonEmptyString),
  allow: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  deny: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  /** Keys for "yes, and don't ask again" (Claude Code: `2`). */
  always: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  /** Keys that answer "trust this folder?" with yes (Grok: `y`). */
  trust: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
}).check(
  Schema.makeFilter((agent) =>
    (agent.template === undefined) !== (agent.argv === undefined) || "set exactly one of `template` and `argv`"
  )
)
export type Agent = typeof Agent.Type

const Name = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/u))

export const Config = Schema.Struct({
  /**
   * This computer's name, added to room names ("api · laptop"). Set it when
   * herdr-link runs on several computers with one chat server.
   */
  machine: Schema.optionalKey(Schema.NonEmptyString),
  adapters: Schema.Record(Name, AdapterSection),
  agents: Schema.optionalKey(Schema.Record(Name, Agent))
})
export type Config = typeof Config.Type

/** The part of an adapter section that the adapter itself receives. */
export const adapterConfig = (section: AdapterSection): Record<string, Schema.Json> => {
  const rest: Record<string, Schema.Json> = {}
  for (const [key, value] of Object.entries(section)) {
    if (!(bridgeKeys as ReadonlyArray<string>).includes(key)) rest[key] = value as Schema.Json
  }
  return rest
}

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  path: Schema.String,
  message: Schema.String
}) {}

export const parse = Effect.fnUntraced(function*(text: string, path: string) {
  const raw = yield* Effect.fromResult(Toml.parse(text)).pipe(
    Effect.mapError((error) => new ConfigError({ path, message: error.message }))
  )
  return yield* Schema.decodeUnknownEffect(Config)(raw, { onExcessProperty: "error" }).pipe(
    Effect.mapError((issue) => new ConfigError({ path, message: issue.message }))
  )
})

/** `$HERDR_LINK_CONFIG`, else `~/.config/herdr-link/config.toml`. */
export const defaultPath = Effect.gen(function*() {
  const path = yield* Path.Path
  const fromEnv = process.env.HERDR_LINK_CONFIG
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv
  return path.join(process.env.HOME ?? "~", ".config", "herdr-link", "config.toml")
})

export const load = Effect.fn("Config.load")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(path).pipe(
    Effect.mapError((error) => new ConfigError({ path, message: error.message }))
  )
  return yield* parse(text, path)
})

/** The loaded config, as a service. */
export class BridgeConfig extends Context.Service<BridgeConfig, Config>()("herdr-link/Config/BridgeConfig") {
  static readonly layerFile = (path: string) => Layer.effect(BridgeConfig, load(path))
}
