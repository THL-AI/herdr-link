# Install with an agent

Let the coding agent you already use set herdr-link up. Tell it:

```
Read https://thl-ai.github.io/herdr-link/install.md and install herdr-link for me.
```

It checks your computer, installs what's missing (asking first), walks you
through the bot, and checks that everything works at the end. The bot token
never goes through the agent: you type it into herdr-link yourself. The rest
of this page is written for the agent.

---

## For the agent

You are installing **herdr-link** for the person you work with. herdr-link
connects [herdr](https://herdr.dev) (a terminal app where coding agents run in
tabs) to Discord or Telegram: every herdr tab becomes a chat thread, agent
replies and permission prompts reach the owner's phone, and the owner answers
from there. Full human guide:
https://thl-ai.github.io/herdr-link/docs/getting-started.html

### Rules

- **Never ask for, read, print or store a bot token.** Whoever sees the token
  controls the bot, and the bot can type into the owner's terminals. The
  owner types it into `herdr-link init` or into
  `~/.config/herdr-link/.env` themselves. Don't `cat` that file.
- **Ask before installing anything** besides the npm package (herdr, Node).
- `herdr-link init` is **interactive** (a hidden token prompt, yes/no
  questions, "press Enter once the bot is on your server"). Don't run it from
  your shell tool: ask the owner to run it in a terminal of their own (a new
  herdr tab is fine) and to tell you when it's done.
- `herdr-link doctor` only looks, so run it freely. Its `--fix` asks
  questions (interactive again), and `--fix --yes` installs and starts things
  without asking: don't run either. Apply the fix each ✗ line names yourself,
  one at a time.
- Give the owner manual steps as a numbered list, one action per step.
- Talk to the owner in their language; the commands stay as they are.

### 1. Check the computer

```sh
uname -s              # Darwin or Linux; anything else: stop, it isn't supported
node --version        # needs v24 or newer
hc --version          # herdr-core
command -v herdr-app  # the herdr app
```

- **Node older than 24:** tell the owner; if they use nvm,
  `nvm install 24 && nvm alias default 24` (ask first).
- **No herdr:** ask, then run herdr's official installers:
  `curl -fsSL https://releases.herdr.dev/core/install.sh | sh` (core) and
  `curl -fsSL https://releases.herdr.dev/app/install.sh | sh` (app). The
  owner opens the herdr app once afterwards.
- **herdr-core installed but not running** (`hc server status` says so):
  `hc server start`.

### 2. Install the package

```sh
npm install -g @thl-ai/herdr-link
herdr-link --version
```

### 3. Pick a chat app

Ask the owner: **Discord** or **Telegram**? (Both is fine: set up Discord
first, then add Telegram.) A new, empty server or group of their own is best:
access to it means running code on their computer.

### 4a. Discord

Give the owner these steps (Discord doesn't let programs create bots):

1. Open https://discord.com/developers/applications → **New Application**,
   name it (say `herdr`), accept the terms.
2. **Installation** → **Install Link** → **None** → **Save Changes**.
3. **Bot**: turn **Public Bot** off, leave **Requires OAuth2 Code Grant**
   off, click **Reset Token** and copy the token (Discord shows it once).
   Don't paste it to me.
4. In a terminal of your own, run `herdr-link init`, paste the token when it
   asks, and answer its questions (Enter takes the default). When it prints
   an invite link, open it, pick your server, **Authorize**, then press
   Enter.
5. Tell me when it's finished.

`init` turns on the intent the bot needs, finds the owner and the server,
picks up the agents on PATH, writes the config and the `.env`, installs the
agent hooks and the background service. Then go to step 5.

### 4b. Telegram

`init` only does Discord; for Telegram you write the config.

1. Prepare the secrets file (no token in it yet):

   ```sh
   mkdir -p ~/.config/herdr-link && touch ~/.config/herdr-link/.env && chmod 600 ~/.config/herdr-link/.env
   ```

2. Give the owner these steps:
   1. In Telegram, talk to @BotFather: `/newbot`, pick a name and a username
      ending in `bot`, copy the token. Don't paste it to me.
   2. Open `~/.config/herdr-link/.env` and add a line
      `TELEGRAM_TOKEN=<the token>`.
   3. Create a group and turn on **Topics** in its settings.
   4. Add the bot to the group as an **admin** with **Manage topics**.
   5. In BotFather: `/mybots` → your bot → **Bot Settings** → **Allow
      Groups?** → turn groups off (it stays in your group).
   6. Write any message in the group, then open your private chat with the
      bot and press **Start**.
   7. Tell me when it's done.

3. Run `herdr-link telegram`. It checks the group (Topics on, the bot an
   admin) and prints an `[adapters.telegram]` section with the group and
   owner ids. If it reports a problem, give the owner the fix it names.
4. Write `~/.config/herdr-link/config.toml`: start from the example in the
   package (`"$(npm root -g)/@thl-ai/herdr-link/config.example.toml"`),
   replace the `[adapters.discord]` section with the printed Telegram
   section, and keep only the agents that are on PATH (`claude`, `grok`; the
   `shell` agent always stays). If the owner already has a config (Discord),
   add the Telegram section to it instead.
5. Install the rest:

   ```sh
   herdr-link hooks install
   herdr-link service install
   ```

### 5. The bar in the Herdr window

If the herdr app is installed:

```sh
herdr-link mod install
```

It shows a small bar in the Herdr window: whether the link works, and a
switch between **at the desk** (messages arrive without a push) and **away**.

### 6. Check

```sh
herdr-link doctor
herdr-link status
```

Every line of `doctor` should be ✓, and `status` should show the chat app
connected. A ✗ line says what to run (`herdr-link hooks install`,
`herdr-link service install`, `hc server start`, `herdr-link init`…); run it
(`init` the owner runs, see the rules) and check again. If editing
`~/.claude/settings.json` for the hooks is refused by your permissions, ask
the owner to run `herdr-link hooks install` themselves.

### 7. Tell the owner what's next

1. Restart running agent sessions (yours too): agents read their hooks when
   they start.
2. **Discord:** right-click each of the bot's categories → **Notification
   Settings** → **All Messages**, so the phone pings. **Server Settings** →
   **Integrations** → the bot → allow its commands only for themselves.
3. Install the chat app on the phone and sign in.
4. Try it: write in a tab's channel or topic; 👀 means it reached the agent,
   and the reply arrives there when the agent is done.

More: https://thl-ai.github.io/herdr-link/docs/getting-started.html (Try it,
At the computer, Keeping it running) and
https://thl-ai.github.io/herdr-link/docs/troubleshooting.html
