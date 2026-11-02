# herdr-link

Run your coding agents in herdr on your Mac, steer them
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

| On the Mac | In the chat |
| --- | --- |
| a space | a private category (only you and the bot) |
| a tab | a channel `✳️main` named with its agent's emoji |
| the agent replies | its reply in the channel |
| the agent finishes / needs you | "✅ Done" / "⚠️ Needs you" |
| a permission prompt | 🔐 with Allow, Allow always, Deny |
| a tab or space closed | its channel moves to `📦 archive`, deleted after 7 days |

| In the chat | On the Mac |
| --- | --- |
| a message in a tab's channel | typed into its agent (files are put beside it) |
| a new channel `✳️api` in a space's category | a new tab with that agent (no emoji: the bot asks) |
| a deleted channel | its tab is closed |
| a task in the DM | a new tab in the space you pick, the task as its first message |
| `/screen`, `/status`, `/space new` | the agent's screen, every agent's state, a new space |

Agents are configuration, not code: Claude Code and Grok are set up out of the
box (their keys for Allow / Deny are verified against the real apps), and any
program can be an agent.

## Requirements

- macOS with herdr (herdr-core and the herdr-app window)
- Node 24 and pnpm
- a Discord server of your own and a bot (below)

## Setup

1. **Install**

   ```sh
   git clone https://github.com/THL-AI/herdr-link.git && cd herdr-link
   pnpm install
   ```

2. **Create the Discord bot** at <https://discord.com/developers/applications>:
   - *New Application*; on **Installation** set *Install Link* to *None*.
   - **Bot**: turn off *Public Bot*, leave *Requires OAuth2 Code Grant* off,
     turn on *Message Content Intent*, *Reset Token* and copy it.
   - Optional: upload your agents' logos under **Emojis** (e.g. `claude`,
     `grok`); they are used for buttons and reactions.
   - Invite it, with your Application ID:
     `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=275146443856`
     (View Channels, Send Messages, Send Messages in Threads, Read Message
     History, Attach Files, Add Reactions, Manage Channels, Manage Roles; no
     Administrator).
   - In Discord, enable *Developer Mode* and copy your server ID and user ID.

3. **Configure**

   ```sh
   mkdir -p ~/.config/herdr-link
   cp config.example.toml ~/.config/herdr-link/config.toml   # set owner and guild
   echo 'DISCORD_TOKEN=...' > ~/.config/herdr-link/.env
   ```

4. **Hook the agents** (their replies reach the chat through one shared hook):

   ```sh
   pnpm hooks:install     # Claude Code (~/.claude/settings.json, backed up) and Grok
   ```

5. **Run**

   ```sh
   pnpm service:install   # a launchd agent: starts at login, restarts on crash
   pnpm service:status    # state and the last log lines
   ```

   or `pnpm start` in the foreground. Only one bridge runs at a time.

6. **Lock it down:** in Server Settings → Integrations, allow the bot's
   commands only for yourself; give nobody else Administrator, Manage Channels
   or Manage Roles; set the bot's categories to *All Messages* to get pushes.

## Configuration

See [`config.example.toml`](config.example.toml). Each `[agents.*]` entry has
an `emoji` (used in channel names), a `template` or `argv` (how to start it),
an optional `logo` (an application emoji) and the keys that answer its
permission prompts: `allow`, `always`, `deny`, `trust`.

## Security

Whoever can write in the bot's channels can run code on your Mac. The adapter
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

[MIT](LICENSE)
