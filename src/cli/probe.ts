/** Quick checks of the local herdr setup. */
import { execFileSync } from "node:child_process"
import { connect } from "node:net"
import { coreSocket } from "./paths.ts"

/** herdr-core's version, or why it is not reachable. */
export const core = (): Promise<{ ok: true; version: string } | { ok: false; error: string }> =>
  new Promise((resolve) => {
    const socket = connect(coreSocket)
    const timer = setTimeout(() => done({ ok: false, error: "no answer from herdr-core" }), 3000)
    let buffer = ""
    const done = (result: { ok: true; version: string } | { ok: false; error: string }) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    socket.on("error", (error) => done({ ok: false, error: `${coreSocket}: ${error.message}` }))
    socket.on("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { generation: 1 } })}\n`))
    socket.on("data", (chunk) => {
      buffer += chunk.toString()
      const line = buffer.split("\n")[0]
      if (!buffer.includes("\n") || line === undefined) return
      try {
        const reply = JSON.parse(line)
        done(reply.result ? { ok: true, version: reply.result.version } : { ok: false, error: JSON.stringify(reply.error) })
      } catch {
        done({ ok: false, error: "unexpected answer from herdr-core" })
      }
    })
  })

/** Whether a program is on PATH. */
export const onPath = (program: string) => {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${program}`], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}
