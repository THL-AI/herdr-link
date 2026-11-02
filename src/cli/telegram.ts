/**
 * `herdr-link telegram`: finds what the Telegram adapter's config section
 * needs. With TELEGRAM_TOKEN set (environment or `.env`), it reads the bot's
 * recent updates: the groups it is in (with topics on? an admin who can manage
 * topics?) and who wrote there, and prints the section to paste.
 *
 * It reads updates without confirming them, so a running bridge still gets
 * them. Don't run it while the Telegram adapter runs: one reader at a time.
 */
import * as Config from "./config.ts"
import { envFile } from "./paths.ts"
import { bad, note, ok } from "./prompt.ts"

interface Chat {
  readonly id: number
  readonly type: string
  readonly title?: string
  readonly is_forum?: boolean
}
interface Message {
  readonly chat: Chat
  readonly from?: { readonly id: number; readonly is_bot: boolean; readonly first_name: string; readonly username?: string }
}

export const telegram = async () => {
  const token = process.env.TELEGRAM_TOKEN ?? Config.readEnv(envFile, "TELEGRAM_TOKEN")
  if (token === undefined || token === "") {
    bad(`no TELEGRAM_TOKEN: put it in ${envFile} (TELEGRAM_TOKEN=…), from @BotFather`)
    return 1
  }
  const call = async <A>(method: string, params: object = {}): Promise<A> => {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params)
    })
    const body = await response.json() as { ok: boolean; result: A; description?: string }
    if (!body.ok) throw new Error(`${method}: ${body.description ?? response.status}`)
    return body.result
  }

  const me = await call<{ id: number; username: string }>("getMe")
  ok(`bot @${me.username}`)
  const updates = await call<ReadonlyArray<{ message?: Message; my_chat_member?: Message }>>("getUpdates", {
    allowed_updates: ["message", "my_chat_member"]
  }).catch((error: Error) => {
    if (error.message.includes("Conflict")) {
      throw new Error("something else reads this bot's updates (a running herdr-link?): stop it and try again")
    }
    throw error
  })

  const groups = new Map<number, Chat>()
  const people = new Map<number, string>()
  for (const update of updates) {
    const message = update.message ?? update.my_chat_member
    if (message === undefined) continue
    if (message.chat.type === "supergroup" || message.chat.type === "group") groups.set(message.chat.id, message.chat)
    if (message.from !== undefined && !message.from.is_bot) {
      people.set(message.from.id, `${message.from.first_name}${message.from.username ? ` (@${message.from.username})` : ""}`)
    }
  }
  if (groups.size === 0 || people.size === 0) {
    bad("nothing seen yet")
    note("Add the bot to your group as an admin with Manage topics, write something there,")
    note("press Start in the bot's private chat, then run herdr-link telegram again.")
    return 1
  }

  let good: Chat | undefined
  for (const group of groups.values()) {
    const member = await call<{ status: string; can_manage_topics?: boolean }>("getChatMember", {
      chat_id: group.id,
      user_id: me.id
    }).catch(() => undefined)
    const problems = [
      group.type === "supergroup" && group.is_forum === true ? undefined : "turn on Topics in the group's settings",
      member?.status === "administrator" && member.can_manage_topics === true ? undefined : "make the bot an admin with Manage topics"
    ].filter((p) => p !== undefined)
    if (problems.length === 0) {
      ok(`group ${group.title ?? group.id} (${group.id})`)
      good ??= group
    } else bad(`group ${group.title ?? group.id} (${group.id}): ${problems.join("; ")}`)
  }
  for (const [id, name] of people) ok(`${name}: user id ${id}`)

  const owner = people.size === 1 ? String([...people.keys()][0]) : "<your user id, from the list above>"
  console.log(`\nAdd to ~/.config/herdr-link/config.toml:\n
[adapters.telegram]
command = ["herdr-link-telegram"]
env = ["TELEGRAM_TOKEN"]
owner = "${owner}"
group = "${good?.id ?? "<the group id, once it is fixed>"}"
`)
  note("Then restart herdr-link: herdr-link service install")
  return good === undefined ? 1 : 0
}
