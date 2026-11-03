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

const Silent = Schema.Boolean.annotate({
  description: "true: deliver without a push notification (the owner is at the computer). Adapters that " +
    "cannot post silently post normally."
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
      replyTo: Schema.optionalKey(MessageId),
      silent: Schema.optionalKey(Silent)
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
      choices: Schema.NonEmptyArray(Choice),
      silent: Schema.optionalKey(Silent)
    }),
    Schema.Struct({ message: MessageId })
  ),
  "thread.status": notification(
    "thread.status",
    "An agent in this thread's tab changed state. Sent only to adapters whose capabilities say `status`. A split " +
      "tab has several terminals, each reported on its own.",
    Schema.Struct({
      thread: ThreadId,
      terminal: Schema.NonEmptyString.annotate({ description: "The herdr terminal (one pane of the tab)." }),
      state: Schema.String.annotate({
        description: "working, blocked (waiting for the owner), done (finished its turn), idle, error, or gone " +
          "(the terminal ended)."
      }),
      kind: Schema.optionalKey(Schema.String.annotate({
        description: "With blocked: what it waits for (permission, question, auth…)."
      })),
      text: Schema.optionalKey(Schema.String.annotate({ description: "The agent's own status line, if any." }))
    })
  )
} as const

// Adapter → bridge. The adapter forwards only what the owner did and drops
// everything else (other users, bots, its own messages).

export const AdapterToBridge = {
  "thread.created": notification(
    "thread.created",
    "The owner created a thread: the bridge opens a tab for it in the room's space. The bridge ignores threads " +
      "outside rooms it ensured.",
    Schema.Struct({
      room: Schema.optionalKey(RoomId),
      thread: ThreadId,
      name: Schema.String.annotate({
        description: "Without `agent`, a leading agent emoji picks the agent (else the bridge asks); without " +
          "rooms, `space / tab` names the space."
      }),
      agent: Schema.optionalKey(Schema.NonEmptyString.annotate({
        description: "A configured agent's name (claude, grok…): the tab starts at once with it, named `name`."
      })),
      task: Schema.optionalKey(Schema.String.annotate({
        description: "The agent's first message. Without it, messages written in the thread before the tab " +
          "starts become the task."
      }))
    })
  ),
  "room.deleted": notification(
    "room.deleted",
    "The owner deleted a room the bridge ensured: its space is closed in herdr, with every tab in it. The " +
      "adapter does not report its own room.delete.",
    Schema.Struct({ room: RoomId })
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
  ),
  "space.create": request(
    "space.create",
    "Make a herdr space, optionally with a first tab running an agent on a task. Answers once the space exists, " +
      "with its room (adapters with rooms) and the first tab's thread, already linked: the sync reuses them. " +
      "InvalidParams for an unknown agent, InternalError when herdr refuses.",
    Schema.Struct({
      name: Schema.NonEmptyString,
      folder: Schema.NonEmptyString.annotate({ description: "Where its terminals start; `~` is the home folder." }),
      agent: Schema.optionalKey(Schema.NonEmptyString.annotate({ description: "A configured agent's name." })),
      tab: Schema.optionalKey(Schema.NonEmptyString.annotate({
        description: "The first tab's name (with `agent`; default: the agent's name)."
      })),
      task: Schema.optionalKey(Schema.String.annotate({ description: "The agent's first message." }))
    }),
    Schema.Struct({
      room: Schema.optionalKey(RoomId),
      thread: Schema.optionalKey(ThreadId)
    })
  )
} as const

export type BridgeToAdapter = typeof BridgeToAdapter
export type AdapterToBridge = typeof AdapterToBridge

export type { MethodDef, NotificationDef, Params, RequestDef, Result } from "./Rpc.ts"
