// herdr-context: what is in the focused agent's context window, and how much
// of each subscription is left. Drawing only; the numbers come from the
// herdr-context CLI bundled next to this file (cli/), run through exec().
//
// props: { view: "chip" } draws the one-line status-bar chip instead of the panel.
// Language: shared("herdr-context.lang") = "en" | "zh", toggled from the panel header;
// shared state, so the panel and the chip switch together and it survives restarts.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, appHome, home, readTextFile, theme, focused, panes, agents, spaces, props, checking, layout, run, shared, setShared } from "herdr";
import {
  choosePane, fmt, pctText, level, worstWindow, errorLine, panelState, toggleCommands,
  makeupParts, displayPath, trendBars, spaceAgents, agentKind, splitProviders, providerName, baseName,
} from "./logic.js";
import { translator, categoryLabel, windowLabel, resetsText, agoText, normLang } from "./i18n.js";
import { SAMPLE_SESSIONS, SAMPLE_QUOTA, SAMPLE_AGENTS } from "./sample.js";

const CONTEXT_EVERY_MS = 15_000;
const QUOTA_EVERY_MS = 120_000;
const MOD_DIR = () => `${appHome()}/mods/herdr-context`;
const LANG_KEY = "herdr-context.lang";

export default class HerdrContext extends View {
  init(_props, cx) {
    this.sessions = null; // pane id → {how, others, session}, from `herdr-context match`
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
      // renders every part (panel, agents list, chip).
      this.preview = true;
      this.sessions = { sample: { how: "title", others: 0, session: SAMPLE_SESSIONS[0] } };
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

  // ---------- data ----------

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
      throw new Error(msg || `herdr-context exited with ${r.code}`);
    }
    return JSON.parse(r.stdout);
  }

  refreshContext(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const rows = await this.cli(["match", "--json", "--panes", JSON.stringify(this.agentPanes())]);
        this.sessions = Object.fromEntries(rows.map((r) => [r.pane, r]));
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

  /** Every pane running Claude Code, Codex or Antigravity, for `herdr-context match`:
   *  the CLI pairs each with its own session (by terminal title, agy's open
   *  conversation, else folder). */
  agentPanes() {
    const byPane = new Map(panes().map((p) => [p.pane, p]));
    const out = [];
    for (const a of agents()) {
      const kind = agentKind(a.app);
      const p = byPane.get(a.pane);
      if (kind && p?.cwd) out.push({ pane: a.pane, agent: kind, cwd: p.cwd, title: p.title ?? a.title ?? "" });
    }
    return out.slice(0, 16);
  }

  /** The terminal described, its session (only when an agent runs there), and the space's agents. */
  current() {
    if (this.preview) {
      const m = this.sessions.sample;
      return { pane: { pane: "sample", app: "claude-code" }, cwd: m.session.cwd, session: m.session, match: m, agents: SAMPLE_AGENTS.map((a) => ({ ...a, session: m.session })) };
    }
    const f = focused();
    const target = choosePane(f, panes(), this.lastPane);
    if (target.pane) this.lastPane = target.pane;
    const matches = this.sessions ?? {};
    // Only a pane running an agent gets a session, and only its own.
    const match = agentKind(target.app) && target.pane ? matches[target.pane] ?? null : null;
    const space = f?.space ?? spaces().find((s) => s.active)?.id ?? null;
    return { pane: target, cwd: target.cwd, session: match?.session ?? null, match, agents: spaceAgents(agents(), panes(), matches, space) };
  }

  lang() {
    return normLang(shared(LANG_KEY));
  }

  // ---------- pieces ----------

  color(t, usedPercent) {
    const l = level(usedPercent);
    return l === "high" ? t.blocked : l === "warn" ? t.working : t.accent;
  }

  valueColor(t, usedPercent) {
    const l = level(usedPercent);
    return l === "high" ? t.blocked : l === "warn" ? t.working : t.foreground;
  }

  bar(t, fraction, color, h = 4) {
    const p = Math.max(0, Math.min(100, (fraction ?? 0) * 100));
    return div().w_full().h(h).rounded(h / 2).bg(t.border).overflow_hidden()
      .child(div().h_full().w(`${p}%`).rounded(h / 2).bg(color));
  }

  label(t, text, aside) {
    return h_flex().items_center()
      .child(div().flex_1().text_size(10.5).font_semibold().text_color(t.dim).child(this.lang() === "zh" ? text : text.toUpperCase()))
      .when(Boolean(aside), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(aside)));
  }

  section(t, title, aside, ...children) {
    return v_flex().gap(8).child(this.label(t, title, aside)).children(children.filter(Boolean));
  }

  iconButton(t, id, glyph, tip, onClick) {
    return div().id(id).min_w(22).h(22).px(4).flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_click(onClick).child(glyph);
  }

  toggle() {
    for (const [cmd, args] of toggleCommands(panelState(layout()))) run(cmd, args);
  }

  header(t, tr) {
    const busy = this.loading || this.quotaLoading;
    const open = panelState(layout()).open;
    const zh = this.lang() === "zh";
    return h_flex().h(28).gap(2).items_center()
      .child(div().flex_1().text_size(13).font_semibold().text_color(t.foreground).child(tr("title")))
      .child(div().text_size(11).text_color(t.dim).pr(4).child(busy ? tr("updating") : agoText(this.at, this.lang())))
      .child(this.iconButton(t, "hc-lang", div().text_size(11).child(zh ? "EN" : "中"), tr("langTip"),
        () => setShared(LANG_KEY, zh ? "en" : "zh")))
      .child(this.iconButton(t, "hc-refresh", "↻", tr("refreshTip"),
        (_e, cx) => { this.refreshContext(cx); this.refreshQuota(cx, true); }))
      .when(open, (el) => el.child(this.iconButton(t, "hc-close", "✕", tr("closeTip"), () => this.toggle())));
  }

  // ---------- the focused agent ----------

  focusCard(t, tr, session, cwd, match) {
    const c = session.context ?? {};
    const pct = c.percent != null ? c.percent * 100 : null;
    const where = [session.model, session.gitBranch && session.gitBranch !== "HEAD" ? session.gitBranch : null].filter(Boolean).join(" · ");
    const card = v_flex().gap(10).p(12).rounded(10).bg(t.surface).border(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(div().id("hc-where").text_size(12.5).font_semibold().text_color(t.foreground).truncate()
          // hover: which log, and why this one (for checking a match)
          .tooltip([session.cwd, match?.file, match ? `${tr("matchedBy")}: ${match.how}${match.paneTitle ? ` · "${match.paneTitle}"` : ""}` : null, match?.diag].filter(Boolean).join("\n"))
          .child(baseName(session.cwd ?? cwd) || "—"))
        .child(div().flex_1().text_size(11).text_color(t.dim).truncate().child(where)))
      .child(h_flex().gap(8).items_end()
        .child(div().text_size(26).font_semibold().text_color(pct != null ? this.valueColor(t, pct) : t.foreground)
          .child(pct != null ? pctText(c.percent) : fmt(c.tokens)))
        .child(div().pb(4).text_size(11.5).text_color(t.muted)
          .child(c.window ? tr("tokensOf", { used: fmt(c.tokens), window: fmt(c.window) }) : tr("tokensInContext"))));
    if (c.tokens == null) card.child(div().text_size(11).text_color(t.dim).child(tr("noRequests")));
    else if (pct != null) card.child(this.bar(t, c.percent, this.color(t, pct), 6));
    else card.child(div().text_size(11).text_color(t.dim).child(tr("windowUnknown")));

    const bars = trendBars(session.trend, 48);
    if (bars.length > 1) {
      card.child(h_flex().h(28).gap(1).items_end().children(bars.map((h, i) =>
        div().flex_1().h(h).rounded(1).bg(i === bars.length - 1 ? t.accent : t.border))));
    }
    // matched by folder while other sessions share it: say it is the newest, not a certainty
    if (match?.how === "folder" && match.others > 0) {
      card.child(div().text_size(11).text_color(t.dim).child(tr(session.agent === "agy" ? "guessedAgy" : "guessed", { n: match.others })));
    }
    const k = session.compactions ?? [];
    const facts = [
      tr("requests", { n: session.requestCount }),
      session.totals?.cacheHitRate != null ? tr("cacheHit", { pct: pctText(session.totals.cacheHitRate) }) : null,
      k.length ? tr("compacted", { n: k.length }) : tr("neverCompacted"),
      session.cost?.totalUSD != null ? `$${session.cost.totalUSD.toFixed(2)}` : null,
    ].filter(Boolean);
    card.child(div().text_size(11).text_color(t.dim).truncate().child(facts.join("  ·  ")));
    return card;
  }

  makeupSection(t, tr, session) {
    const lang = this.lang();
    const parts = makeupParts(session);
    if (!parts.length) return null;
    const stacked = h_flex().w_full().h(8).rounded(4).overflow_hidden().gap(1)
      .children(parts.map((p) => div().h_full().w(`${p.share * 100}%`).bg(t[p.color] ?? t.accent)));
    const item = (p) => h_flex().flex_1().gap(6).items_center()
      .child(div().w(8).h(8).rounded(2).bg(t[p.color] ?? t.accent))
      .child(div().flex_1().text_size(11.5).text_color(t.muted).truncate().child(categoryLabel(p.key, lang)))
      .child(div().text_size(11.5).text_color(t.foreground).child(pctText(p.share)));
    const top = parts.slice(0, 6);
    const rows = [];
    for (let i = 0; i < top.length; i += 2) {
      rows.push(h_flex().gap(14).child(item(top[i])).child(top[i + 1] ? item(top[i + 1]) : div().flex_1()));
    }
    const heavy = session.composition?.topTools?.slice(0, 3) ?? [];
    return this.section(t, tr("makeup"), null, stacked, v_flex().gap(5).children(rows),
      heavy.length ? div().text_size(10.5).text_color(t.dim).truncate().child(`${tr("heaviestTools")}  ${heavy.map((x) => `${x.name} ${fmt(x.tokens)}`).join(" · ")}`) : null);
  }

  filesSection(t, tr, session) {
    const files = (session.files ?? []).slice(0, 5);
    if (!files.length) return null;
    return this.section(t, tr("files"), null, v_flex().gap(4).children(files.map((f) => {
      const d = displayPath(f.path, session.cwd, home());
      const n = f.edit + f.write;
      return h_flex().gap(6).items_center()
        .child(div().text_size(12).text_color(n ? t.foreground : t.muted).child(d.name))
        .child(div().flex_1().text_size(11).text_color(t.dim).truncate().child(d.dir))
        .child(div().text_size(10.5).text_color(n ? t.muted : t.dim).child(n ? `✎ ${n}` : tr("read")));
    })));
  }

  agentsSection(t, tr, list, focusedPane) {
    if (!list.length) return null;
    // Without a window size there is no %, so bars compare the agents' token counts.
    const most = Math.max(1, ...list.map((a) => a.session?.context?.tokens ?? 0));
    return this.section(t, tr("agents"), null, v_flex().gap(2).children(list.map((a, i) => {
      const c = a.session?.context ?? {};
      const pct = c.percent != null ? c.percent * 100 : null;
      const here = a.pane && a.pane === focusedPane;
      const folder = baseName(a.cwd);
      return h_flex().id(`hc-agent-${i}`).gap(8).px(8).py(6).rounded(6).items_center().cursor_pointer()
        .when(here, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .tooltip(a.cwd ?? "")
        .on_click(() => { if (!this.preview) run("agent.focus", { terminal: a.address }); })
        .child(div().w(6).h(6).rounded_full().bg(t[a.status] ?? t.idle))
        .child(div().text_size(12).text_color(t.foreground).truncate().child(a.title))
        .child(div().flex_1().text_size(11).text_color(t.dim).truncate().child(folder && folder !== a.title ? folder : ""))
        .child(div().w(56).child(this.bar(t, pct != null ? c.percent : (c.tokens ?? 0) / most,
          pct != null ? this.color(t, pct) : t.dim, 4)))
        .child(div().w(38).text_size(11).text_color(pct != null ? this.valueColor(t, pct) : t.muted)
          .child(c.tokens == null ? "—" : pct != null ? pctText(c.percent) : fmt(c.tokens)));
    })));
  }

  contextPart(t, tr) {
    const { pane, cwd, session, match, agents: list } = this.current();
    if (this.error && !this.sessions) return div().text_color(t.blocked).text_size(12).child(this.error);
    const out = [];
    if (session) {
      out.push(this.focusCard(t, tr, session, cwd, match));
    } else {
      const why = this.sessions == null || (agentKind(pane?.app) && pane?.pane && !(pane.pane in this.sessions)) ? tr("loading")
        : match?.error ? match.error
        : !cwd ? tr("noTerminal")
        : agentKind(pane?.app) ? tr("noSessionLog", { app: pane.app })
        : pane?.app ? tr("otherAgent", { app: pane.app })
        : list.length ? tr("noAgentPick") : tr("noAgent");
      // hover: what the search saw (pane title, how many sessions each source found)
      const diag = match ? [match.paneTitle ? `"${match.paneTitle}"` : null, match.diag].filter(Boolean).join("\n") : "";
      out.push(v_flex().id("hc-why").p(12).rounded(10).border(1).border_color(t.border)
        .when(Boolean(diag), (el) => el.tooltip(diag))
        .child(div().text_size(12).text_color(t.muted).child(why)));
    }
    // the space's agents: when this pane has none, or when there are several to compare
    if (list.length && (!session || list.length > 1)) out.push(this.agentsSection(t, tr, list, pane?.pane));
    if (session) {
      out.push(this.makeupSection(t, tr, session));
      out.push(this.filesSection(t, tr, session));
    }
    return v_flex().gap(18).children(out.filter(Boolean));
  }

  // ---------- subscriptions ----------

  providerCard(t, tr, p) {
    const lang = this.lang();
    const head = h_flex().gap(6).items_center()
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(providerName(p.provider)))
      .when(Boolean(p.plan), (el) => el.child(div().px(5).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.muted).child(String(p.plan))))
      .child(div().flex_1())
      .when(p.status === "stale", (el) => el.child(div().text_size(10.5).text_color(t.dim).child(tr("stale"))));
    // labels like "Claude/GPT week" need a wider column than "5h" / "week"
    const long = p.windows.some((w) => windowLabel(w.label, lang).length > 8);
    const labelW = long ? 104 : lang === "zh" ? 64 : 44;
    const rows = p.windows.map((w) => {
      const when = w.resetsAt ? resetsText(w.resetsAt, lang) : (w.detail ?? "").replace(/^resets /, "");
      return h_flex().gap(8).items_center()
        .child(div().w(labelW).text_size(11.5).text_color(t.muted).truncate().child(windowLabel(w.label, lang)))
        .child(div().flex_1().child(this.bar(t, w.usedPercent / 100, this.color(t, w.usedPercent), 5)))
        .child(div().w(36).text_size(12).font_semibold().text_color(this.valueColor(t, w.usedPercent)).child(`${Math.round(w.usedPercent)}%`))
        .child(div().w(lang === "zh" ? 80 : 64).text_size(10.5).text_color(t.dim).truncate().child(when));
    });
    const tip = [tr("via", { source: p.source }), p.observedAt ? tr("asOf", { time: p.observedAt.replace("T", " ").slice(0, 16) }) : null].filter(Boolean).join(" · ");
    return v_flex().gap(7).p(10).rounded(8).bg(t.surface).border(1).border_color(t.border)
      .tooltip(tip).child(head).children(rows);
  }

  quotaPart(t, tr) {
    const title = tr("subscriptions");
    if (this.quotaError && !this.quota) return this.section(t, title, null, div().text_size(12).text_color(t.blocked).child(this.quotaError));
    if (!this.quota) return this.section(t, title, null, div().text_size(12).text_color(t.dim).child(tr("loading")));
    const { shown, missing } = splitProviders(this.quota);
    const out = shown.map((p) => this.providerCard(t, tr, p));
    if (missing.length) {
      out.push(h_flex().id("hc-missing").gap(6).items_center()
        .tooltip(missing.map((m) => `${m.name}: ${m.why}`).join("\n"))
        .child(div().text_size(11).text_color(t.dim).truncate()
          .child(tr("notSetUp", { names: missing.map((m) => m.name).join(", ") })))
        .child(div().text_size(11).text_color(t.dim).child("ⓘ")));
    }
    return this.section(t, title, this.quotaAt ? agoText(this.quotaAt, this.lang()) : null, ...out);
  }

  // ---------- views ----------

  renderChip(t, tr) {
    const lang = this.lang();
    const { session } = this.current();
    const state = panelState(layout());
    const w = worstWindow(this.quota);
    const c = session?.context;
    const tip = this.error ?? this.quotaError ?? (state.inSidebar ? tr(state.open ? "chipHide" : "chipShow") : tr("chipPlain"));
    const part = (labelText, value, color) => h_flex().gap(4).items_center()
      .child(div().text_color(t.dim).child(labelText))
      .child(div().text_color(color).child(value));
    const chip = h_flex().id("hc-chip").h(20).px(8).gap(10).items_center().rounded(5).cursor_pointer()
      .when(state.open, (el) => el.bg(t.hover))
      .hover((s) => s.bg(t.hover))
      .tooltip(tip)
      .on_click(() => this.toggle());
    if (c?.tokens != null) {
      const pct = c.percent != null ? c.percent * 100 : null;
      chip.child(part("ctx", pct != null ? pctText(c.percent) : fmt(c.tokens), pct != null ? this.valueColor(t, pct) : t.muted));
    }
    if (w) chip.child(part(`${providerName(w.provider)} ${windowLabel(w.window.label, lang)}`, `${Math.round(w.window.usedPercent)}%`, this.valueColor(t, w.window.usedPercent)));
    if (c?.tokens == null && !w) chip.child(div().text_color(t.dim).child(tr("chipEmpty")));
    return h_flex().size_full().px(6).items_center().justify_end().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8)
      .child(chip);
  }

  render() {
    const t = theme();
    const tr = translator(this.lang());
    if (props()?.view === "chip") return this.renderChip(t, tr);
    return v_flex().id("hc-root").size_full().bg(t.chrome).px(14).pt(10).pb(14).gap(18).text_color(t.foreground)
      .overflow_y_scrollbar()
      .child(this.header(t, tr))
      .child(this.contextPart(t, tr))
      .child(this.quotaPart(t, tr))
      // `herdr-app check` renders the default view only: draw the chip too so it gets checked
      .when(this.preview, (el) => el.child(div().h(28).child(this.renderChip(t, tr))));
  }
}
