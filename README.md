<p align="center">
  <img src="https://raw.githubusercontent.com/THL-AI/herdr-link/main/assets/logo.svg" width="128" height="128" alt="herdr-link logo: the herdr ram with a link">
</p>

<h1 align="center">herdr-link</h1>

Run your coding agents in herdr on your computer, steer them
from your phone.

herdr-link mirrors herdr onto a chat app (Discord today, others through
adapters): every herdr space becomes a private category, every tab a channel.
Write in a channel and the tab's agent gets it; its replies, "done" and
"needs you" come back as messages with push notifications; permission prompts
come with **Allow / Deny** buttons. New channels open new tabs, and the DM
with the bot is a control room with a live dashboard.

```
 Discord (phone, desktop)
        ⇅  adapter process (JSON-RPC over stdin/stdout)
 herdr-link bridge  ⇠  shared agent hook (Claude Code, Grok)
        ⇅  herdr-core unix socket, herdr-app CLI
 your agents in herdr terminals
```

## What it does

| In herdr | In the chat |
| --- | --- |
| a space | a private category (only you and the bot) |
| a tab | a channel `✳️main` named with its agent's emoji |
| the agent replies | its reply in the channel |
| the agent finishes / needs you | "✅ Done" / "⚠️ Needs you" |
| a permission prompt | 🔐 with Allow, Allow always, Deny |
| a tab or space closed | its channel moves to `📦 archive`, deleted after 7 days |

| In the chat | In herdr |
| --- | --- |
| a message in a tab's channel | typed into its agent (files are put beside it) |
| a new channel `✳️api` in a space's category | a new tab with that agent (no emoji: the bot asks) |
| a deleted channel | its tab is closed |
| a task in the DM | a new tab in the space you pick, the task as its first message |
| `/screen`, `/status`, `/space new` | the agent's screen, every agent's state, a new space |

Agents are configuration, not code: Claude Code and Grok are set up out of the
box (their keys for Allow / Deny are verified against the real apps), and any
program can be an agent.

## Install

You need herdr (herdr-core and the herdr-app window) on **macOS or Linux**,
Node 24, and a Discord server of your own.

```sh
npm install -g @thl-ai/herdr-link
herdr-link init
```

`herdr-link init` walks you through the rest and only asks what it cannot find
out: it checks herdr, takes your bot token (and tells you how to make one),
turns on the Message Content intent, finds your user ID and the server the bot
is on (or gives you the invite link), picks up the agents on your PATH, writes
`~/.config/herdr-link/config.toml` and `.env`, installs the agent hooks and
starts the bridge in the background (launchd on macOS, a systemd user unit on
Linux).

Then, in Discord: allow the bot's commands only for yourself (Server Settings
→ Integrations), and set its categories to *All Messages* to get pushes.

```
herdr-link doctor                # check every piece, with fixes
herdr-link service status | logs | install | uninstall
herdr-link hooks install | uninstall
herdr-link run                   # in the foreground instead of the service
```

<details>
<summary>Doing it by hand</summary>

1. Create the bot at <https://discord.com/developers/applications>: *New
   Application*; on **Installation** set *Install Link* to *None*; on **Bot**
   turn off *Public Bot*, turn on *Message Content Intent*, *Reset Token* and
   copy it. Optionally upload your agents' logos under **Emojis** (`claude`,
   `grok`).
2. Invite it with your Application ID:
   `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=275146443856`
   (View Channels, Send Messages, Send Messages in Threads, Read Message
   History, Attach Files, Add Reactions, Manage Channels, Manage Roles; no
   Administrator).
3. Copy [`config.example.toml`](config.example.toml) to
   `~/.config/herdr-link/config.toml` and set `owner` (your user ID) and
   `guild` (the server ID; Developer Mode, right-click, Copy ID). Put
   `DISCORD_TOKEN=...` in `~/.config/herdr-link/.env`.
4. `herdr-link hooks install`, then `herdr-link service install`.

</details>

## More than one computer

- **One herdr, several machines** (`hc machine add`): one herdr-link sees them
  all; spaces on another machine get its name, like `api · build-box`.
- **Separate computers, each with its own herdr:** run herdr-link on each,
  **with its own bot** (another application in the Developer Portal; `herdr-link
  init` sets it up). Two bridges sharing one bot would both answer the DM and
  the commands. Answer yes when `init` asks about other computers: it sets
  `machine` in the config, so each computer's categories read `api · laptop`,
  `api · desktop`.

## Split tabs

A tab split into several panes keeps one channel. The panes sign their
messages (`✳️ claude · …`). Reply to a message to answer that pane, start with
an agent's emoji (`⚪ check the tests`) to pick an agent, or just write and
the bot asks who it is for.

## Configuration

See [`config.example.toml`](config.example.toml). Each `[agents.*]` entry has
an `emoji` (used in channel names), a `template` or `argv` (how to start it),
an optional `logo` (an application emoji) and the keys that answer its
permission prompts: `allow`, `always`, `deny`, `trust`.

## Security

Whoever can write in the bot's channels can run code on your machine. The adapter
checks every message, reaction, button and command against your user ID, the
categories are private, and the hook talks to the bridge over a unix socket
only you can open. Don't send secrets through it: the chat platform sees
everything.

**Install only adapters you trust.** An adapter can type into your agents'
terminals. It only sees the environment variables its config section lists in
`env`.

## Writing an adapter

An adapter is any program that speaks JSON-RPC 2.0 on stdin/stdout, one
message per line: the bridge sends `hello` with the adapter's config section,
then `room.ensure`, `thread.ensure`, `message.post`, `ask`…; the adapter
reports `message.received`, `action.pressed`, `command.invoked`… The full
protocol is in [`schema/chat.openrpc.json`](schema/chat.openrpc.json);
[`test/fixtures/fake-adapter.mjs`](test/fixtures/fake-adapter.mjs) is a
minimal one in plain Node.

## Development

```sh
pnpm typecheck
pnpm test
pnpm schema      # after changing the protocol
```

TypeScript 7 and [Effect 4](https://effect.website). The architecture, the
decisions behind it and what we learned about herdr-core, Claude Code and Grok
are in [CLAUDE.md](CLAUDE.md).

## License

[MIT](LICENSE). The ram in the logo is herdr's own.
