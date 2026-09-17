/* The Scorecard: Laws page. Renders data/laws.js (hand-verified, link-checked daily by pipeline/update.py). */
(function () {
  const { h } = window.Charts;
  const L = window.LAWS;
  const list = document.getElementById("law-list");
  if (!L || !list) return;
  const fmtDate = window.Site ? window.Site.fmtDate : (d) => d;

  const STATUS = {
    scheduled: { label: "Scheduled for debate", short: "Scheduled", blurb: "Introduced to Parliament but not yet substantively debated." },
    debated: { label: "Being debated", short: "Debated", blurb: "Before Parliament now: under debate, passed one house, or with a committee." },
    passed: { label: "Passed", short: "Passed", blurb: "Passed both houses and became law." },
    failed: { label: "Failed", short: "Failed", blurb: "Defeated in a vote, withdrawn by the government, or lapsed." },
    repealed: { label: "Repealed", short: "Repealed", blurb: "Laws or schemes this government repealed or abolished." },
  };
  const ORDER = ["scheduled", "debated", "passed", "failed", "repealed"];
  const laws = L.laws.slice().sort((a, b) => (a.status_date < b.status_date ? 1 : a.status_date > b.status_date ? -1 : 0));

  // summary tiles
  const tiles = document.getElementById("law-tiles");
  ORDER.forEach((s) => {
    const n = laws.filter((l) => l.status === s).length;
    const t = h("button", "stat law-tile");
    t.type = "button"; t.dataset.status = s;
    t.append(h("div", "v", String(n)), h("div", "l", STATUS[s].label));
    t.addEventListener("click", () => setFilter(s === state.status ? "all" : s));
    tiles.appendChild(t);
  });
  const contro = laws.filter((l) => l.controversy).length;
  document.getElementById("law-count").textContent = `${laws.length} pieces of legislation since May 2022, ${contro} with documented controversy.`;
  if (L.generated_at && window.Site) document.getElementById("law-checked").textContent = `Links re-checked ${window.Site.fmtStamp(L.generated_at)}.`;

  // filters
  const state = { status: "all", contro: false, category: "all", q: "" };
  const statusBar = document.getElementById("law-status");
  const mkBtn = (val, label) => {
    const b = h("button", null, label); b.type = "button"; b.dataset.value = val;
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => setFilter(val));
    statusBar.appendChild(b); return b;
  };
  mkBtn("all", "All");
  ORDER.forEach((s) => mkBtn(s, STATUS[s].short));
  const catSel = document.getElementById("law-category");
  L.categories.forEach((c) => catSel.appendChild(new Option(c, c)));
  catSel.addEventListener("change", () => { state.category = catSel.value; if (state.category !== "all") state.contro = true; syncControls(); draw(); });
  const controBox = document.getElementById("law-contro");
  controBox.addEventListener("change", () => { state.contro = controBox.checked; if (!state.contro) { state.category = "all"; catSel.value = "all"; } syncControls(); draw(); });
  const search = document.getElementById("law-search");
  search.addEventListener("input", () => { state.q = search.value.trim().toLowerCase(); draw(); });

  function setFilter(val) {
    state.status = val;
    syncControls();
    draw();
  }
  function syncControls() {
    statusBar.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === state.status)));
    tiles.querySelectorAll(".law-tile").forEach((t) => t.classList.toggle("active", t.dataset.status === state.status));
    controBox.checked = state.contro;
    document.getElementById("law-category-wrap").hidden = !state.contro;
  }

  function card(l) {
    const c = h("article", "card law-card");
    c.id = l.id;
    const top = h("div", "card-top");
    const badges = h("div", "law-badges");
    badges.appendChild(h("span", "law-status " + l.status, STATUS[l.status].short));
    if (l.controversy) badges.appendChild(h("span", "law-flag", "Controversy: " + l.controversy.category));
    if (l.recheck_overdue) badges.appendChild(h("span", "law-recheck", "Status re-check due"));
    top.appendChild(badges);
    top.appendChild(h("span", "law-date", fmtDate(l.status_date)));
    c.appendChild(top);
    const title = h("h3");
    const a = h("a", null, l.title); a.href = l.parliament_url; a.target = "_blank"; a.rel = "noopener";
    title.appendChild(a); c.appendChild(title);
    c.appendChild(h("p", "law-note", l.status_note));
    c.appendChild(h("p", "law-summary", l.summary));
    if (l.controversy) {
      const box = h("div", "law-contro");
      box.appendChild(h("h4", null, "Why it was controversial"));
      box.appendChild(h("p", null, l.controversy.summary));
      const meta = h("p", "law-raised");
      meta.appendChild(h("b", null, "Raised by: "));
      meta.appendChild(document.createTextNode(l.controversy.raised_by.join(", ")));
      box.appendChild(meta);
      const ul = h("ul", "law-sources");
      l.controversy.sources.forEach((s) => { const li = h("li"); const sa = h("a", null, s.title); sa.href = s.url; sa.target = "_blank"; sa.rel = "noopener"; li.appendChild(sa); ul.appendChild(li); });
      box.appendChild(ul);
      c.appendChild(box);
    }
    const foot = h("div", "law-links");
    const p = h("a", "btn btn-ghost", "Bill page: Parliament of Australia"); p.href = l.parliament_url; p.target = "_blank"; p.rel = "noopener"; foot.appendChild(p);
    if (l.legislation_url) { const g = h("a", "btn btn-ghost", "Act text: legislation.gov.au"); g.href = l.legislation_url; g.target = "_blank"; g.rel = "noopener"; foot.appendChild(g); }
    foot.appendChild(h("span", "law-verified", "Verified " + fmtDate(l.verified_on)));
    c.appendChild(foot);
    return c;
  }

  function draw() {
    list.replaceChildren();
    let rows = laws;
    if (state.status !== "all") rows = rows.filter((l) => l.status === state.status);
    if (state.contro) rows = rows.filter((l) => l.controversy && (state.category === "all" || l.controversy.category === state.category));
    if (state.q) rows = rows.filter((l) => (l.title + " " + l.summary + " " + (l.controversy ? l.controversy.summary + " " + l.controversy.category : "")).toLowerCase().includes(state.q));
    const head = document.getElementById("law-heading");
    head.textContent = state.status === "all" ? "All legislation, most recent first" : STATUS[state.status].label + ", most recent first";
    document.getElementById("law-blurb").textContent = state.status === "all" ? "" : STATUS[state.status].blurb;
    if (!rows.length) { list.appendChild(h("p", "law-empty", "Nothing matches those filters.")); return; }
    rows.forEach((l) => list.appendChild(card(l)));
  }

  const wanted = location.hash.slice(1);
  syncControls();
  draw();
  if (wanted && document.getElementById(wanted)) setTimeout(() => document.getElementById(wanted).scrollIntoView(), 50);
})();
