/* The Scorecard: page rendering. Data comes from data/metrics.js (built daily by pipeline/update.py). */
(function () {
  const { h, fmtNum } = window.Charts;
  const ICON = {
    fail: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="currentColor"/><path d="M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/></svg>',
    warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="currentColor"/><path d="M8 4.2v4.6" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="8" cy="11.6" r="1.15" fill="#fff"/></svg>',
    pass: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="currentColor"/><path d="M4.6 8.3l2.3 2.3 4.5-4.8" stroke="#fff" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    info: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="currentColor"/><circle cx="8" cy="4.6" r="1.15" fill="#fff"/><path d="M8 7.2v4.6" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>',
  };
  const STATUS_LABEL = { fail: "Off track", warn: "Watch", pass: "On track", info: "Context" };

  function statusPill(s) {
    const span = h("span", "status " + s);
    span.innerHTML = ICON[s];
    span.appendChild(document.createTextNode(STATUS_LABEL[s]));
    return span;
  }
  function statusDot(s) {
    const span = h("span", "status-dot " + s);
    span.innerHTML = ICON[s];
    span.setAttribute("aria-label", STATUS_LABEL[s]);
    span.setAttribute("role", "img");
    return span;
  }

  function headlineText(hd, compact) {
    const unit = hd.unit;
    let v = fmtNum(hd.value, unit === "$" ? "$" : "", hd.decimals, { signed: hd.signed, compact: compact && Math.abs(hd.value) >= 1e5 });
    return { num: v, unit: unit === "%" ? "%" : (hd.suffix || "") };
  }

  /* ---------- info popover: hover (fine pointers) or click/tap, Esc to close ---------- */
  let infoSeq = 0;
  function infoButton(title, ex) {
    const wrap = h("span", "info");
    const btn = h("button", "info-btn", "i");
    const id = "info-" + ++infoSeq;
    btn.type = "button";
    btn.setAttribute("aria-label", "What is " + title + "?");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", id);
    const pop = h("div", "info-pop");
    pop.id = id;
    pop.setAttribute("role", "tooltip");
    pop.appendChild(h("h4", null, "What is being measured"));
    pop.appendChild(h("p", null, ex.what));
    if (ex.why) { pop.appendChild(h("h4", null, "Why it matters")); pop.appendChild(h("p", null, ex.why)); }
    wrap.append(btn, pop);
    function place() {
      const r = btn.getBoundingClientRect();
      const w = Math.min(380, window.innerWidth - 32);
      const left = Math.min(Math.max(16, r.left - 12), window.innerWidth - 16 - w);
      pop.style.width = w + "px";
      pop.style.left = left + "px";
      pop.style.setProperty("--arrow-x", Math.round(r.left + r.width / 2 - left - 6) + "px");
      const hgt = pop.offsetHeight;
      const above = r.bottom + 10 + hgt > window.innerHeight - 8 && r.top - 10 - hgt > 8;
      pop.classList.toggle("above", above);
      pop.style.top = (above ? r.top - 10 - hgt : r.bottom + 10) + "px";
    }
    const setOpen = (on) => { if (on) place(); wrap.classList.toggle("open", on); btn.setAttribute("aria-expanded", String(on)); };
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const on = !wrap.classList.contains("open");
      closeAllInfo();
      setOpen(on);
    });
    wrap.addEventListener("mouseenter", () => { place(); activeInfo = place; });
    btn.addEventListener("focus", place);
    btn.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
    wrap._place = place;
    return wrap;
  }
  let activeInfo = null;
  function closeAllInfo() {
    document.querySelectorAll(".info.open").forEach((n) => { n.classList.remove("open"); n.querySelector(".info-btn").setAttribute("aria-expanded", "false"); });
  }
  document.addEventListener("click", (e) => { if (!e.target.closest(".info")) closeAllInfo(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAllInfo(); });
  const reposition = () => {
    document.querySelectorAll(".info.open").forEach((n) => n._place && n._place());
    if (activeInfo) activeInfo();
  };
  window.addEventListener("scroll", reposition, { passive: true });
  window.addEventListener("resize", reposition);

  function fmtStamp(iso) {
    const d = new Date(iso);
    return d.toLocaleString("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  }
  function fmtDate(s) {
    if (!s) return "";
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + "T00:00:00") : new Date(s);
    return isNaN(d) ? s : d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  }

  function sourceItem(s) {
    const li = h("li", "src");
    li.appendChild(h("div", "src-pub", s.publisher));
    const a = h("a", null, s.title);
    a.href = s.url; a.target = "_blank"; a.rel = "noopener";
    li.appendChild(a);
    const tag = h("span", "src-tag " + (s.automated ? "auto" : "hand"), s.automated ? "Checked daily" : "Hand-verified");
    li.appendChild(tag);
    const meta = [];
    if (s.series && s.series.length) meta.push("Series: " + s.series.join(" · "));
    if (s.table) meta.push(s.table);
    if (s.published) meta.push("Published: " + fmtDate(s.published));
    if (s.retrieved_at) meta.push("Retrieved: " + fmtStamp(s.retrieved_at));
    if (s.accessed) meta.push("Verified: " + fmtDate(s.accessed));
    if (s.note) meta.push(s.note);
    meta.forEach((t) => li.appendChild(h("div", "src-meta", t)));
    if (s.data_url) {
      const d = h("div", "src-meta");
      const da = h("a", null, "Raw data file");
      da.href = s.data_url; da.target = "_blank"; da.rel = "noopener";
      d.appendChild(da);
      li.appendChild(d);
    }
    return li;
  }

  function card(m) {
    const c = h("article", "card" + (m.wide ? " wide" : ""));
    c.id = m.id;
    const top = h("div", "card-top");
    top.appendChild(statusPill(m.status));
    const share = h("button", "btn btn-ghost", "Copy link");
    share.type = "button";
    share.addEventListener("click", async () => {
      const url = location.href.split("#")[0] + "#" + m.id;
      try { await navigator.clipboard.writeText(url); share.textContent = "Link copied"; } catch (e) { location.hash = m.id; share.textContent = "Link in address bar"; }
      setTimeout(() => (share.textContent = "Copy link"), 2200);
    });
    top.appendChild(share);
    c.appendChild(top);

    const h3 = h("h3", null, m.title);
    if (m.explainer) h3.appendChild(infoButton(m.title, m.explainer));
    c.appendChild(h3);
    c.appendChild(h("p", "question", m.question));

    if (m.stale) c.appendChild(h("div", "flag stale", "⚠ " + m.stale_reason));
    if (!m.automated) {
      const crossChecked = m.cross_checked === true;
      const txt = "Hand-verified against the source on " + fmtDate(m.verified_on) +
        (m.recheck_overdue ? ". Re-verification is due." : crossChecked ? ", and cross-checked automatically every day." : ". Not an automated feed.");
      c.appendChild(h("div", "flag manual", txt));
    }

    const fig = h("div", "figure");
    const hd = headlineText(m.headline);
    const num = h("div", "hero-num", hd.num);
    if (hd.unit) num.appendChild(h("span", "u", hd.unit));
    fig.appendChild(num);
    const cap = h("div", "fig-caption", m.headline.caption);
    cap.appendChild(h("span", "fig-period", m.headline.period));
    fig.appendChild(cap);
    c.appendChild(fig);

    if (m.benchmark) {
      const b = h("div", "bench");
      b.appendChild(h("span", "lbl", m.benchmark.label + ":"));
      b.appendChild(h("b", null, m.benchmark.text));
      c.appendChild(b);
    }

    const chartBox = h("div");
    c.appendChild(chartBox);
    if (m.chart) window.Charts.render(chartBox, m.chart, m);

    if (m.context && m.context.length) {
      const ul = h("ul", "context");
      m.context.forEach((t) => ul.appendChild(h("li", null, t)));
      c.appendChild(ul);
    }
    if (m.promise) {
      const p = h("div", "promise");
      p.appendChild(h("q", null, m.promise.quote));
      p.appendChild(h("small", null, m.promise.attribution));
      c.appendChild(p);
    }

    const foot = h("div", "card-foot");
    const det = h("details", "sources");
    det.appendChild(h("summary", null, `Where does this data come from? (${m.sources.length} source${m.sources.length > 1 ? "s" : ""})`));
    const ul = h("ul", "src-list");
    m.sources.forEach((s) => ul.appendChild(sourceItem(s)));
    det.appendChild(ul);
    det.appendChild(h("p", "method", "How it's calculated: " + m.method));
    det.appendChild(h("p", "method", "How the rating is decided: " + m.status_rule));
    if (m.updated_at) det.appendChild(h("p", "method", "Last automated check: " + fmtStamp(m.updated_at)));
    foot.appendChild(det);
    c.appendChild(foot);
    return c;
  }

  // Preferences saved from subscribe.html ("Customise your view"): which categories to pin to the top,
  // and which statuses to show by default. Reading them here is what makes that page actually do something.
  function readPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem("scorecard_prefs"));
      return { pinned: Array.isArray(p && p.pinned) ? p.pinned : [], filter: (p && p.filter) || "all" };
    } catch (e) { return { pinned: [], filter: "all" }; }
  }
  function orderSections(sections, pinned) {
    if (!pinned.length) return sections;
    const pinnedSet = new Set(pinned);
    const pinnedOnes = pinned.map((id) => sections.find((s) => s.id === id)).filter(Boolean);
    return pinnedOnes.concat(sections.filter((s) => !pinnedSet.has(s.id)));
  }
  function filterByStatus(ms, filter) {
    if (filter === "off") return ms.filter((m) => m.status === "fail");
    if (filter === "watch_off") return ms.filter((m) => m.status === "fail" || m.status === "warn");
    return ms;
  }

  function render(overridePrefs) {
    const D = window.SCORECARD;
    if (!D) return;
    const S = D.summary;
    const metrics = D.metrics;
    const prefs = overridePrefs || readPrefs();
    const showPrefsBanner = !overridePrefs && (prefs.pinned.length > 0 || prefs.filter !== "all");
    // render() can be re-entered (the preferences banner's "Show everything" button calls it again with an
    // override), so the mount points need clearing first or content would just pile up on top of itself.
    document.getElementById("report-grid").innerHTML = "";
    document.getElementById("chips").innerHTML = "";
    document.getElementById("sections").innerHTML = "";

    // hero tally
    // Lead with the small number: how many measures are on track.
    const onTrack = S.metrics_on_track;
    document.getElementById("tally-only").hidden = onTrack > S.metrics_rated / 3;
    document.getElementById("tally-on").textContent = onTrack;
    document.getElementById("tally-total").textContent = S.metrics_rated;
    document.getElementById("tally-label").textContent = `key measures ${onTrack === 1 ? "is" : "are"} on track`;
    const bar = document.getElementById("tally-bar");
    [["pass", "#3CD070", S.metrics_on_track], ["warn", "#F5C04A", S.metrics_watch], ["fail", "#FF6B72", S.metrics_off_track]].forEach(([k, col, n]) => {
      if (!n) return; const i = h("i"); i.style.background = col; i.style.flex = n; bar.appendChild(i);
    });
    document.getElementById("tally-legend").innerHTML = "";
    const lg = document.getElementById("tally-legend");
    [["On track", S.metrics_on_track], ["Watch", S.metrics_watch], ["Off track", S.metrics_off_track]].forEach(([l, n]) => {
      const s = h("span"); s.appendChild(h("b", null, String(n))); s.appendChild(document.createTextNode(" " + l)); lg.appendChild(s);
    });
    document.getElementById("verified-at").textContent = fmtStamp(S.generated_at);
    document.getElementById("checks-passed").textContent = `${S.checks_passed} of ${S.checks_total} automated checks passed`;

    // report card
    const grid = document.getElementById("report-grid");
    metrics.forEach((m) => {
      const a = h("a", "rc-item");
      a.href = "#" + m.id;
      a.appendChild(statusDot(m.status));
      const mid = h("div");
      mid.appendChild(h("div", "rc-title", m.title));
      mid.appendChild(h("div", "rc-sub", m.headline.period));
      a.appendChild(mid);
      const hd = headlineText(m.headline, true);
      a.appendChild(h("div", "rc-val", hd.num + hd.unit));
      grid.appendChild(a);
    });

    // sections — reordered to put pinned categories first, and filtered to the saved default status
    const main = document.getElementById("sections");
    const chips = document.getElementById("chips");
    if (showPrefsBanner) {
      const banner = h("div", "wrap prefs-banner");
      const inner = h("div", "prefs-banner-inner");
      inner.appendChild(h("p", null, "Showing your saved preferences from Subscribe."));
      const showAll = h("button", "btn btn-ghost", "Show everything");
      showAll.type = "button";
      showAll.addEventListener("click", () => render({ pinned: [], filter: "all" }));
      const change = h("a", "btn btn-ghost", "Change preferences");
      change.href = "subscribe.html#customise";
      inner.append(showAll, change);
      banner.appendChild(inner);
      main.appendChild(banner);
    }
    orderSections(D.sections, prefs.pinned).forEach((sec) => {
      const ms = filterByStatus(metrics.filter((m) => m.section === sec.id), prefs.filter);
      if (!ms.length) return;
      const chip = h("a", "chip", sec.title); chip.href = "#sec-" + sec.id; chips.appendChild(chip);
      const s = h("section", "section wrap");
      s.id = "sec-" + sec.id;
      const head = h("div", "section-head");
      const hl = h("div");
      const rated = ms.filter((m) => m.status !== "info").length;
      hl.appendChild(h("p", "kicker", rated ? `${ms.filter((m) => m.status === "fail").length} of ${rated} off track` : "Context"));
      hl.appendChild(h("h2", null, sec.title + (prefs.pinned.includes(sec.id) ? " ★" : "")));
      hl.appendChild(h("p", null, sec.blurb));
      head.appendChild(hl);
      s.appendChild(head);
      const cards = h("div", "cards");
      ms.forEach((m) => cards.appendChild(card(m)));
      if (ms.length % 2 === 1) cards.lastChild.classList.add("wide");
      s.appendChild(cards);
      main.appendChild(s);
    });

    if (location.hash) { const t = document.getElementById(location.hash.slice(1)); if (t) setTimeout(() => t.scrollIntoView(), 50); }
  }

  window.Scorecard = { infoButton, sourceItem, fmtStamp, fmtDate, statusPill, ICON };
  if (document.getElementById("sections")) render();
})();
