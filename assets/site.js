/* The Scorecard: site-wide chrome shared by every page — theme toggle, mobile menu, search, scroll progress,
   back-to-top, feedback button, cookie notice, footer email signup, confirm dialogs, outbound link tagging
   and print preparation. Depends only on window.SCORECARD (data/metrics.js). */
(function () {
  const root = document.documentElement;
  const body = document.body;
  const D = window.SCORECARD;
  const isCat = body.classList.contains("catpage");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const KEYS = { theme: "scorecard_theme", cookie: "scorecard_cookie_ack", sub: "scorecard_subscription",
                 prefs: "scorecard_prefs", suggestions: "scorecard_suggestions", corrections: "scorecard_corrections" };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked: feature just won't persist */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* nothing to remove */ } },
    json(k, fallback) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fallback : v; } catch (e) { return fallback; } },
  };

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const k in props || {}) {
      if (k === "className") n.className = props[k];
      else if (k === "text") n.textContent = props[k];
      else if (k === "html") n.innerHTML = props[k];
      else n.setAttribute(k, props[k]);
    }
    kids.forEach((c) => c != null && n.append(c));
    return n;
  }
  const svg = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
    menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    up: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
    chat: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  };

  function fmtDate(iso) {
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + "T00:00:00" : iso);
    return isNaN(d) ? "" : d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  }
  function fmtStamp(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back below */ }
    const ta = el("textarea", { "aria-hidden": "true", style: "position:fixed;top:-1000px;opacity:0" });
    ta.value = text;
    body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  /* ---------- form sending (Formspree) ---------- */
  const FORM_ENDPOINT = (window.SITE_CONFIG && window.SITE_CONFIG.formEndpoint) || "";
  // an off-screen field people never see; bots that fill it get a fake success and nothing is sent
  function addTrap(form) {
    if (form.querySelector('input[name="_gotcha"]')) return;
    form.append(el("input", { type: "text", name: "_gotcha", tabindex: "-1", autocomplete: "off", "aria-hidden": "true", className: "hp" }));
  }
  async function sendForm(type, fields, form) {
    const trap = form && form.querySelector('input[name="_gotcha"]');
    if (trap && trap.value) return { ok: true };
    if (!FORM_ENDPOINT) return { ok: false, error: "Sorry, this form isn't available right now." };
    const payload = { form_type: type, _subject: "The Scorecard: " + type, page: window.location.href.split(/[?#]/)[0] };
    // drop blanks: Formspree rejects an empty "email" field
    Object.entries(fields).forEach(([k, v]) => { if (v !== "" && v != null) payload[k] = v; });
    try {
      const res = await fetch(FORM_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload) });
      if (res.ok) return { ok: true };
      const data = await res.json().catch(() => ({}));
      const detail = Array.isArray(data.errors) ? data.errors.map((x) => x.message).join(" ") : "";
      return { ok: false, error: "Sorry, that didn't send" + (detail ? `: ${detail}` : ". Please try again.") };
    } catch (e) {
      return { ok: false, error: "Sorry, that didn't send. Check your connection and try again." };
    }
  }
  function setBusy(button, busy, busyLabel) {
    if (busy) { button.dataset.label = button.textContent; button.textContent = busyLabel || "Sending\u2026"; }
    else if (button.dataset.label) button.textContent = button.dataset.label;
    button.disabled = busy;
  }
  document.querySelectorAll("form[data-send]").forEach(addTrap);

  /* ---------- confirm dialog: resolves true only on an explicit confirm ---------- */
  let dlgSeq = 0;
  function confirmDialog(opts) {
    return new Promise((resolve) => {
      const id = "confirm-" + ++dlgSeq;
      const cancel = el("button", { className: "btn btn-secondary", value: "cancel", text: opts.cancel || "Cancel", autofocus: "" });
      const ok = el("button", { className: "btn btn-red", value: "confirm", text: opts.confirm || "Confirm" });
      const d = el("dialog", { className: "confirm-dialog", role: "alertdialog", "aria-labelledby": id + "-t", "aria-describedby": id + "-b" },
        el("form", { method: "dialog" },
          el("h2", { id: id + "-t", text: opts.title }),
          el("p", { id: id + "-b", text: opts.body }),
          el("div", { className: "confirm-actions" }, cancel, ok)));
      d.addEventListener("click", (e) => { if (e.target === d) d.close("cancel"); });
      d.addEventListener("close", () => { resolve(d.returnValue === "confirm"); d.remove(); });
      body.appendChild(d);
      d.showModal();
      cancel.focus();
    });
  }

  /* ---------- theme ---------- */
  const themeLabel = (t) => (t === "dark" ? "Switch to light theme" : "Switch to dark theme");
  let themeBtn = null;
  function applyTheme(t) {
    root.setAttribute("data-theme", t);
    if (themeBtn) {
      themeBtn.innerHTML = t === "dark" ? ICON.sun : ICON.moon;
      themeBtn.setAttribute("aria-label", themeLabel(t));
      themeBtn.title = themeLabel(t);
    }
  }
  if (!isCat) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
      if (!store.get(KEYS.theme)) applyTheme(e.matches ? "dark" : "light");
    });
  }

  /* ---------- header: search, theme and menu buttons ---------- */
  const header = document.querySelector(".site-header");
  const headerWrap = header && header.querySelector(".wrap");
  const nav = header && header.querySelector(".nav");
  let menuBtn = null;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const searchBtn = el("button", { className: "icon-btn search-btn", type: "button", "aria-haspopup": "dialog", "aria-label": "Search the site" });
  searchBtn.innerHTML = ICON.search + '<span class="search-label">Search</span><kbd>' + (isMac ? "⌘K" : "Ctrl K") + "</kbd>";

  if (headerWrap && nav) {
    nav.id = nav.id || "site-nav";
    const tools = el("div", { className: "header-tools" }, searchBtn);
    if (!isCat) {
      themeBtn = el("button", { className: "icon-btn theme-btn", type: "button" });
      tools.append(themeBtn);
      applyTheme(root.getAttribute("data-theme") === "dark" ? "dark" : "light");
      themeBtn.addEventListener("click", () => {
        const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
        store.set(KEYS.theme, next);
        applyTheme(next);
      });
    }
    menuBtn = el("button", { className: "icon-btn menu-btn", type: "button", "aria-controls": nav.id, "aria-expanded": "false", "aria-label": "Open menu" });
    // both icons live in the button and CSS shows one, so a click never detaches its own target
    menuBtn.innerHTML = ICON.menu.replace("<svg ", '<svg class="i-open" ') + ICON.close.replace("<svg ", '<svg class="i-close" ');
    tools.append(menuBtn);
    headerWrap.append(tools);

    const setMenu = (open) => {
      header.classList.toggle("nav-open", open);
      menuBtn.setAttribute("aria-expanded", String(open));
      menuBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    };
    menuBtn.addEventListener("click", () => setMenu(!header.classList.contains("nav-open")));
    nav.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && header.classList.contains("nav-open")) { setMenu(false); menuBtn.focus(); }
    });
    document.addEventListener("click", (e) => { if (header.classList.contains("nav-open") && !e.composedPath().includes(header)) setMenu(false); });
    window.matchMedia("(min-width: 1001px)").addEventListener("change", (e) => { if (e.matches) setMenu(false); });
  }

  /* ---------- site search ---------- */
  const FAQ = [
    ["faq-sources", "Where do the numbers come from?"],
    ["faq-updates", "How often is the data updated?"],
    ["faq-ratings", "How is each measure rated?"],
    ["faq-hand", "What does “Hand-verified” mean?"],
    ["faq-fail", "What happens if a check fails?"],
    ["faq-privacy", "Does this site use cookies or track me?"],
    ["faq-errors", "I think a figure is wrong. What should I do?"],
    ["faq-reuse", "Can I reuse these figures?"],
  ];
  const PAGES = [
    { title: "Scorecard", url: "index.html", kind: "Page", text: "home report card all measures ratings on track off track" },
    { title: "Budget", url: "budget.html", kind: "Page", text: "federal budget revenue expenses spending tax where the money comes from goes pie chart" },
    { title: "Laws", url: "laws.html", kind: "Page", text: "legislation bills acts parliament passed failed repealed debated scheduled controversy controversial free speech privacy" },
    { title: "Categories", url: "categories.html", kind: "Page", text: "3d model map categories planets moons" },
    { title: "Sources & checks", url: "sources.html", kind: "Page", text: "sources verification daily automated checks log methods corrections publishers" },
    { title: "Subscribe", url: "subscribe.html", kind: "Page", text: "email updates alerts newsletter customise view preferences pin categories" },
    { title: "Suggest a measure", url: "subscribe.html#suggest", kind: "Page", text: "suggestion feedback contact missing metric" },
    { title: "Report an error", url: "sources.html#report-error", kind: "Page", text: "correction corrections mistake wrong figure incorrect fix contact" },
    ...FAQ.map(([id, q]) => ({ title: q, url: "sources.html#" + id, kind: "FAQ", text: "faq question help" })),
  ];
  const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ");
  const index = [];
  if (D) {
    const secTitle = Object.fromEntries(D.sections.map((s) => [s.id, s.title]));
    D.metrics.forEach((m) => {
      const hd = m.headline || {};
      const val = window.Charts ? window.Charts.fmtNum(hd.value, hd.unit === "$" ? "$" : hd.unit === "%" ? "%" : "", hd.decimals, { signed: hd.signed, compact: Math.abs(hd.value) >= 1e5 }) + (hd.unit !== "%" && hd.suffix ? hd.suffix : "") : "";
      index.push({ title: m.title, url: "index.html#" + m.id, kind: secTitle[m.section] || "Measure", status: m.status, val,
                   text: [m.question, hd.caption, hd.period, secTitle[m.section], (m.context || []).join(" ")].join(" ") });
    });
    D.sections.forEach((s) => index.push({ title: s.title, url: "index.html#sec-" + s.id, kind: "Category", text: s.blurb }));
  }
  PAGES.forEach((p) => index.push(p));
  index.forEach((e) => { e.nt = norm(e.title); e.nx = e.nt + " " + norm(e.text); });

  function search(q) {
    const terms = norm(q).split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const nq = terms.join(" ");
    return index
      .map((e, i) => {
        if (!terms.every((t) => e.nx.includes(t))) return null;
        let score = 0;
        if (e.nt === nq) score += 100;
        if (e.nt.startsWith(nq)) score += 50;
        terms.forEach((t) => { if (e.nt.includes(t)) score += 10; });
        if (e.kind === "FAQ" || e.kind === "Page") score -= 2;
        return { e, score, i };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, 12)
      .map((r) => r.e);
  }

  const input = el("input", { type: "search", id: "site-search-input", placeholder: "Search measures, topics and pages", autocomplete: "off", spellcheck: "false",
                              role: "combobox", "aria-expanded": "true", "aria-controls": "site-search-results", "aria-autocomplete": "list", "aria-label": "Search" });
  const closeSearch = el("button", { className: "icon-btn", type: "button", "aria-label": "Close search", html: ICON.close });
  const results = el("ul", { className: "search-results", id: "site-search-results", role: "listbox", "aria-label": "Results" });
  const status = el("p", { className: "sr-only", role: "status", "aria-live": "polite" });
  const searchDlg = el("dialog", { className: "search-dialog", "aria-label": "Search the site" },
    el("div", { className: "search-head", html: ICON.search }, input, closeSearch),
    results, status,
    el("p", { className: "search-foot", text: "↑ ↓ to move · Enter to open · Esc to close" }));
  body.appendChild(searchDlg);
  let active = -1, current = [];

  function drawResults() {
    const q = input.value.trim();
    current = q ? search(q) : index.filter((e) => e.kind === "Page");
    results.replaceChildren();
    active = current.length ? 0 : -1;
    if (q && !current.length) {
      results.append(el("li", { className: "search-empty", text: `No results for “${q}”. Try a topic like “wages”, “debt” or “power bills”.` }));
    }
    if (!q) results.append(el("li", { className: "search-hint", role: "presentation", text: "Pages" }));
    current.forEach((e, i) => {
      const a = el("a", { href: e.url, tabindex: "-1" });
      a.append(el("span", { className: "sr-dot " + (e.status || "page"), "aria-hidden": "true" }),
               el("span", {}, el("span", { className: "sr-title", text: e.title }), el("span", { className: "sr-meta", text: e.kind })),
               e.val ? el("span", { className: "sr-val", text: e.val }) : el("span"));
      results.append(el("li", { role: "option", id: "sr-" + i, "aria-selected": String(i === active) }, a));
    });
    input.setAttribute("aria-activedescendant", active >= 0 ? "sr-0" : "");
    status.textContent = q ? `${current.length} result${current.length === 1 ? "" : "s"}` : "";
  }
  function setActive(i) {
    if (!current.length) return;
    active = (i + current.length) % current.length;
    results.querySelectorAll("[role=option]").forEach((li, j) => li.setAttribute("aria-selected", String(j === active)));
    const li = document.getElementById("sr-" + active);
    input.setAttribute("aria-activedescendant", li.id);
    li.scrollIntoView({ block: "nearest" });
  }
  function openSearch(prefill) {
    if (searchDlg.open) return;
    input.value = prefill || "";
    drawResults();
    searchDlg.showModal();
    input.focus();
  }
  function go(url) {
    searchDlg.close();
    window.location.href = url;
  }
  input.addEventListener("input", drawResults);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); go(current[active].url); }
  });
  results.addEventListener("click", (e) => { if (e.target.closest("a")) searchDlg.close(); });
  closeSearch.addEventListener("click", () => searchDlg.close());
  searchDlg.addEventListener("click", (e) => { if (e.target === searchDlg) searchDlg.close(); });
  searchDlg.addEventListener("close", () => { if (document.activeElement === body || !document.activeElement) searchBtn.focus(); });
  searchBtn.addEventListener("click", () => openSearch());
  document.addEventListener("keydown", (e) => {
    const typing = e.target.closest && e.target.closest("input, textarea, select, [contenteditable]");
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchDlg.open ? searchDlg.close() : openSearch(); }
    else if (e.key === "/" && !typing && !document.querySelector("dialog[open]")) { e.preventDefault(); openSearch(); }
  });
  document.querySelectorAll("[data-open-search]").forEach((b) => b.addEventListener("click", () => openSearch(b.getAttribute("data-open-search"))));

  /* ---------- scroll progress, back to top, feedback ---------- */
  const bar = el("div", { className: "scroll-progress", "aria-hidden": "true" });
  body.appendChild(bar);
  const feedback = el("a", { className: "fab fab-feedback", href: "subscribe.html#suggest", html: ICON.chat + "<span>Feedback</span>", "aria-label": "Send feedback or suggest a measure" });
  const toTop = el("button", { className: "fab fab-top", type: "button", "aria-label": "Back to top", title: "Back to top", html: ICON.up });
  const fabs = el("div", { className: "fab-stack" }, toTop, feedback);
  body.appendChild(fabs);
  if (!document.getElementById("suggest")) feedback.classList.add("show");
  toTop.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
    const brand = document.querySelector(".site-header .brand");
    if (brand) brand.focus({ preventScroll: true });
  });
  const stage = document.querySelector(".cat-stage");
  let ticking = false;
  function onScroll() {
    ticking = false;
    const max = root.scrollHeight - window.innerHeight;
    const y = window.scrollY;
    bar.style.transform = `scaleX(${max > 0 ? Math.min(1, y / max) : 0})`;
    toTop.classList.toggle("show", y > Math.max(600, window.innerHeight * 0.8));
    if (stage) feedback.classList.toggle("show", y > stage.offsetHeight * 0.6);   // keep the 3D HUD clear
  }
  window.addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  window.addEventListener("resize", onScroll);
  onScroll();

  /* ---------- cookie notice (this site sets no cookies; it says so plainly) ---------- */
  if (!store.get(KEYS.cookie)) {
    const got = el("button", { className: "btn btn-red", type: "button", text: "Got it" });
    const notice = el("div", { className: "cookie-notice", role: "region", "aria-label": "Cookie notice" },
      el("p", {}, "This site doesn’t use tracking or advertising cookies. It only saves your own display choices, like theme and pinned categories, in this browser. ",
        el("a", { href: "sources.html#faq-privacy", text: "Privacy details" })),
      got);
    body.appendChild(notice);
    const lift = () => root.style.setProperty("--notice-h", notice.offsetHeight + 12 + "px");
    lift();
    window.addEventListener("resize", lift);
    got.addEventListener("click", () => {
      store.set(KEYS.cookie, new Date().toISOString());
      window.removeEventListener("resize", lift);
      root.style.removeProperty("--notice-h");
      const hadFocus = notice.contains(document.activeElement);
      notice.remove();
      if (hadFocus) (document.getElementById("content") || body).focus({ preventScroll: true });
    });
  }

  /* ---------- footer: data freshness + email signup ---------- */
  const footerText = document.querySelector(".site-footer .wrap > div");
  if (footerText && D) {
    footerText.append(el("p", { className: "footer-updated", text: `Data last checked ${fmtStamp(D.summary.generated_at)}.` }));
  }
  if (footerText && !document.getElementById("subscribe-form")) {
    const email = el("input", { type: "email", id: "footer-email", name: "email", required: "", autocomplete: "email", placeholder: "you@example.com" });
    const row = el("div", { className: "footer-signup-row" }, email, el("button", { className: "btn btn-red", type: "submit", text: "Sign up" }));
    const msg = el("p", { className: "footer-signup-msg", role: "status", "aria-live": "polite" });
    const form = el("form", { className: "footer-signup" },
      el("label", { for: "footer-email", text: "Get Scorecard updates by email" }), row, msg);
    addTrap(form);
    footerText.prepend(form);
    const showDone = (addr, fresh) => {
      row.hidden = true;
      msg.classList.remove("is-error");
      msg.innerHTML = ICON.check;
      msg.append(fresh ? "Thanks \u2014 you\u2019re signed up. " : `Signed up as ${addr}. `, el("a", { href: "subscribe.html#updates", text: "Manage" }));
    };
    const existing = store.json(KEYS.sub, null);
    if (existing && existing.email) showDone(existing.email, false);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const addr = email.value.trim();
      if (!addr || !email.checkValidity()) { email.reportValidity(); return; }
      const btn = row.querySelector("button");
      setBusy(btn, true, "Signing up\u2026");
      const res = await sendForm("Email sign-up", { email: addr, frequency: "Weekly digest", signed_up_from: "Footer" }, form);
      setBusy(btn, false);
      if (!res.ok) { msg.textContent = res.error; msg.classList.add("is-error"); return; }
      const prev = store.json(KEYS.sub, {}) || {};
      store.set(KEYS.sub, JSON.stringify({ frequency: "weekly", alertMetrics: [], ...prev, email: addr, updatedAt: new Date().toISOString() }));
      showDone(addr, true);
    });
  }

  /* ---------- outbound link tagging (UTM) ---------- */
  const UTM = { utm_source: "the-scorecard", utm_medium: "referral", utm_campaign: "source-link" };
  const DATA_FILE = /\.(csv|xlsx?|zip|json|xml)$/i;
  function tagLink(a) {
    if (a.dataset.utm) return;
    const href = a.getAttribute("href");
    if (!href || !/^https?:\/\//i.test(href)) return;
    let u;
    try { u = new URL(href); } catch (e) { return; }
    // raw data files and APIs can reject unknown query parameters, so they're left untouched
    if (u.origin === window.location.origin || /(^|\.)api\./i.test(u.hostname) || DATA_FILE.test(u.pathname) || u.searchParams.has("utm_source")) {
      a.dataset.utm = "skip";
      return;
    }
    Object.entries(UTM).forEach(([k, v]) => u.searchParams.set(k, v));
    a.href = u.toString();
    a.dataset.utm = "1";
  }
  const tagAll = (node) => {
    if (node.nodeType !== 1) return;
    if (node.matches("a[href]")) tagLink(node);
    node.querySelectorAll("a[href]").forEach(tagLink);
  };
  tagAll(body);
  new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach(tagAll))).observe(body, { childList: true, subtree: true });

  /* ---------- print: open source lists and FAQs so they appear on paper ---------- */
  const openedForPrint = [];
  window.addEventListener("beforeprint", () => {
    document.querySelectorAll("details.sources:not([open]), .faq details:not([open])").forEach((d) => { d.open = true; openedForPrint.push(d); });
  });
  window.addEventListener("afterprint", () => { openedForPrint.splice(0).forEach((d) => { d.open = false; }); });

  window.Site = { send: sendForm, busy: setBusy, confirm: confirmDialog, copy: copyText, store, keys: KEYS, fmtDate, fmtStamp, openSearch, icon: ICON };
})();
