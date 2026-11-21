// herdr-context: what is in the focused agent's context window, and how much
// of each subscription is left. Drawing only; the numbers come from the
// herdr-context CLI bundled next to this file (cli/), run through exec().
//
// props: { view: "chip" } draws a one-line status-bar chip instead of the panel.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, appHome, readTextFile, theme, focused, panes, props, checking, layout, run, shared, setShared } from "herdr";
import { choosePane, pickSession, fmt, pctText, sparkline, resetsIn, ago, level, worstWindow, makeup, chipText, baseName, errorLine, panelState, toggleCommands } from "./logic.js";
import { SAMPLE_SESSIONS, SAMPLE_QUOTA } from "./sample.js";

const CONTEXT_EVERY_MS = 15_000;
const QUOTA_EVERY_MS = 120_000;
const MOD_DIR = () => `${appHome()}/mods/herdr-context`;

export default class HerdrContext extends View {
  init(_props, cx) {
    this.sessions = null;
    this.quota = null;
    this.error = null;
    this.quotaError = null;
    this.loading = false;
    this.quotaLoading = false;
    this.at = 0;
    this.quotaAt = 0;
    this.config = null;
    this.preview = false;
    if (checking()) {
      // `herdr-app check`: don't start the CLI; draw sample data so the check
      // renders every part of the panel.
      this.preview = true;
      this.sessions = SAMPLE_SESSIONS;
      this.quota = SAMPLE_QUOTA;
      this.at = this.quotaAt = Date.now();
      return;
    }
    // The tab bar remembers the right sidebar's panel per space, but only for
    // panels listed in "workspace.panels"; list ours so it's remembered too.
    if (panelState(layout()).inSidebar) {
      const enabled = shared("workspace.panels") ?? ["files", "changes"];
      if (Array.isArray(enabled) && !enabled.includes("context")) setShared("workspace.panels", [...enabled, "context"]);
    }
    this.refreshContext(cx);
    this.refreshQuota(cx, false);
    cx.timer.every(CONTEXT_EVERY_MS, (cx) => this.refreshContext(cx));
    cx.timer.every(QUOTA_EVERY_MS, (cx) => this.refreshQuota(cx, false));
  }

  /** Runs the bundled CLI and parses its JSON. */
  async cli(args) {
    if (!this.config) {
      const text = await readTextFile(`${MOD_DIR()}/config.json`);
      if (!text) throw new Error("config.json missing: run `node bin/install-mod.js` in the herdr-context repo");
      this.config = JSON.parse(text);
    }
    const r = await exec(this.config.node || "node", [this.config.cli, ...args], { timeout: 90_000 });
    if (r.code !== 0) {
      const msg = errorLine(r.stderr || r.stdout || "");
      if (/no Claude Code session logs found/.test(msg)) return [];
      throw new Error(msg || `herdr-context exited with ${r.code}`);
    }
    return JSON.parse(r.stdout);
  }

