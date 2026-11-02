# Writing an adapter

herdr-link talks to chat apps through **adapters**: small programs, in any
language, that speak a JSON-RPC 2.0 protocol on stdin/stdout. The bridge does
everything herdr-specific (spaces, tabs, agents, prompts, the archive); the
adapter only knows its chat platform. The built-in Discord adapter
(`src/adapters/discord/main.ts`) uses the same protocol as yours would.

The machine-readable reference is [`schema/chat.openrpc.json`](../schema/chat.openrpc.json)
(OpenRPC). This page explains how to use it.

## The model

| herdr-link says | means | Discord | Telegram (for example) | Slack (for example) |
| --- | --- | --- | --- | --- |
| **room** | a herdr space | a category | a forum group | a channel section |
| **thread** | a herdr tab | a text channel | a forum topic | a channel |
| **direct** | the owner's private chat with the bot | the DM | the private chat | the DM |
| **action** | a button under a message | a button | an inline keyboard button | a block button |

- Ids (`room`, `thread`, `message`, `action`) are **opaque strings**. The
  bridge stores the ones you return and gives them back; it never parses them.
  Encode whatever you need (`"chat:-100123/topic:45"` is fine).
- A **place** is where a message lives: `{"kind": "thread", "thread": "<id>"}`
  or `{"kind": "direct"}`.
- An adapter serves **one owner**. You check every inbound message, reaction,
  button press and command against the owner and drop everything else: whoever
  can write in these threads can run code on the owner's machine.

## Lifecycle

1. The owner adds a section to `~/.config/herdr-link/config.toml`:

   ```toml
   [adapters.telegram]
   command = ["herdr-link-telegram"]   # argv of your program
   env = ["TELEGRAM_TOKEN"]            # env vars your program may see
   owner = "123456789"                 # everything else is yours, sent in hello
   chat = "-1001234567890"
   ```

2. The bridge starts `command` with only the listed `env` variables plus
   `PATH`, `HOME`, `USER`, `LANG`… Secrets come from
   `~/.config/herdr-link/.env`.
3. Messages are JSON-RPC 2.0, **one per line**, UTF-8, on stdin (from the
   bridge) and stdout (to the bridge). Both sides send requests and
   notifications; request ids are per sender. **Write logs to stderr**: the
   bridge copies them into its own log. Anything else on stdout breaks the
   protocol.
4. The bridge sends `hello` first. Validate your config, connect to your
   platform, and answer **only when you are ready**. Don't send anything before
   that.
5. When stdin closes, shut down. The bridge restarts an adapter that exits,
   with backoff, except after an `InvalidConfig` or `UnsupportedProtocol`
   error.

## hello

```json
→ {"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":1,"config":{"owner":"123456789","chat":"-1001234567890"},"commands":[{"name":"status","description":"What every agent is doing","options":[]},{"name":"space new","description":"Make a herdr space","options":[{"name":"name","description":"Space name","type":"string","required":true}]}]}}
← {"jsonrpc":"2.0","id":1,"result":{"protocol":1,"adapter":{"name":"telegram","version":"0.1.0"},"capabilities":{"rooms":true,"direct":true,"threadCreation":true,"actions":true,"reactions":true,"customEmoji":false,"commands":true,"edit":true,"files":true,"maxText":4096,"maxActions":8}}}
```

- `config` is your section of the config file without `command` and `env`.
  If it is wrong, answer with error `-32003` (InvalidConfig) and a message the
  owner can act on; the bridge then stops instead of restarting you.
- `commands` are the slash commands to register, if your platform has them.
  A name with a space (`space new`) is a command with a subcommand.
- `capabilities` tell the bridge what you can do. Be honest: the bridge works
  around what you can't.

| capability | when false |
| --- | --- |
| `rooms` | every tab is a top-level thread named `<space> / <tab>`; a closed tab's thread is deleted (no archive); no new tabs from new threads |
| `direct` | no control room, no dashboard, no quick tasks |
| `threadCreation` | the owner can't open tabs by making threads |
| `actions` | permission prompts come as text (answer them in herdr); `ask` is still sent: offer its choices as reactions or numbered replies |
| `reactions` | no 👀 on received messages, no answers by reaction |
| `customEmoji` | agent logos are replaced by their Unicode emoji |
| `commands` | no slash commands |
| `edit` | no live dashboard; answered prompts keep their buttons |
| `files` | attachments are neither sent nor received |
| `maxText` | the bridge splits longer text into several messages |
| `maxActions` | the most buttons the bridge puts under one message |

## Bridge → adapter

All of these are requests: answer each with a result or an error.

| method | params | result | what to do |
| --- | --- | --- | --- |
| `room.ensure` | `room?`, `name` | `room`, `created` | Make sure a **private** room (only the owner and the bot) exists with this name. With `room`: reuse it, rename if needed; if it is gone, create a new one. |
| `room.delete` | `room` | `{}` | Delete a room you made. The bridge empties it first. |
| `thread.ensure` | `room?`, `thread?`, `name?`, `topic?` | `thread`, `created` | Same for a thread in `room`: create, or reuse by id, move into `room`, rename and set the topic when given. `name` is only required to create. |
| `thread.delete` | `thread` | `{}` | Delete a thread you made, with its history. |
| `message.post` | `place`, `text`, `files?`, `actions?`, `replyTo?` | `message` | Post. `text` is short Markdown (bold, italics, code, code blocks, links): convert or strip it. `files` are local paths. `actions` are buttons. |
| `message.edit` | `place`, `message`, `text?`, `actions?` | `{}` | Replace the text and/or the buttons; `actions: []` removes them. |
| `react` | `place`, `message`, `emoji` | `{}` | Add the bot's reaction. |
| `ask` | `place`, `text`, `choices` | `message` | Post a question and **return at once**. Report the answer later as `action.pressed` with the choice's id, whether the owner pressed a button or reacted with the choice's emoji. |

