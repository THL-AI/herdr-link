/**
 * Methods of the Chat protocol, as data: each entry is the method name, its
 * params schema and, for requests, its result schema. The bridge, the adapters
 * and the OpenRPC export all read these tables.
 *
 * Lifecycle: the bridge spawns the adapter and sends `hello`. The adapter
 * answers once it is connected to its platform and ready to serve; before
 * that it must not send anything. Closing the adapter's stdin means shut down.
 * stderr is free-form log output that the bridge forwards to its own log.
 */
import { Schema } from "effect"
import { notification, request } from "./Rpc.ts"
import {
  Action,
  ActionId,
  AdapterInfo,
  Attachment,
  Capabilities,
  Choice,
  CommandArgs,
  CommandSpec,
  Emoji,
  MessageId,
  OutgoingFile,
  Place,
  ProtocolVersion,
  RoomId,
  ThreadId
} from "./Chat.ts"

const Empty = Schema.Struct({})

const Text = Schema.String.annotate({
  description: "Markdown (the Discord subset: bold, italics, code, code blocks, links). Adapters convert or strip it."
})

// Bridge → adapter

export const BridgeToAdapter = {
  hello: request(
    "hello",
    "First message, sent once. The adapter validates `config` (failing with InvalidConfig), registers `commands` " +
      "if it supports them, connects to its platform and only then answers.",
    Schema.Struct({
      protocol: ProtocolVersion,
      config: Schema.Record(Schema.String, Schema.Json).annotate({
        description: "The adapter's section of the bridge config, minus `command`."
      }),
      commands: Schema.Array(CommandSpec)
    }),
    Schema.Struct({
      protocol: ProtocolVersion,
      adapter: AdapterInfo,
      capabilities: Capabilities
    })
  ),
  "room.ensure": request(
    "room.ensure",
    "Make sure a private room (owner and bot only) exists with this name. With `room`, reuse it and rename if " +
      "needed; if it is gone or absent, create a new one. Returns the id to store.",
    Schema.Struct({
      room: Schema.optionalKey(RoomId),
      name: Schema.NonEmptyString
    }),
    Schema.Struct({ room: RoomId, created: Schema.Boolean })
  ),
  "thread.ensure": request(
    "thread.ensure",
    "Same as room.ensure for a thread inside `room` (omitted when the adapter has no rooms); moves it there if it " +
      "lives elsewhere. Updates name and topic when given; `name` is required only to create one.",
    Schema.Struct({
      room: Schema.optionalKey(RoomId),
      thread: Schema.optionalKey(ThreadId),
      name: Schema.optionalKey(Schema.NonEmptyString),
      topic: Schema.optionalKey(Schema.String)
    }),
    Schema.Struct({ thread: ThreadId, created: Schema.Boolean })
  ),
  "thread.delete": request(
    "thread.delete",
    "Delete a thread the adapter made, with its history. NotFound if it is already gone. The adapter does not " +
      "report its own deletions as thread.deleted.",
    Schema.Struct({ thread: ThreadId }),
    Empty
  ),
  "room.delete": request(
    "room.delete",
    "Delete a room the adapter made (the bridge empties it first). NotFound if it is already gone.",
    Schema.Struct({ room: RoomId }),
    Empty
  ),
  "message.post": request(
    "message.post",
    "Post a message. `text` never exceeds capabilities.maxText: the bridge splits long text.",
    Schema.Struct({
      place: Place,
      text: Text,
      files: Schema.optionalKey(Schema.Array(OutgoingFile)),
      actions: Schema.optionalKey(Schema.Array(Action)),
      replyTo: Schema.optionalKey(MessageId)
    }),
    Schema.Struct({ message: MessageId })
  ),
  "message.edit": request(
    "message.edit",
    "Replace the text and/or the actions of a message the adapter posted. `actions: []` removes all buttons.",
    Schema.Struct({
      place: Place,
      message: MessageId,
      text: Schema.optionalKey(Text),
      actions: Schema.optionalKey(Schema.Array(Action))
    }),
    Empty
  ),
  react: request(
    "react",
    "Add the bot's reaction to a message.",
    Schema.Struct({ place: Place, message: MessageId, emoji: Emoji }),
    Empty
  ),
  ask: request(
    "ask",
    "Post a question with choices and return at once. The owner's answer arrives later as action.pressed with " +
      "the choice id, whether they pressed a button or reacted with the choice's emoji.",
    Schema.Struct({
      place: Place,
      text: Text,
      choices: Schema.NonEmptyArray(Choice)
    }),
    Schema.Struct({ message: MessageId })
  )
} as const

// Adapter → bridge. The adapter forwards only what the owner did and drops
// everything else (other users, bots, its own messages).

export const AdapterToBridge = {
  "thread.created": notification(
    "thread.created",
    "The owner created a thread. The bridge ignores threads outside rooms it ensured.",
    Schema.Struct({
      room: Schema.optionalKey(RoomId),
      thread: ThreadId,
      name: Schema.String
    })
  ),
  "thread.deleted": notification(
    "thread.deleted",
    "A thread is gone (deleted by the owner or by the platform).",
    Schema.Struct({ thread: ThreadId })
  ),
  "message.received": notification(
    "message.received",
    "The owner wrote a message.",
    Schema.Struct({
      place: Place,
      message: MessageId,
      text: Schema.String,
      attachments: Schema.Array(Attachment),
      replyTo: Schema.optionalKey(MessageId)
    })
  ),
  "reaction.added": notification(
    "reaction.added",
    "The owner reacted to a message. Reactions that answer an `ask` come as action.pressed instead.",
    Schema.Struct({ place: Place, message: MessageId, emoji: Emoji })
  ),
  "action.pressed": notification(
    "action.pressed",
    "The owner pressed a button or answered an `ask`. The adapter acknowledges the press on its platform itself.",
    Schema.Struct({ place: Place, message: MessageId, action: ActionId })
  ),
  "command.invoked": request(
    "command.invoked",
    "The owner ran a command from hello's `commands`. The result is the reply to show; the adapter defers it on " +
      "platforms with short reply deadlines.",
    Schema.Struct({
      place: Place,
      command: Schema.NonEmptyString,
      args: CommandArgs
    }),
    Schema.Struct({ text: Text })
  )
} as const

export type BridgeToAdapter = typeof BridgeToAdapter
export type AdapterToBridge = typeof AdapterToBridge

export type { MethodDef, NotificationDef, Params, RequestDef, Result } from "./Rpc.ts"
