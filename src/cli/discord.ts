/** The few Discord REST calls `init` and `doctor` need (bot token auth). */
const api = "https://discord.com/api/v10"

/** View Channels, Send Messages, Send Messages in Threads, Read Message History, Attach Files, Add Reactions, Manage Channels, Manage Roles. */
export const permissions = "275146443856"

export const inviteUrl = (applicationId: string) =>
  `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot+applications.commands&permissions=${permissions}`

const MESSAGE_CONTENT = 1 << 18
const MESSAGE_CONTENT_LIMITED = 1 << 19

export class DiscordError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const call = async <A>(token: string, path: string, init: RequestInit = {}): Promise<A> => {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", ...init.headers }
  })
  if (!response.ok) {
    const body = await response.text()
    throw new DiscordError(response.status, `${response.status} ${response.statusText}: ${body.slice(0, 200)}`)
  }
  return (await response.json()) as A
}

export interface Application {
  readonly id: string
  readonly name: string
  readonly bot_public: boolean
  readonly flags?: number
  readonly owner?: { readonly id: string; readonly username: string }
  readonly team?: {
    readonly owner_user_id: string
    readonly members: ReadonlyArray<{ readonly user: { readonly id: string; readonly username: string } }>
  } | null
}

export const me = (token: string) => call<{ id: string; username: string }>(token, "/users/@me")
export const application = (token: string) => call<Application>(token, "/applications/@me")
export const guilds = (token: string) => call<ReadonlyArray<{ id: string; name: string }>>(token, "/users/@me/guilds")

export const hasMessageContent = (app: Application) => ((app.flags ?? 0) & (MESSAGE_CONTENT | MESSAGE_CONTENT_LIMITED)) !== 0

/** The person who owns the application (or its team). */
export const owner = (app: Application) => {
  if (app.team) {
    const member = app.team.members.find((m) => m.user.id === app.team!.owner_user_id)
    return { id: app.team.owner_user_id, username: member?.user.username ?? app.team.owner_user_id }
  }
  return app.owner
}

/** Turns the Message Content intent on, as the portal's switch does for unverified apps. */
export const enableMessageContent = (token: string, app: Application) =>
  call<Application>(token, "/applications/@me", {
    method: "PATCH",
    body: JSON.stringify({ flags: (app.flags ?? 0) | MESSAGE_CONTENT_LIMITED })
  })