  refreshContext(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        this.sessions = await this.cli(["--list", "--json", "--limit", "8", "--recent", "48"]);
        this.error = null;
        this.at = Date.now();
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  refreshQuota(cx, force) {
    if (this.quotaLoading) return;
    this.quotaLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.quota = await this.cli(["quota", "--json", ...(force ? ["--refresh"] : [])]);
        this.quotaError = null;
        this.quotaAt = Date.now();
      } catch (e) {
        this.quotaError = String(e?.message ?? e);
      }
      this.quotaLoading = false;
      cx.notify();
    });
  }

  current() {
    if (this.preview) return { pane: null, cwd: this.sessions[0].cwd, session: this.sessions[0] };
    const target = choosePane(focused(), panes(), this.lastPane);
    if (target.pane) this.lastPane = target.pane;
    return { pane: target, cwd: target.cwd, session: pickSession(this.sessions ?? [], target.cwd) };
  }

  // ---------- pieces ----------

  color(t, usedPercent) {
    const l = level(usedPercent);
    return l === "high" ? t.blocked : l === "warn" ? t.working : t.accent;
  }

  bar(t, fraction, color, width = 96) {
    const p = Math.max(0, Math.min(100, Math.round((fraction ?? 0) * 100)));
    return h_flex().w(width).h(4).rounded(2).bg(t.border).overflow_hidden().flex_none()
      .child(div().h_full().w(`${p}%`).bg(color));
  }

  title(t, text, extra) {
    return h_flex().gap(8).items_center()
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(text.toUpperCase()))
      .when(Boolean(extra), (el) => el.child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(extra)));
  }

  dim(t, text) {
    return div().text_color(t.dim).child(text);
  }

  toggle() {
    for (const [cmd, args] of toggleCommands(panelState(layout()))) run(cmd, args);
  }

  iconButton(t, id, label, tip, onClick) {
    return div().id(id).px(6).py(2).rounded(4).cursor_pointer().text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_click(onClick).child(label);
  }

  header(t) {
    const busy = this.loading || this.quotaLoading;
    const inSidebar = panelState(layout()).open;
    return h_flex().gap(4).items_center()
      .child(div().flex_1().font_semibold().text_color(t.foreground).child("Context"))
      .child(div().text_size(11).text_color(t.dim).pr(4).child(busy ? "updating…" : `updated ${ago(this.at)}`))
      .child(this.iconButton(t, "hc-refresh", "↻", "Refresh now (also re-asks every subscription)",
        (_e, cx) => { this.refreshContext(cx); this.refreshQuota(cx, true); }))
      .when(inSidebar, (el) => el.child(this.iconButton(t, "hc-close", "×", "Close (or click the chip in the status bar)", () => this.toggle())));
  }

  contextSection(t) {
    const { pane, cwd, session } = this.current();
    const box = v_flex().gap(6);
    if (this.error && !this.sessions) return box.child(this.title(t, "This pane")).child(div().text_color(t.blocked).child(this.error));
    if (!session) {
      const app = pane?.app ?? null;
      const why = !cwd ? "No terminal in this tab."
        : app && !/claude/i.test(app) ? `${app}: context view supports Claude Code for now.`
        : this.sessions == null ? "Loading…" : "No recent Claude Code session in this folder.";
      return box.child(this.title(t, "This pane", cwd ? baseName(cwd) : null)).child(this.dim(t, why));
    }
    const c = session.context ?? {};
    box.child(this.title(t, "This pane", [session.model, session.gitBranch].filter(Boolean).join(" · ")));

    // occupancy
    const used = c.percent != null ? c.percent * 100 : null;
    box.child(h_flex().gap(8).items_center()
      .child(div().text_size(18).font_semibold().text_color(t.foreground).child(c.percent != null ? pctText(c.percent) : fmt(c.tokens)))
      .child(div().text_color(t.muted).child(c.window ? `${fmt(c.tokens)} / ${fmt(c.window)} tokens` : "tokens in context")));
    if (c.percent != null) box.child(this.bar(t, c.percent, this.color(t, used), 220));
    else box.child(this.dim(t, "Window size unknown: add the statusLine collector (see README)."));

    if (session.trend?.length > 1) {
      box.child(h_flex().gap(8).items_center()
        .child(div().text_color(t.accent).child(sparkline(session.trend)))
        .child(div().text_size(11).text_color(t.dim).child(`${session.requestCount} requests`)));
    }

    // makeup
    const parts = makeup(session);
    if (parts.length) {
      box.child(this.title(t, "Makeup", "estimated split"));
      for (const p of parts.slice(0, 7)) {
        box.child(h_flex().gap(8).items_center()
          .child(div().w(110).truncate().text_color(t.muted).child(p.label))
          .child(this.bar(t, p.share, t.accent, 80))
          .child(div().w(40).text_color(t.muted).child(pctText(p.share)))
          .child(div().text_size(11).text_color(t.dim).child(fmt(p.tokens))));
      }
      const heavy = session.composition?.topTools?.slice(0, 3) ?? [];
      if (heavy.length) box.child(div().text_size(11).text_color(t.dim).truncate().child(`heaviest tools: ${heavy.map((x) => `${x.name} ${fmt(x.tokens)}`).join(", ")}`));
    }

    // compactions, cost
    const k = session.compactions ?? [];
    const facts = [
      k.length ? `compacted ${k.length}× (last ${fmt(k[k.length - 1].preTokens)}→${fmt(k[k.length - 1].postTokens)})` : "never compacted",
      session.totals?.cacheHitRate != null ? `cache hit ${pctText(session.totals.cacheHitRate)}` : null,
      session.cost?.totalUSD != null ? `$${session.cost.totalUSD.toFixed(2)}` : null,
    ].filter(Boolean);
    box.child(div().text_size(11).text_color(t.dim).child(facts.join(" · ")));

    // files
    const files = (session.files ?? []).slice(0, 5);
    if (files.length) {
      box.child(this.title(t, "Files"));
      for (const f of files) {
        const n = f.edit + f.write;
        box.child(h_flex().gap(8).items_center()
          .child(div().flex_1().truncate().text_color(n ? t.foreground : t.muted).child(f.path))
          .child(div().text_size(11).text_color(t.dim).child(n ? `✎${n}` : `read ${f.read}`)));
      }
    }
    return box;
  }

  quotaSection(t) {
    const box = v_flex().gap(6).child(this.title(t, "Subscriptions", this.quotaAt ? ago(this.quotaAt) : null));
    if (this.quotaError && !this.quota) return box.child(div().text_color(t.blocked).child(this.quotaError));
    if (!this.quota) return box.child(this.dim(t, "Loading…"));
    for (const p of this.quota.providers ?? []) {
      const ok = p.status === "ok" || p.status === "stale";
      box.child(h_flex().gap(8).items_center().pt(2)
        .child(div().font_semibold().text_color(ok ? t.foreground : t.muted).child(p.provider))
        .when(Boolean(p.plan), (el) => el.child(div().text_size(11).text_color(t.dim).child(p.plan)))
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(t.dim).truncate().child(ok ? `${p.status === "stale" ? "stale · " : ""}${p.source}` : "")));
      if (!ok || !p.windows?.length) {
        box.child(div().text_size(11).text_color(t.dim).child(p.message ?? "no data"));
        continue;
      }
      for (const w of p.windows) {
        const when = w.id === "bonus" ? resetsIn(w.resetsAt).replace(/^in /, "expires in ") : w.resetsAt ? `resets ${resetsIn(w.resetsAt)}` : (w.detail ?? "");
        box.child(h_flex().gap(8).items_center()
          .child(div().w(64).truncate().text_color(t.muted).child(w.label))
          .child(this.bar(t, w.usedPercent / 100, this.color(t, w.usedPercent), 80))
          .child(div().w(40).text_color(this.color(t, w.usedPercent)).child(`${Math.round(w.usedPercent)}%`))
          .child(div().flex_1().truncate().text_size(10.5).text_color(t.dim).child(when)));
      }
    }
    for (const n of this.quota.notes ?? []) box.child(div().text_size(10.5).text_color(t.dim).child(n));
    return box;
  }

  // ---------- views ----------

  renderChip(t) {
    const { session } = this.current();
    const w = worstWindow(this.quota);
    const color = w ? this.color(t, w.window.usedPercent) : t.muted;
    const state = panelState(layout());
    const tip = this.error ?? this.quotaError ??
      (state.inSidebar ? `${state.open ? "Hide" : "Show"} context details` : "Context of the focused pane · fullest subscription window");
    return h_flex().size_full().px(8).items_center().justify_end().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8)
      .child(h_flex().id("hc-chip").px(8).h(20).gap(6).items_center().rounded(4).cursor_pointer()
        .when(state.open, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .tooltip(tip)
        .on_click(() => this.toggle())
        .child(div().text_color(color).child(chipText(session, this.quota)))
        .when(state.inSidebar, (el) => el.child(div().text_color(t.dim).child(state.open ? "▸" : "◂"))));
  }

  render() {
    const t = theme();
    if (props()?.view === "chip") return this.renderChip(t);
    return v_flex().id("hc-root").size_full().bg(t.chrome).p(12).gap(14).text_size(12).text_color(t.foreground)
      .overflow_y_scrollbar()
      .child(this.header(t))
      .child(this.contextSection(t))
      .child(div().h(1).bg(t.border))
      .child(this.quotaSection(t))
      // `herdr-app check` renders the default view only: draw the chip too so it gets checked
      .when(this.preview, (el) => el.child(div().h(28).child(this.renderChip(t))));
  }
}
