# Getting started

From nothing to answering your agents from your phone, in about ten minutes.

> **Rather have your agent do it?** Tell it: `Read
> https://thl-ai.github.io/herdr-link/install.md and install herdr-link for
> me.` It follows [these instructions](install-with-an-agent.md) and leaves
> you only the clicks in your chat app and the bot token.

## What you need

- **macOS or Linux**, ideally with [herdr](https://herdr.dev) already in use:
  herdr-core runs your agents, the herdr app holds your spaces and tabs. No
  herdr yet? `init` offers to install it with herdr's official installer.
- **Node 24** or newer (`node --version`).
- **A chat app** to talk to your agents from: **Discord** (an account and a
  server of your own) or **Telegram** (a group of your own). A new, empty one
  is best: the bot only touches what it creates, but access to it means
  running code on your computer, so keep it to yourself.

## 1. Install herdr-link

```sh
npm install -g @thl-ai/herdr-link
```

## 2. Connect a chat app

herdr-link talks to chat apps through **adapters**, small programs that
translate between herdr-link and one chat app. Two come with it: **Discord**
and **Telegram**. You can run both at once.

> **Using something else?** Slack, Matrix, your own: an adapter is
> any program, in any language, that speaks a small JSON-RPC protocol on
> stdin and stdout. [Writing an adapter](adapters.md) has the protocol, a
> 50-line example to start from, and how to plug it in. If you write one,
> tell us: it may well ship here next.

### Discord: create the bot

The one step you do by hand: Discord doesn't let programs create bots.

1. Open the [Discord Developer Portal](https://discord.com/developers/applications)
   and click **New Application**. Name it (say, `herdr`), accept the terms.
2. **Installation** → **Install Link** → **None**, then **Save Changes**.
3. **Bot**:
   - turn **Public Bot** off, so nobody else can add it;
   - leave **Requires OAuth2 Code Grant** off;
   - **Reset Token**, then copy the token. You will paste it in the next
     step; Discord shows it only once.
4. Optional: **Emojis** → upload your agents' logos named `claude` and `grok`.
   The bot uses them on its buttons and reactions.

You don't need to turn on intents or invite the bot yet: `init` does the
first and walks you through the second.

### Telegram: the bot and the group

Every herdr tab becomes a **topic** of one group of yours (named
`✳️space / tab`); your private chat with the bot is the control room.

1. Talk to [@BotFather](https://t.me/BotFather): `/newbot`, pick a name and a
   username ending in `bot`, copy the token. Put it in
   `~/.config/herdr-link/.env` as a line `TELEGRAM_TOKEN=…`.
2. Create a group and turn on **Topics** in its settings.
3. Add the bot to the group as an **admin** with **Manage topics** (it needs
   nothing else).
4. Back in BotFather: `/mybots` → your bot → **Bot Settings** → **Allow
   Groups?** → turn groups off, so nobody can add it anywhere else. It stays
   in yours.
5. Write something in the group, and press **Start** in your private chat with
   the bot (it can't write to you before that).
6. Run `herdr-link telegram`: it checks the group and prints the config
   section with your group's and your own ID.

`init` sets up Discord. For Telegram alone, skip `init`'s bot questions by
writing the config yourself: copy [`config.example.toml`](../config.example.toml)
to `~/.config/herdr-link/config.toml`, keep your agents, replace the Discord
section with the one `herdr-link telegram` printed, then run
`herdr-link hooks install` and `herdr-link service install`. To add Telegram
next to Discord, add the section and run `herdr-link service install`.

## 3. Run init

```sh
herdr-link init
```

It asks only what it can't find out. A typical run:

```
herdr-link setup: your herdr agents in Discord.

1. herdr
  ✓ herdr-core 0.1.17
  ✓ herdr-app

2. Discord bot
  Bot token: ••••••••
  ✓ bot herdr
  ✓ turned on the Message Content intent
  Are you alex? Only you will be able to drive the agents. [Y/n]
  ✗ the bot is not on any server yet
    Invite it to your own server (a new private server is best):
    https://discord.com/oauth2/authorize?client_id=…
  Press Enter once it is there.
  ✓ server Agents
  Do you run herdr-link on another computer with this server too? [y/N]

3. Agents
  ✓ claude, grok, shell

4. Config
  ✓ ~/.config/herdr-link/config.toml
  ✓ ~/.config/herdr-link/.env (only you can read it)

5. Agent hooks (their replies reach the chat through them)
  Install them for Claude Code and Grok? [Y/n]

6. Run it
  Run it in the background (launchd), starting at login? [Y/n]
```

What happens behind the questions:

- **herdr:** if herdr-core or the herdr app is missing, `init` offers to
  install them (herdr's official installer); a stopped herdr-core is started.
- **Token:** checked against Discord, and the **Message Content** intent
  (needed to read your messages) is turned on for you.
- **You:** the owner is found from the application, so you don't hunt for
  your user ID. Only this account can drive the agents.
- **Server:** if the bot isn't on one yet, open the invite link it prints,
  pick your server, **Authorize**, then press Enter. It asks only for what it
  needs: no Administrator.
- **Agents:** Claude Code and Grok are set up if they are on your PATH, with
  their Allow / Deny keys; a shell agent is always there.
- **Hooks:** let your agents' replies reach the chat. Restart running agent
  sessions afterwards: they read their hooks when they start.
- **Background:** a launchd agent on macOS or a systemd user unit on Linux, so
  herdr-link starts at login and comes back if it crashes.

## 4. Finish in your chat app

**Discord:** within a minute, each herdr space shows up as a private
category, with a channel per tab. Then:

1. **Notifications:** right-click each of the bot's categories → **Notification
   Settings** → **All Messages**, so your phone pings you.
2. **Commands:** **Server Settings** → **Integrations** → your bot → allow its
   commands only for yourself.
3. On your phone, install the Discord app and sign in.

**Telegram:** a topic per tab appears in your group; the commands are in the
bot's `/` menu. Nothing else to set.

## 5. Try it

- **Talk to an agent:** write in a tab's channel. 👀 means it was typed into
  the agent; its reply arrives in the same channel when it is done. On a long
  turn, one status message shows how long it has been working and its latest
  notes, edited in place (no extra pings).
- **Approve something:** when the agent asks for permission, the channel gets
  🔐 with **Allow**, **Allow always** and **Deny**.
- **Send a screenshot:** it lands beside the agent, which gets its path.
- **Start new work:** create a channel `✳️fix-login` in a space's category: a
  new tab opens with Claude. Without an emoji, the bot asks who works there.
  On Telegram, create a topic `✳️api / fix-login` (or just `fix-login`, and
  the bot asks which space); the message you create it with becomes the
  agent's first task. Closing or deleting a topic closes its tab.
- **Use the control room:** DM the bot a task and pick a space; a new tab
  starts on it. The DM also holds a live dashboard of every agent
  (`dashboard = false` in the adapter's section turns it off; `/status` still
  answers).
- **Commands:** `/status` anywhere, `/screen` in a tab's channel, `/space new`
  for a new herdr space.

## At the computer

```sh
herdr-link mod install
```

puts a small bar in the Herdr window: a dot (green: every chat app connected
and the hooks current; yellow: something to look at; red: herdr-link isn't
running), your chat apps, and a switch:

- **🖥 At the desk:** messages still arrive in the chat, without a push
  (Discord's silent messages, Telegram's `disable_notification`).
- **📱 Away:** every message pushes to your phone, as before.

Drag the bar where you like; it stays there and comes back after a restart
(command palette → herdr-link shows or hides it). Click it for the panel: turn
a chat app on or off, its live status in your DMs, update the hooks, restart,
run the doctor, read the log. Without Herdr the same is on the command line:

```sh
herdr-link desk on         # at the desk (off: away)
herdr-link status          # running? which chat apps are connected?
herdr-link adapter telegram off            # writes the config, restarts
herdr-link adapter discord dashboard off
```

## Keeping it running

```sh
herdr-link doctor          # is everything fine?
herdr-link doctor --fix    # repair what it can
herdr-link status          # what the running bridge says right now
herdr-link service logs    # what it has been doing
```

**Updating:** `npm install -g @thl-ai/herdr-link@latest`, then
`herdr-link service install` to restart on the new version.

**Removing:**

```sh
herdr-link mod uninstall
herdr-link service uninstall
herdr-link hooks uninstall
npm uninstall -g @thl-ai/herdr-link
rm -r ~/.config/herdr-link
```

The bot's categories stay in Discord until you delete them; delete the
application in the Developer Portal to remove the bot.

## Next

- [Configuration](configuration.md): every setting
- [Agents](agents.md): add another agent and find its keys
- [Troubleshooting](troubleshooting.md): when something doesn't work
