// herdr-link in the Herdr window: a small bar (its own window, kept where you
// drop it) that says whether the link to
// your chat app works, and a switch for "at the desk" (messages still arrive,
// without a push) or "away" (pushes on). A click on the bar opens the panel:
// adapters on/off, their live dashboard, hooks, restart, doctor, log.
//
// Installed by `herdr-link mod install`, which writes ./link.js (where node,
// herdr-link and its state folder are). It reads the bridge's status.json and
// state.json, writes state.json for the switch, and runs herdr-link for the
// rest. One mod, two roles: the bar (layout) and the panel (props.panel).

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, openOverlay, props, readTextFile, settings, theme, watchFolder, writeTextFile } from "herdr";
import { link } from "./link.js";

const staleAfterMs = 90_000;
const panelWidth = 380;
const statusFile = `${link.state}/status.json`;
const stateFile = `${link.state}/state.json`;

const label = (name) => name.charAt(0).toUpperCase() + name.slice(1);

const parse = (text) => {
  try {
    return text == null ? null : JSON.parse(text);
  } catch {
    return null;
  }
};

const ago = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 129600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
};

export default class HerdrLink extends View {
  init(_props, cx) {
    this.status = null;
    this.stateText = null;
    this.desk = false;
    this.busy = null; // what runs now, shown instead of the buttons' labels
    this.output = null; // { title, text } from doctor or the log
    this.pressed = null; // the bar's bounds at the last press, to place the panel
    this.reload(cx);
    // Instant on a change; the timer only notices a bridge that stopped writing.
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          await watchFolder(link.state);
        } catch {
          return; // no folder yet: the timer keeps looking
        }
        await this.read();
        cx.notify();
      }
    });
    cx.timer.every(20_000, (cx) => this.reload(cx));
  }

  reload(cx) {
    cx.spawn(async (cx) => {
      await this.read();
      cx.notify();
    });
  }

  async read() {
    this.status = parse(await readTextFile(statusFile).catch(() => null));
    this.stateText = await readTextFile(stateFile).catch(() => null);
    this.desk = parse(this.stateText)?.desk === true;
  }

  alive() {
    const s = this.status;
    return s != null && s.running && Date.now() - Date.parse(s.updated) < staleAfterMs;
  }

  /** "ok" | "partly" | "down": the bar's dot. */
  health() {
    if (!this.alive()) return "down";
    const s = this.status;
    const adapters = s.adapters.filter((a) => a.enabled);
    const hooks = Object.values(s.hooks ?? {}).filter((h) => h !== "absent");
    if (adapters.length === 0 || adapters.some((a) => !a.connected) || hooks.some((h) => h !== "ok")) return "partly";
    return "ok";
  }

  async setDesk(on, cx) {
    const state = { ...(parse(this.stateText) ?? {}), desk: on };
    this.desk = on;
    cx.notify();
    try {
      await writeTextFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, this.stateText);
    } catch {
      // Changed meanwhile (the CLI?): through herdr-link, which merges.
      await exec(link.node, [link.bin, "desk", on ? "on" : "off"]).catch(() => null);
    }
    await this.read();
    cx.notify();
  }

  /** Runs herdr-link with these arguments; `show` puts its output in the panel. */
  run(args, cx, busy, show) {
    if (this.busy) return;
    this.busy = busy;
    cx.notify();
    cx.spawn(async (cx) => {
      let text;
      try {
        const r = await exec(link.node, [link.bin, ...args]);
        text = `${r.stdout}${r.stderr}`.trim();
      } catch (error) {
        text = `cannot run herdr-link: ${error}`;
      }
      this.busy = null;
      if (show) this.output = { title: show, text: text || "(nothing)" };
      await this.read();
      cx.notify();
    });
  }

  render(cx) {
    return props()?.panel ? this.panel(cx) : this.bar(cx);
  }

  bar(cx) {
    const t = theme();
    const s = this.status;
    const health = this.health();
    const dot = { ok: t.ansi2, partly: t.ansi3, down: t.ansi1 }[health];
    const parts = [];
    if (health === "down") {
      parts.push(s == null ? "not set up" : s.running ? `not answering for ${ago(s.updated)}` : "stopped");
    } else {
      for (const a of s.adapters.filter((a) => a.enabled)) {
        parts.push(div().text_color(a.connected ? t.muted : t.blocked).child(`${label(a.name)} ${a.connected ? "✓" : "✗"}`));
      }
      if (Object.values(s.hooks ?? {}).some((h) => h !== "ok" && h !== "absent")) {
        parts.push(div().text_color(t.blocked).child("hooks need updating"));
      }
    }
    // The panel opens under the bar. "pointer" would be wrong here: the app knows the pointer
    // of its main view, not of this floating window.
    const open = (_e, cx) => {
      cx.stop_propagation();
      openOverlay({ mod: "herdr-link", props: { panel: true }, kind: "popup", width: panelWidth, at: this.panelAt() });
    };
    // A small window of its own (mod.json), kept across restarts: the grip drags it (presses
    // on the controls stop, so they don't).
    return h_flex().id("herdr-link-bar").h(28).pl(6).pr(4).gap(10).items_center().rounded(14)
      .bg(t.chrome).border_1().border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(div().id("herdr-link-grip").px(4).text_color(t.dim).cursor_grab().child("⠿"))
      .child(
        h_flex().id("herdr-link-open").gap(8).items_center().cursor_pointer().hover((st) => st.text_color(t.foreground))
          .on_mouse_down("left", (e, cx) => {
            cx.stop_propagation();
            this.pressed = e.bounds ?? null; // where the bar is, in the window
          })
          .on_click(open)
          .child(div().size(7).rounded(4).bg(dot))
          .child(div().text_color(t.foreground).child("herdr-link"))
          .children(parts),
      )
      .child(this.deskSwitch(cx, t));
  }

  /** Below the bar: right-aligned to it on the window's right side, else left-aligned. */
  panelAt() {
    const b = this.pressed;
    if (b == null) return "pointer";
    const x = b.x > panelWidth ? b.x + b.width - panelWidth : b.x;
    return { x: Math.max(8, Math.round(x)), y: Math.round(b.y + b.height + 8) };
  }

  deskSwitch(cx, t) {
    return h_flex().id("herdr-link-desk").gap(6).items_center().px(8).h(20).rounded(10).cursor_pointer()
      .bg(this.desk ? t.raised : t.chrome).border_1().border_color(this.desk ? t.border : t.chrome)
      .hover((st) => st.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        cx.spawn(async (cx) => this.setDesk(!this.desk, cx));
      })
      .child(this.desk ? "🖥 At the desk · no pushes" : "📱 Away · pushes on");
  }

  panel(cx) {
    const t = theme();
    const s = this.status;
    const alive = this.alive();
    const button = (id, text, onClick, primary = false) =>
      h_flex().id(id).h(24).px(10).items_center().rounded(6).cursor_pointer()
        .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
        .hover((st) => st.opacity(0.85))
        .on_click((_e, cx) => onClick(cx))
        .child(text);
    const row = (left, right) => h_flex().gap(8).items_center().min_h(26).child(div().flex_1().min_w(0).child(left)).child(right);
    const heading = (text) => div().pt(6).text_size(11).text_color(t.dim).child(text);

    const head = !s
      ? "Not set up yet: run herdr-link init"
      : alive
      ? `${s.version} · running ${ago(s.started)} · pid ${s.pid}`
      : s.running
      ? `Not answering for ${ago(s.updated)}`
      : `Stopped ${ago(s.updated)} ago`;

    const adapters = (s?.adapters ?? []).map((a) => {
      const state = !a.enabled ? "off" : !alive ? "—" : a.connected ? "connected" : a.error ? a.error : "connecting…";
      return row(
        v_flex().child(div().text_color(t.foreground).child(label(a.name)))
          .child(div().text_size(11).text_color(a.enabled && alive && !a.connected ? t.blocked : t.dim).truncate().child(state)),
        h_flex().gap(6)
          .when(a.enabled, (el) =>
            el.child(button(`dash-${a.name}`, a.dashboard ? "DM status: on" : "DM status: off", (cx) =>
              this.run(["adapter", a.name, "dashboard", a.dashboard ? "off" : "on"], cx, "restarting…"))))
          .child(button(`on-${a.name}`, a.enabled ? "Turn off" : "Turn on", (cx) =>
            this.run(["adapter", a.name, a.enabled ? "off" : "on"], cx, "restarting…"), !a.enabled)),
      );
    });

    const hooks = Object.entries(s?.hooks ?? {}).filter(([, h]) => h !== "absent");
    const hooksOk = hooks.every(([, h]) => h === "ok");

    return v_flex().id("herdr-link-panel").size_full().min_h(0).p(14).gap(4).bg(t.popover).text_size(12.5).text_color(t.muted)
      .child(h_flex().items_center().gap(8)
        .child(div().size(8).rounded(4).bg({ ok: t.ansi2, partly: t.ansi3, down: t.ansi1 }[this.health()]))
        .child(div().flex_1().text_size(14).font_semibold().text_color(t.foreground).child("herdr-link"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().text_size(11.5).child(head))
      .child(heading("WHERE YOU ARE"))
      .child(row(
        div().child(this.desk ? "At the desk: messages arrive without a push" : "Away: every message pushes to your phone"),
        this.deskSwitch(cx, t),
      ))
      .child(heading("CHAT APPS"))
      .children(adapters.length > 0 ? adapters : [div().child("No adapters in the config")])
      .when(hooks.length > 0, (el) =>
        el.child(heading("AGENT HOOKS")).child(row(
          div().child(hooks.map(([agent, h]) => `${label(agent)} ${h === "ok" ? "✓" : h}`).join(" · ")),
          hooksOk ? div() : button("hooks", "Update", (cx) => this.run(["hooks", "install"], cx, "updating…", "Hooks"), true),
        )))
      .child(h_flex().pt(10).gap(6)
        .child(button("restart", "Restart", (cx) => this.run(["service", "restart"], cx, "restarting…")))
        .child(button("doctor", "Doctor", (cx) => this.run(["doctor"], cx, "checking…", "Doctor")))
        .child(button("log", "Log", (cx) => this.run(["service", "logs"], cx, "reading…", "Log")))
        .child(div().flex_1())
        .when(Boolean(this.busy), (el) => el.child(div().text_size(11).text_color(t.dim).child(this.busy))))
      .when(Boolean(this.output), (el) =>
        el.child(v_flex().mt(8).flex_1().min_h(0).max_h(260).p(8).rounded(6).bg(t.background)
          .child(h_flex().items_center().child(div().flex_1().text_size(11).text_color(t.dim).child(this.output.title))
            .child(div().id("close-output").text_size(11).text_color(t.dim).cursor_pointer().on_click((_e, cx) => {
              this.output = null;
              cx.notify();
            }).child("✕")))
          .child(div().id("output").flex_1().min_h(0).overflow_y_scrollbar().font_family(settings().font_family ?? "JetBrains Mono")
            .text_size(11).text_color(t.foreground).child(this.output.text))));
  }
}
