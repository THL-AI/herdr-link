/**
 * The bridge's id mapping, kept in herdr-core's own document store (doc
 * `herdr-link`), so the bridge needs no database. Per adapter: herdr space
 * id → room id, herdr tab id → thread id (plus the emoji in its name).
 *
 * The bridge is the only writer; on a version conflict it rereads the
 * version and writes again.
 */
import { Effect, Schema } from "effect"
import type { CoreError, HerdrCore } from "../core/HerdrCore.ts"

export const docName = "herdr-link"

const ThreadEntry = Schema.Struct({
  thread: Schema.String,
  emoji: Schema.optionalKey(Schema.String)
})

/** A thread whose tab was closed in herdr, kept for a while in the archive room. */
const ArchivedThread = Schema.Struct({
  tab: Schema.String,
  archivedAt: Schema.Number
})

const Archive = Schema.Struct({
  room: Schema.optionalKey(Schema.String),
  /** By thread id. */
  threads: Schema.Record(Schema.String, ArchivedThread)
})
export type Archive = typeof Archive.Type

const AdapterState = Schema.Struct({
  rooms: Schema.Record(Schema.String, Schema.String),
  threads: Schema.Record(Schema.String, ThreadEntry),
  archive: Schema.optionalKey(Archive),
  /** The live status message in the direct conversation. */
  dashboard: Schema.optionalKey(Schema.String)
})
export type AdapterState = typeof AdapterState.Type

export const State = Schema.Struct({
  adapters: Schema.Record(Schema.String, AdapterState)
})
export type State = typeof State.Type

export const empty: State = { adapters: {} }
export const emptyAdapter: AdapterState = { rooms: {}, threads: {} }

export interface Store {
  readonly state: () => State
  readonly save: (next: State) => Effect.Effect<void, CoreError>
}

export const load = Effect.fnUntraced(function*(core: HerdrCore["Service"]) {
  const doc = yield* core.call("doc.get", { name: docName })
  let version = doc.version
  let state = doc.value === null
    ? empty
    : yield* Schema.decodeUnknownEffect(State)(doc.value).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`ignoring unreadable ${docName} document: ${error.message}`).pipe(Effect.as(empty))
      )
    )

  const write = (next: State) =>
    core.call("doc.set", { name: docName, value: next as unknown as Schema.Json, version }).pipe(
      Effect.map(({ version: written }) => {
        version = written
        state = next
      })
    )

  const store: Store = {
    state: () => state,
    save: (next) =>
      write(next).pipe(
        Effect.catchIf(
          (error) => error.kind === "conflict",
          () =>
            core.call("doc.get", { name: docName }).pipe(
              Effect.flatMap((current) => {
                version = current.version
                return write(next)
              })
            )
        )
      )
  }
  return store
})
