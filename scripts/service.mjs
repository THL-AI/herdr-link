#!/usr/bin/env node
// The bridge as a launchd agent: starts at login, restarts when it dies.
//   node scripts/service.mjs install | uninstall | status
// Runs through the owner's interactive zsh, like a herdr tab, so nvm's node is on PATH.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const label = "local.herdr-link"
const repo = join(dirname(fileURLToPath(import.meta.url)), "..")
const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`)
const log = join(homedir(), "Library", "Logs", "herdr-link.log")
const domain = `gui/${userInfo().uid}`

const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
const launchctl = (...args) => {
  try {
    return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch (error) {
    return error.stdout ?? ""
  }
}

const install = () => {
  mkdirSync(dirname(plist), { recursive: true })
  mkdirSync(dirname(log), { recursive: true })
  const command = `exec node '${join(repo, "bin", "herdr-link.mjs")}'`
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lic</string><string>${escape(command)}</string></array>
  <key>WorkingDirectory</key><string>${escape(repo)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escape(log)}</string>
  <key>StandardErrorPath</key><string>${escape(log)}</string>
</dict>
</plist>
`)
  launchctl("bootout", `${domain}/${label}`)
  launchctl("bootstrap", domain, plist)
  console.log(`installed ${plist}\nlogs: ${log}`)
}

const uninstall = () => {
  launchctl("bootout", `${domain}/${label}`)
  rmSync(plist, { force: true })
  console.log(`removed ${plist}`)
}

const status = () => {
  if (!existsSync(plist)) return console.log("not installed")
  const info = launchctl("print", `${domain}/${label}`)
  const pick = (key) => info.match(new RegExp(`\\n\\s*${key} = (.*)`))?.[1] ?? "?"
  console.log(`state: ${pick("state")}, pid: ${pick("pid")}, last exit: ${pick("last exit code")}`)
  if (existsSync(log)) console.log(readFileSync(log, "utf8").trim().split("\n").slice(-8).join("\n"))
}

const action = process.argv[2]
if (action === "install") install()
else if (action === "uninstall") uninstall()
else if (action === "status") status()
else console.log("usage: service.mjs install | uninstall | status")
