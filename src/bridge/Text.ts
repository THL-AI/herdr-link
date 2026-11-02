/**
 * Splits text into messages of at most `max` characters: at a blank line,
 * else a line break, else a space, else hard. A code block cut in two is
 * closed at the end of one part and reopened (same language) in the next.
 */
const fence = /^(\s*)(```+|~~~+)(.*)$/

/** The fence still open at the end of `text`, e.g. "```ts", or undefined. */
const openFence = (text: string): string | undefined => {
  let open: string | undefined
  for (const line of text.split("\n")) {
    const match = fence.exec(line)
    if (match === null) continue
    open = open === undefined ? `${match[2]}${match[3]?.trim() ?? ""}` : undefined
  }
  return open
}

const cutAt = (text: string, max: number) => {
  const window = text.slice(0, max)
  for (const separator of ["\n\n", "\n", " "]) {
    const at = window.lastIndexOf(separator)
    if (at > max / 2) return at
  }
  return max
}

export const chunk = (text: string, max: number): Array<string> => {
  const parts: Array<string> = []
  let rest = text.trim()
  let reopen = ""
  // Leave room for a closing fence and a reopened one.
  const room = Math.max(max - 16, 1)
  while (rest !== "") {
    const body = reopen + rest
    if (body.length <= max) {
      parts.push(body)
      break
    }
    const at = cutAt(body, room)
    let part = body.slice(0, at).trimEnd()
    const open = openFence(part)
    if (open !== undefined) part += "\n```"
    parts.push(part)
    rest = body.slice(at).replace(/^(\n+| )/, "")
    reopen = open === undefined ? "" : `${open}\n`
  }
  return parts
}
