# Getting started

From nothing to answering your agents from your phone, in about ten minutes.
This guide uses the built-in Discord adapter; other chat apps plug in through
[their own adapters](adapters.md).

## What you need

- **macOS or Linux**, ideally with [herdr](https://herdr.dev) already in use:
  herdr-core runs your agents, the herdr app holds your spaces and tabs. No
  herdr yet? `init` offers to install it with herdr's official installer.
- **Node 24** or newer (`node --version`).
- **A Discord account** and a server of your own. A new, empty server is
  best: the bot only touches what it creates, but channel access means
  running code on your computer, so keep it to yourself.

## 1. Install herdr-link

```sh
npm install -g @thl-ai/herdr-link
```

## 2. Create the bot

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

## 4. Finish in Discord

Within a minute, each herdr space shows up as a private category, with a
channel per tab. Then:

1. **Notifications:** right-click each of the bot's categories → **Notification
   Settings** → **All Messages**, so your phone pings you.
2. **Commands:** **Server Settings** → **Integrations** → your bot → allow its
   commands only for yourself.
3. On your phone, install the Discord app and sign in.

## 5. Try it

- **Talk to an agent:** write in a tab's channel. 👀 means it was typed into
  the agent; its reply arrives in the same channel when it is done.
- **Approve something:** when the agent asks for permission, the channel gets
  🔐 with **Allow**, **Allow always** and **Deny**.
- **Send a screenshot:** it lands beside the agent, which gets its path.
- **Start new work:** create a channel `✳️fix-login` in a space's category: a
  new tab opens with Claude. Without an emoji, the bot asks who works there.
- **Use the control room:** DM the bot a task and pick a space; a new tab
  starts on it. The DM also holds a live dashboard of every agent.
- **Commands:** `/status` anywhere, `/screen` in a tab's channel, `/space new`
  for a new herdr space.

## Keeping it running

```sh
herdr-link doctor          # is everything fine?
herdr-link doctor --fix    # repair what it can
herdr-link service logs    # what it has been doing
```

**Updating:** `npm install -g @thl-ai/herdr-link@latest`, then
`herdr-link service install` to restart on the new version.

**Removing:**

```sh
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
