/* The Scorecard: Controversies page. Renders data/controversies.js (hand-verified, link-checked daily). */
(function () {
  const { h } = window.Charts;
  const C = window.CONTROVERSIES;
  const list = document.getElementById("con-list");
  if (!C || !list) return;
  const fmtDate = window.Site ? window.Site.fmtDate : (d) => d;
  const STATUS = { ongoing: "Ongoing", resolved: "Resolved", "no-finding": "No formal finding" };
  const items = C.items.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const state = { category: "all", minister: "all", status: "all", q: "" };

  const tiles = document.getElementById("con-tiles");
  C.categories.forEach((cat) => {
    const n = items.filter((i) => i.category === cat).length;
    if (!n) return;
    const t = h("button", "stat law-tile"); t.type = "button"; t.dataset.category = cat;
    t.append(h("div", "v", String(n)), h("div", "l", cat));
    t.addEventListener("click", () => { state.category = state.category === cat ? "all" : cat; sync(); draw(); });
    tiles.appendChild(t);
  });
  const ministers = Array.from(new Set(items.map((i) => i.minister))).sort();
  const minSel = document.getElementById("con-minister");
  ministers.forEach((m) => minSel.appendChild(new Option(`${m} (${items.filter((i) => i.minister === m).length})`, m)));
  minSel.addEventListener("change", () => { state.minister = minSel.value; draw(); });
  const stSel = document.getElementById("con-status");
  stSel.addEventListener("change", () => { state.status = stSel.value; draw(); });
  const search = document.getElementById("con-search");
  search.addEventListener("input", () => { state.q = search.value.trim().toLowerCase(); draw(); });

  document.getElementById("con-count").textContent = `${items.length} documented controversies since May 2022, involving ${ministers.length} ministers.`;
  if (C.generated_at && window.Site) document.getElementById("con-checked").textContent = `Links re-checked ${window.Site.fmtStamp(C.generated_at)}.`;

  function sync() {
    tiles.querySelectorAll(".law-tile").forEach((t) => t.classList.toggle("active", t.dataset.category === state.category));
  }

  function card(i) {
    const c = h("article", "card law-card"); c.id = i.id;
    const top = h("div", "card-top");
    const badges = h("div", "law-badges");
    badges.appendChild(h("span", "law-status " + i.status, STATUS[i.status] || i.status));
    badges.appendChild(h("span", "law-flag con-cat", i.category));
    if (i.recheck_overdue) badges.appendChild(h("span", "law-recheck", "Re-check due"));
    top.appendChild(badges);
    top.appendChild(h("span", "law-date", fmtDate(i.date)));
    c.appendChild(top);
    c.appendChild(h("h3", null, i.title));
    c.appendChild(h("p", "law-note", `${i.minister} · ${i.portfolio}`));
    const what = h("div", "con-block"); what.append(h("h4", null, "What happened"), h("p", null, i.summary)); c.appendChild(what);
    const resp = h("div", "con-block"); resp.append(h("h4", null, "The response"), h("p", null, i.response)); c.appendChild(resp);
    const out = h("div", "con-block con-outcome"); out.append(h("h4", null, "Outcome"), h("p", null, i.outcome)); c.appendChild(out);
    const ul = h("ul", "law-sources");
    i.sources.forEach((s) => { const li = h("li"); const a = h("a", null, s.title + (s.date ? " (" + fmtDate(s.date) + ")" : "")); a.href = s.url; a.target = "_blank"; a.rel = "noopener"; li.appendChild(a); ul.appendChild(li); });
    c.appendChild(ul);
    const foot = h("div", "law-links");
    const say = h("a", "btn btn-ghost", "Have your say"); say.href = "subscribe.html?law=" + encodeURIComponent(i.title) + "#suggest"; foot.appendChild(say);
    foot.appendChild(h("span", "law-verified", "Verified " + fmtDate(i.verified_on)));
    c.appendChild(foot);
    return c;
  }

  function draw() {
    list.replaceChildren();
    let rows = items;
    if (state.category !== "all") rows = rows.filter((i) => i.category === state.category);
    if (state.minister !== "all") rows = rows.filter((i) => i.minister === state.minister);
    if (state.status !== "all") rows = rows.filter((i) => i.status === state.status);
    if (state.q) rows = rows.filter((i) => [i.title, i.minister, i.portfolio, i.summary, i.response, i.outcome, i.category].join(" ").toLowerCase().includes(state.q));
    document.getElementById("con-heading").textContent = (state.category === "all" ? "All controversies" : state.category) + ", most recent first";
    if (!rows.length) { list.appendChild(h("p", "law-empty", "Nothing matches those filters.")); return; }
    rows.forEach((i) => list.appendChild(card(i)));
  }
  sync(); draw();
  const wanted = location.hash.slice(1);
  if (wanted && document.getElementById(wanted)) setTimeout(() => document.getElementById(wanted).scrollIntoView(), 50);
})();