An emoji is `{"kind": "unicode", "value": "👀"}` or `{"kind": "custom", "name": "claude"}`
(a custom emoji you know by name, such as an agent's logo).

```json
→ {"jsonrpc":"2.0","id":7,"method":"message.post","params":{"place":{"kind":"thread","thread":"-1001234567890/45"},"text":"🔐 Permission: approve Bash: pnpm test","actions":[{"id":"prompt:3:allow","label":"Allow","style":"success"},{"id":"prompt:3:deny","label":"Deny","style":"danger"}]}}
← {"jsonrpc":"2.0","id":7,"result":{"message":"-1001234567890/45/9001"}}
```

## Adapter → bridge

Report only what **the owner** did. Notifications are handled in order.

| method | kind | params |
| --- | --- | --- |
| `message.received` | notification | `place`, `message`, `text`, `attachments`, `replyTo?` |
| `action.pressed` | notification | `place`, `message`, `action` (the id the bridge gave the button or choice) |
| `reaction.added` | notification | `place`, `message`, `emoji` |
| `thread.created` | notification | `room?`, `thread`, `name` |
| `thread.deleted` | notification | `thread` |
| `command.invoked` | **request** | `place`, `command`, `args` → result `{"text": "…"}`: show it as the reply |

- `attachments` are `{"name", "url", "size?", "contentType?"}`; the bridge
  downloads `url` and puts the file beside the agent.
- Don't report threads you created or deleted yourself through
  `thread.ensure` / `thread.delete` (watch out for platforms that announce a
  new channel before your API call returns). A thread the owner deletes closes
  its tab; a thread the owner creates in one of your rooms opens a new one.
- Acknowledge button presses on your platform yourself (Discord, for example,
  wants an answer within 3 seconds); the bridge does not wait for that.
- Platforms with short reply deadlines for commands: defer, then send the
  result of `command.invoked` when it comes.

```json
← {"jsonrpc":"2.0","method":"message.received","params":{"place":{"kind":"thread","thread":"-1001234567890/45"},"message":"-1001234567890/45/9002","text":"run the tests","attachments":[]}}
```

## Errors

Standard JSON-RPC codes, plus:

| code | name | use it when |
| --- | --- | --- |
| `-32001` | Unsupported | the method needs a capability you don't have |
| `-32002` | NotFound | the room, thread or message is gone on your platform |
| `-32003` | InvalidConfig | `hello`: your config section is wrong |
| `-32004` | UnsupportedProtocol | `hello`: you don't speak this `protocol` version |

## A minimal adapter

[`test/fixtures/fake-adapter.mjs`](../test/fixtures/fake-adapter.mjs) is a
complete one in 50 lines of plain Node, used by the tests. The same skeleton in
Python:

```python
#!/usr/bin/env python3
import json, sys

def send(message):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", **message}) + "\n")
    sys.stdout.flush()

def log(text):
    print(text, file=sys.stderr, flush=True)

def hello(params):
    config = params["config"]
    if "owner" not in config:
        raise RpcError(-32003, "set `owner` in [adapters.mychat]")
    # connect to the platform here, then answer
    return {"protocol": 1, "adapter": {"name": "mychat", "version": "0.1.0"},
            "capabilities": {"rooms": False, "direct": True, "threadCreation": False, "actions": False,
                             "reactions": False, "customEmoji": False, "commands": False, "edit": False,
                             "files": False, "maxText": 4000, "maxActions": 0}}

def thread_ensure(params):
    return {"thread": params.get("thread") or "main", "created": "thread" not in params}

def message_post(params):
    log(f"post to {params['place']}: {params['text']}")
    return {"message": "1"}

class RpcError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code

handlers = {"hello": hello, "thread.ensure": thread_ensure, "message.post": message_post}

for line in sys.stdin:  # stdin closes: the bridge wants us gone
    message = json.loads(line)
    if "method" not in message:
        continue  # a response to one of our requests
    handler = handlers.get(message["method"])
    try:
        if handler is None:
            raise RpcError(-32601, f"unknown method {message['method']}")
        result = handler(message.get("params", {}))
        if "id" in message:
            send({"id": message["id"], "result": result})
    except RpcError as error:
        if "id" in message:
            send({"id": message["id"], "error": {"code": error.code, "message": str(error)}})

# when the owner writes, from your platform's event loop:
# send({"method": "message.received", "params": {"place": {"kind": "thread", "thread": "main"},
#       "message": "42", "text": "hello", "attachments": []}})
```

## Trying it

1. Add your section to the config (above), then `herdr-link doctor` checks that
   your `command` and `env` resolve.
2. Run the bridge in the foreground to see your stderr live: `herdr-link run`
   (stop the service first: `herdr-link service uninstall`, or it refuses to
   start a second bridge).
3. Publish it as a package with a `herdr-link-<platform>` binary, and tell its
   users: **install only adapters you trust**. An adapter can type into their
   agents' terminals.
