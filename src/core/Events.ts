/**
 * herdr-core events, decoded from the raw `event` notification. Shapes were
 * taken from a live core (0.1.15); unknown or changed types come through as
 * `other` instead of failing, so a newer core never breaks the stream.
 */
import { Effect, Schema } from "effect"
import { Foreground, Labels, type RawEvent, Status, Terminal } from "./Methods.ts"

export type CoreEvent =
  | { readonly _tag: "snapshot"; readonly seq: number; readonly terminals: ReadonlyArray<Terminal> }
  | { readonly _tag: "created"; readonly seq: number; readonly terminal: Terminal }
  | { readonly _tag: "status"; readonly seq: number; readonly address: string; readonly status: Status | null }
  | { readonly _tag: "title"; readonly seq: number; readonly address: string; readonly title: string }
  | { readonly _tag: "labels"; readonly seq: number; readonly address: string; readonly labels: Labels }
  | {
    readonly _tag: "foreground"
    readonly seq: number
    readonly address: string
    readonly foreground: Foreground | null
  }
  | {
    readonly _tag: "finished"
    readonly seq: number
    readonly address: string
    readonly exitCode: number | null
    readonly reason: string | null
  }
  | { readonly _tag: "removed"; readonly seq: number; readonly address: string }
  | { readonly _tag: "doc"; readonly seq: number; readonly name: string; readonly version: number }
  | {
    readonly _tag: "other"
    readonly seq: number
    readonly type: string
    readonly address: string | undefined
    readonly data: unknown
  }

const data = {
  created: Terminal,
  status: Schema.Struct({ status: Schema.optionalKey(Schema.NullOr(Status)) }),
  title: Schema.Struct({ title: Schema.String }),
  labels: Schema.Struct({ labels: Labels }),
  foreground: Schema.NullOr(Foreground),
  finished: Schema.Struct({
    exit_code: Schema.optionalKey(Schema.NullOr(Schema.Int)),
    reason: Schema.optionalKey(Schema.NullOr(Schema.String))
  }),
  removed: Schema.Unknown,
  doc: Schema.Struct({ name: Schema.String, version: Schema.Int })
} as const

const decode = <S extends Schema.Codec<any, any>>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value) as Effect.Effect<S["Type"], Schema.SchemaError>

export const decodeEvent = (raw: RawEvent): Effect.Effect<CoreEvent> => {
  const { seq } = raw
  const address = raw.terminal
  const other: CoreEvent = { _tag: "other", seq, type: raw.type, address, data: raw.data }
  const needsAddress = (make: (address: string) => Effect.Effect<CoreEvent, Schema.SchemaError>) =>
    address === undefined ? Effect.succeed(other) : make(address)

  const decoded: Effect.Effect<CoreEvent, Schema.SchemaError> = (() => {
    switch (raw.type) {
      case "created":
        return decode(data.created, raw.data).pipe(Effect.map((terminal) => ({ _tag: "created", seq, terminal })))
      case "status":
        return needsAddress((address) =>
          decode(data.status, raw.data).pipe(
            Effect.map((d) => ({ _tag: "status", seq, address, status: d.status ?? null }))
          )
        )
      case "title":
        return needsAddress((address) =>
          decode(data.title, raw.data).pipe(Effect.map((d) => ({ _tag: "title", seq, address, title: d.title })))
        )
      case "labels":
        return needsAddress((address) =>
          decode(data.labels, raw.data).pipe(Effect.map((d) => ({ _tag: "labels", seq, address, labels: d.labels })))
        )
      case "foreground":
        return needsAddress((address) =>
          decode(data.foreground, raw.data).pipe(
            Effect.map((foreground) => ({ _tag: "foreground", seq, address, foreground }))
          )
        )
      case "finished":
        return needsAddress((address) =>
          decode(data.finished, raw.data).pipe(
            Effect.map((d) => ({
              _tag: "finished",
              seq,
              address,
              exitCode: d.exit_code ?? null,
              reason: d.reason ?? null
            }))
          )
        )
      case "removed":
        return needsAddress((address) => Effect.succeed({ _tag: "removed", seq, address }))
      case "doc":
        return decode(data.doc, raw.data).pipe(
          Effect.map((d) => ({ _tag: "doc", seq, name: d.name, version: d.version }))
        )
      default:
        return Effect.succeed(other)
    }
  })()

  return decoded.pipe(
    Effect.catch((error) =>
      Effect.logWarning(`unexpected ${raw.type} event from herdr-core: ${error.message}`).pipe(Effect.as(other))
    )
  )
}
