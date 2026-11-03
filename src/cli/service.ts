/**
 * The bridge as a user service: a launchd agent on macOS, a systemd user unit
 * on Linux. It runs through the user's login shell (so tools like
 * `herdr-app`, nvm and pnpm are on PATH) with this Node and this install.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { binFile } from "./paths.ts"

const label = "local.herdr-link"
const unitName = "herdr-link.service"

export interface Target {
  readonly shell: string
  readonly node: string
  readonly bin: string
  readonly home: string
}

export const currentTarget = (): Target => ({
  shell: process.env.SHELL || "/bin/sh",
  node: process.execPath,
  bin: binFile,
  home: homedir()
})

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
const command = (target: Target) => `exec ${quote(target.node)} ${quote(target.bin)} run`
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

export const launchdLog = (home: string) => join(home, "Library", "Logs", "herdr-link.log")

export const launchdPlist = (target: Target) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(target.shell)}</string><string>-lic</string><string>${xml(command(target))}</string></array>
  <key>WorkingDirectory</key><string>${xml(target.home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(launchdLog(target.home))}</string>
  <key>StandardErrorPath</key><string>${xml(launchdLog(target.home))}</string>
</dict>
</plist>
`

export const systemdUnit = (target: Target) => `[Unit]
Description=herdr-link: herdr agents in your chat app
After=network-online.target

[Service]
ExecStart=${target.shell} -lic ${quote(command(target)).replaceAll("%", "%%")}
WorkingDirectory=%h
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const run = (file: string, args: ReadonlyArray<string>) => {
  try {
    return { ok: true, output: execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` }
  }
}

const launchd = () => {
  const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`)
  const domain = `gui/${userInfo().uid}`
  return {
    install: () => {
      mkdirSync(dirname(plist), { recursive: true })
      mkdirSync(dirname(launchdLog(homedir())), { recursive: true })
      writeFileSync(plist, launchdPlist(currentTarget()))
      run("launchctl", ["bootout", `${domain}/${label}`])
      // bootout returns before the old agent is gone; bootstrap fails (5: I/O error) until it is.
      let loaded = run("launchctl", ["bootstrap", domain, plist])
      for (let attempt = 0; !loaded.ok && attempt < 10; attempt++) {
        sleep(500)
        loaded = run("launchctl", ["bootstrap", domain, plist])
      }
      if (!loaded.ok) throw new Error(`launchctl bootstrap failed: ${loaded.output.trim()}`)
      return [`launchd agent ${label} (${plist})`, `logs: ${launchdLog(homedir())}`]
    },
    uninstall: () => {
      run("launchctl", ["bootout", `${domain}/${label}`])
      rmSync(plist, { force: true })
      return [`removed ${plist}`]
    },
    restart: () => {
      const restarted = run("launchctl", ["kickstart", "-k", `${domain}/${label}`])
      if (!restarted.ok) throw new Error(`launchctl kickstart failed: ${restarted.output.trim()}`)
      return [`restarted ${label}`]
    },
    status: () => {
      if (!existsSync(plist)) return { installed: false, running: false, details: "not installed" }
      const info = run("launchctl", ["print", `${domain}/${label}`]).output
      const pick = (key: string) => info.match(new RegExp(`\\n\\s*${key} = (.*)`))?.[1] ?? "?"
      return { installed: true, running: pick("state") === "running", details: `${pick("state")}, pid ${pick("pid")}` }
    },
    logs: () => {
      const log = launchdLog(homedir())
      return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").slice(-15).join("\n") : ""
    }
  }
}

const systemd = () => {
  const unit = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", unitName)
  const systemctl = (...args: Array<string>) => run("systemctl", ["--user", ...args])
  return {
    install: () => {
      mkdirSync(dirname(unit), { recursive: true })
      writeFileSync(unit, systemdUnit(currentTarget()))
      systemctl("daemon-reload")
      const started = systemctl("enable", "--now", unitName)
      if (!started.ok) throw new Error(`systemctl --user enable failed: ${started.output.trim()}`)
      systemctl("restart", unitName)
      return [
        `systemd user unit ${unit}`,
        `logs: journalctl --user -u ${unitName}`,
        "to keep it running while you are logged out: loginctl enable-linger"
      ]
    },
    uninstall: () => {
      systemctl("disable", "--now", unitName)
      rmSync(unit, { force: true })
      systemctl("daemon-reload")
      return [`removed ${unit}`]
    },
    restart: () => {
      const restarted = systemctl("restart", unitName)
      if (!restarted.ok) throw new Error(`systemctl --user restart failed: ${restarted.output.trim()}`)
      return [`restarted ${unitName}`]
    },
    status: () => {
      if (!existsSync(unit)) return { installed: false, running: false, details: "not installed" }
      const state = systemctl("is-active", unitName).output.trim()
      return { installed: true, running: state === "active", details: state }
    },
    logs: () => run("journalctl", ["--user", "-u", unitName, "-n", "15", "--no-pager"]).output.trim()
  }
}

export const manager = () => {
  if (process.platform === "darwin") return { name: "launchd", ...launchd() }
  if (process.platform === "linux") return { name: "systemd", ...systemd() }
  throw new Error(`no service manager for ${process.platform}: run \`herdr-link run\` yourself`)
}
