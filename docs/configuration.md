# Configuration

`herdr-link init` writes all of this for you. This page is the reference.

## Files

| what | where |
| --- | --- |
| config | `~/.config/herdr-link/config.toml` (or `$HERDR_LINK_CONFIG`, or `herdr-link run <path>`) |
| secrets | `~/.config/herdr-link/.env` (`KEY=value` lines, readable only by you) |
| hook socket | `~/.local/state/herdr-link/hooks.sock` (or `$HERDR_LINK_SOCKET`) |
| logs | macOS: `~/Library/Logs/herdr-link.log`; Linux: `journalctl --user -u herdr-link` |
| state | herdr-core's own document store (doc `herdr-link`): which room and thread belong to which space and tab |

Unknown keys are an error, so a typo doesn't go unnoticed. Secrets never go in
the TOML.

## config.toml

```toml
machine = "laptop"   # optional

[adapters.discord]
command = ["herdr-link-discord"]
env = ["DISCORD_TOKEN"]
owner = "123456789012345678"
guild = "123456789012345678"

[agents.claude]
template = "claude"
emoji = "✳️"
logo = "claude"
allow = ["1"]
always = ["2"]
deny = ["esc"]
```

### `machine`

Only when herdr-link runs on several computers with the same chat server (each
with its own bot): this computer's name, added to its room names
(`api · laptop`) and to its archive. Spaces on another herdr machine
(`hc machine add`) get that machine's name without it.

### `[adapters.<name>]`

One section per chat app. The bridge starts each as its own process.

| key | |
| --- | --- |
| `command` | the adapter's argv. Built-in adapters are named by their command (`herdr-link-discord`) and need nothing on PATH. |
| `env` | environment variables the adapter may see, besides `PATH`, `HOME`, `USER`, `LANG`…: its token, for instance. Values come from your environment or the `.env` file. |
| anything else | sent to the adapter in `hello`: its own settings. |

The Discord adapter's settings:

| key | |
| --- | --- |
| `owner` | your Discord user ID: the only person the bot listens to |
| `guild` | the server ID where your spaces become categories |

Other adapters document their own; see [writing an adapter](adapters.md).

### `[agents.<name>]`

| key | |
| --- | --- |
| `template` or `argv` | exactly one: how a new tab starts the agent. `template = "claude"` runs `claude`; `argv` is a full command. |
| `emoji` | a Unicode emoji, used in thread names (`✳️api`) and to pick the agent when you create a thread or start a message with it |
| `logo` | optional: the name of a custom emoji your chat app has for this agent (on Discord, an application emoji) |
| `allow`, `always`, `deny`, `trust` | keys that answer the agent's permission prompt; a button appears for each one set |

See [agents](agents.md) for how to find the right keys.
