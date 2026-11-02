/**
 * The part of the herdr-core API the bridge uses, written from `hc schema`
 * (generation 1, core 0.1.15). Field names stay as on the wire (snake_case).
 * Excess keys are ignored, so newer cores with more fields still decode.
 *
 * Errors come as JSON-RPC code -32000 with a stable `data.kind`
 * (`not_found`, `finished`, `blocked`, `conflict`, ...).
 */
import { Schema } from "effect"
import { notification, request } from "../protocol/Rpc.ts"

const Nullable = <S extends Schema.Codec<any, any>>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

export const Generation = 1

export const Labels = Schema.Record(Schema.String, Schema.String)
export type Labels = typeof Labels.Type

/** One OSC 7501 record: the program's own words, never translated. */
export const Status = Schema.Struct({
  state: Schema.String.annotate({ description: "idle, working, done, blocked or error." }),
  app: Schema.optionalKey(Schema.String),
  kind: Nullable(Schema.String).annotate({ description: "permission, question or auth (blocked only)." }),
  msg: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  progress: Nullable(Schema.Int)
})
export type Status = typeof Status.Type

export const Foreground = Schema.Struct({
  pid: Schema.Int,
  name: Schema.String,
  argv: Schema.Array(Schema.String),
  cwd: Schema.String
})
export type Foreground = typeof Foreground.Type

export const Terminal = Schema.Struct({
  address: Schema.String.annotate({ description: "`t7`: this terminal forever on this core." }),
  labels: Labels,
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  state: Schema.String.annotate({ description: "live or finished." }),
  created_ms: Schema.Number,
  name: Nullable(Schema.String),
  title: Schema.optionalKey(Schema.String),
  template: Nullable(Schema.String),
  parent: Nullable(Schema.String),
  foreground: Nullable(Foreground),
  status: Nullable(Status),
  turn: Schema.optionalKey(Schema.Int),
  exit_code: Nullable(Schema.Int),
  reason: Nullable(Schema.String)
})
export type Terminal = typeof Terminal.Type

const TerminalRef = Schema.Struct({
  terminal: Schema.String.annotate({ description: "`t7`, a name, or `machine/t7`." })
})

export const CoreMethods = {
  hello: request(
    "hello",
    "Handshake.",
    Schema.Struct({ generation: Schema.Int }),
    Schema.Struct({
      generation: Schema.Int,
      version: Schema.String,
      core: Schema.Struct({ id: Schema.String, name: Schema.String }),
      methods: Schema.Array(Schema.String),
      features: Schema.Array(Schema.String)
    })
  ),
  "terminal.list": request(
    "terminal.list",
    "Live terminals (all with `all`), optionally filtered by labels.",
    Schema.Struct({ all: Schema.optionalKey(Schema.Boolean), labels: Schema.optionalKey(Labels) }),
    Schema.Struct({ terminals: Schema.Array(Terminal) })
  ),
  "terminal.get": request("terminal.get", "One terminal's facts.", TerminalRef, Terminal),
  "terminal.run": request(
    "terminal.run",
    "Start a program, or a template (argv[0]) with its task, in a new terminal.",
    Schema.Struct({
      argv: Schema.optionalKey(Schema.Array(Schema.String)),
      cwd: Schema.optionalKey(Schema.String),
      labels: Schema.optionalKey(Labels),
      name: Schema.optionalKey(Schema.String),
      keep: Schema.optionalKey(Schema.Boolean),
      no_parent: Schema.optionalKey(Schema.Boolean),
      wait: Schema.optionalKey(Schema.Boolean)
    }),
    Terminal
  ),
  "terminal.send": request(
    "terminal.send",
    "Paste text and press Enter once nobody has typed for ~3 s.",
    Schema.Struct({
      terminal: Schema.String,
      text: Schema.String,
      force: Schema.optionalKey(Schema.Boolean)
    }),
    Schema.Struct({
      turn: Schema.Int,
      status: Nullable(Schema.String),
      started: Nullable(Schema.Boolean)
    })
  ),
  "terminal.keys": request(
    "terminal.keys",
    "Press named keys: enter, esc, tab, up, ctrl+c, 1, y, ...",
    Schema.Struct({ terminal: Schema.String, keys: Schema.Array(Schema.String) }),
    Schema.Struct({ turn: Schema.Int, status: Nullable(Schema.String) })
  ),
  "terminal.interrupt": request(
    "terminal.interrupt",
    "Press the stop key and report what happened.",
    TerminalRef,
    Schema.Struct({ key: Schema.String, outcome: Schema.String })
  ),
  "terminal.read": request(
    "terminal.read",
    "The screen plus `lines` of history as text.",
    Schema.Struct({ terminal: Schema.String, lines: Schema.optionalKey(Schema.Int) }),
    Schema.Struct({ text: Schema.String, complete: Schema.Boolean, how: Schema.String })
  ),
  "terminal.put": request(
    "terminal.put",
    "Write a file beside a live terminal (base64, at most 8 MB).",
    Schema.Struct({ terminal: Schema.String, name: Schema.String, data: Schema.String }),
    Schema.Struct({ path: Schema.String, bytes: Schema.Int })
  ),
  "terminal.kill": request("terminal.kill", "End the program.", TerminalRef, Schema.Json),
  "templates.list": request(
    "templates.list",
    "Templates by name.",
    Schema.Struct({}),
    Schema.Struct({
      templates: Schema.Array(Schema.Struct({
        name: Schema.String,
        description: Schema.String,
        command: Schema.String,
        error: Nullable(Schema.String)
      }))
    })
  ),
  "doc.get": request(
    "doc.get",
    "A JSON document and its version (0 when never written).",
    Schema.Struct({ name: Schema.String }),
    Schema.Struct({ value: Schema.Json, version: Schema.Int })
  ),
  "doc.set": request(
    "doc.set",
    "Write a document (≤ 1 MiB) if `version` still matches; null deletes. Fails with kind `conflict`.",
    Schema.Struct({ name: Schema.String, value: Schema.Json, version: Schema.Int }),
    Schema.Struct({ version: Schema.Int })
  ),
  "events.subscribe": request(
    "events.subscribe",
    "Snapshot, then `event` notifications. In plain mode the connection then carries only notifications.",
    Schema.Struct({ labels: Schema.optionalKey(Labels), terminal: Schema.optionalKey(Schema.String) }),
    Schema.Struct({ seq: Schema.Int, terminals: Schema.Array(Terminal) })
  )
} as const
export type CoreMethods = typeof CoreMethods

export const RawEvent = Schema.Struct({
  seq: Schema.Int,
  type: Schema.String,
  terminal: Schema.optionalKey(Schema.String),
  data: Schema.Json
})
export type RawEvent = typeof RawEvent.Type

/** What the core sends on a subscribed connection. */
export const CoreNotifications = {
  event: notification("event", "A fact changed.", RawEvent),
  heartbeat: notification("heartbeat", "Every 15 s.", Schema.Struct({ seq: Schema.Int })),
  missed: notification("missed", "The subscriber fell behind; a fresh snapshot follows.", Schema.Json)
} as const
export type CoreNotifications = typeof CoreNotifications
