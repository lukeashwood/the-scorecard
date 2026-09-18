/* The Scorecard: Build your own budget. Always starts from the current Budget shown on the Budget page (data/metrics.js,
   budget.years[0]), so it follows each new Budget automatically; edits are never restored on reload.
   Everything here is arithmetic on those published figures, recalculated as the visitor edits; it is not an economic model. */
window.addEventListener("error", () => {
  const s = document.getElementById("bb-status");
  if (s) s.textContent = "Part of this page didn't load properly. Please refresh the page (on a phone, pull down to reload).";
});
(function () {
  const { h, pieChart } = window.Charts;
  const B = window.SCORECARD && window.SCORECARD.budget;
  const app = document.getElementById("bb-app");
  if (!B || !app) return;
  const Y = B.years[0];
  const GDP = Y.gdp_m;                        // nominal GDP, $m
  const POP = Y.population;                   // people
  const DEF_FUNDING = Y.defence_funding_m;    // defence funding, traditional measure, $m
  const BASE_DEBT = Y.gross_debt_bn * 1000;   // $m at 30 June of the budget year
  const PRIOR_DEBT = Y.gross_debt_prior_bn ? Y.gross_debt_prior_bn * 1000 : BASE_DEBT;
  const FY_END = "30 June 20" + Y.year.slice(-2);
  const REV_COLORS = ["#3f4bc0", "#C82028", "#6da7ec", "#eda100", "#8a4f9e", "#1baf7a"];
  const EXP_COLORS = ["#3f4bc0", "#C82028", "#6da7ec", "#eda100", "#e87ba4", "#8a4f9e", "#1baf7a"];

  const KINDS = ["revenue", "expenses"];
  const names = { revenue: Y.revenue.map((c) => c.name), expenses: Y.expenses.map((c) => c.name) };
  const base = { revenue: Y.revenue.map((c) => c.value_m), expenses: Y.expenses.map((c) => c.value_m) };
  const find = (kind, re) => names[kind].findIndex((n) => re.test(n));
  const I = {
    interest: find("expenses", /interest/i), defence: find("expenses", /^defence/i), states: find("expenses", /states/i),
    nontax: find("revenue", /non-tax/i), pit: find("revenue", /personal income/i), gst: find("revenue", /^gst/i),
  };
  const NOTES = {
    ["expenses:" + I.interest]: "Interest is set by existing debt and interest rates, not by decision. Borrowing more this year raises it in later years (see “What your budget means”).",
    ["expenses:" + I.defence]: `This is Defence's expense line (${pctOf(base.expenses[I.defence], GDP)} of GDP). The widely quoted ${(DEF_FUNDING / GDP * 100).toFixed(2)}% uses Defence funding ($${(DEF_FUNDING / 1000).toFixed(1)}bn), which also counts equipment purchases. The 3.5% button adds the extra funding that target implies.`,
    ["revenue:" + I.gst]: "GST is collected by the Commonwealth and passed to the states, so it also appears in “Payments to states”. Changing it here doesn't change that line automatically.",
  };

  const clone = (o) => ({ revenue: o.revenue.slice(), expenses: o.expenses.slice() });
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  function pctOf(v, of) { return (v / of * 100).toFixed(1) + "%"; }
  const bn = (m, d = 1) => (m < 0 ? "−" : "") + "$" + (Math.abs(m) / 1000).toLocaleString("en-AU", { minimumFractionDigits: d, maximumFractionDigits: d }) + "bn";
  const signedBn = (m, d = 1) => (m > 0 ? "+" : m < 0 ? "−" : "±") + "$" + (Math.abs(m) / 1000).toLocaleString("en-AU", { minimumFractionDigits: d, maximumFractionDigits: d }) + "bn";
  const money = (v) => "$" + Math.round(Math.abs(v)).toLocaleString("en-AU");

  /* ---------- state: always the Budget; a shared link is offered, never applied silently ---------- */
  /* tax rates: Y.tax_rates holds the rates in force for the Budget year and the ATO income distribution used to cost changes */
  const TX = Y.tax_rates || null;
  const cloneRates = (t) => ({ gst: t.gst, ml: t.ml, br: t.br.map((b) => b.slice()), split: t.split | 0 });
  const baseRates = TX ? { gst: TX.gst_rate, ml: TX.medicare_levy, br: TX.brackets.map((b) => b.slice()), split: 0 } : null;
  let rates = baseRates && cloneRates(baseRates);
  const encRates = (t) => [t.gst, t.ml, ...t.br.map((b) => b[0] + ":" + b[1]), String(t.split | 0)].join("_");
  function decRates(str) {
    if (!baseRates || !str) return null;
    const p = str.split("_");
    const n = baseRates.br.length;
    if (p.length !== 2 + n && p.length !== 3 + n) return null;
    const br = p.slice(2, 2 + n).map((x) => x.split(":").map(Number));
    const t = { gst: Number(p[0]), ml: Number(p[1]), br, split: [0, 1, 2].includes(Number(p[2 + n])) ? Number(p[2 + n]) : 0 };
    const nums = [t.gst, t.ml, ...br.flat()];
    if (nums.some((x) => !isFinite(x) || x < 0) || br.some((b) => b.length !== 2 || b[1] > 100)) return null;
    return t;
  }

  /* migration: B.migration holds the Budget's net overseas migration forecast, the planned permanent program, and the
     published rules of thumb and evidence used to describe what a change would do. Kept separate from the budget lines. */
  const MG = B.migration || null;
  const MIG_KEYS = MG ? [...MG.components.filter((c) => !c.fixed).map((c) => c.id), ...MG.program.map((p) => p.id)] : [];
  const baseMig = MG ? Object.fromEntries([...MG.components.filter((c) => !c.fixed).map((c) => [c.id, c.value]), ...MG.program.map((p) => [p.id, p.places])]) : null;
  let mig = baseMig && { ...baseMig };
  const encMig = (m) => MIG_KEYS.map((k) => Math.round(m[k])).join("_");
  function decMig(str) {
    if (!baseMig || !str) return null;
    const v = str.split("_").map(Number);
    if (v.length !== MIG_KEYS.length || v.some((x) => !isFinite(x) || x < 0 || x > 5e6)) return null;
    return Object.fromEntries(MIG_KEYS.map((k, i) => [k, v[i]]));
  }

  function decode(str) {
    const m = /^v1:r=([\d,.]+);e=([\d,.]+)(?:;t=([\d.:_]+))?(?:;m=([\d_]+))?$/.exec(str || "");
    if (!m) return null;
    const r = m[1].split(",").map(Number), e = m[2].split(",").map(Number);
    if (r.length !== base.revenue.length || e.length !== base.expenses.length || [...r, ...e].some((x) => !isFinite(x) || x < 0)) return null;
    return { revenue: r, expenses: e, rates: decRates(m[3]), mig: decMig(m[4]) };
  }
  const encode = (s) => `v1:r=${s.revenue.map(Math.round).join(",")};e=${s.expenses.map(Math.round).join(",")}` + (rates ? ";t=" + encRates(rates) : "") + (mig ? ";m=" + encMig(mig) : "");
  let cur = clone(base);
  let mode = "deficit";
  let note = "";
  const shared = decode(decodeURIComponent(location.hash.slice(1)));
  if (shared) {
    const bar = document.getElementById("bb-shared");
    bar.hidden = false;
    document.getElementById("bb-load-shared").addEventListener("click", () => { cur = clone(shared); if (shared.rates) rates = shared.rates; if (shared.mig) mig = shared.mig; note = "Loaded the budget from the link you opened."; bar.hidden = true; changed(); });
  }

  /* ---------- editing ---------- */
  // Move `amount` across the eligible lines of one side, in proportion to their size. Interest (not a choice) and
  // non-tax revenue (not a tax) are never used to offset. Returns how much could not be applied.
  function spread(kind, amount, except) {
    const elig = cur[kind].map((v, j) => j).filter((j) => j !== except && !(kind === "expenses" && j === I.interest) && !(kind === "revenue" && j === I.nontax));
    const pool = sum(elig.map((j) => cur[kind][j]));
    if (!pool) return amount;
    const applied = amount < 0 ? Math.max(amount, -pool) : amount;
    elig.forEach((j) => { cur[kind][j] += applied * cur[kind][j] / pool; });
    return amount - applied;
  }
  function setLine(kind, i, v) {
    v = Math.max(0, v);
    const delta = v - cur[kind][i];
    if (!delta) return;
    cur[kind][i] = v;
    let left = 0;
    if (mode === "spending") left = spread("expenses", kind === "expenses" ? -delta : delta, kind === "expenses" ? i : -1);
    if (mode === "taxes") left = spread("revenue", kind === "revenue" ? -delta : delta, kind === "revenue" ? i : -1);
    note = Math.abs(left) > 1 ? `There wasn't enough left to take ${bn(Math.abs(left))} from, so that part adds to the ${mode === "taxes" ? "balance" : "deficit"}.` : "";
    changed();
  }

  /* ---------- controls ---------- */
  const rows = {};
  function buildRows(kind, box) {
    rows[kind] = names[kind].map((name, i) => {
      const row = h("div", "bb-row");
      const head = h("div", "bb-head");
      const title = h("div", "bb-name");
      const sw = h("span", "swatch"); sw.style.background = (kind === "revenue" ? REV_COLORS : EXP_COLORS)[i];
      title.append(sw, document.createTextNode(name));
      const meta = h("div", "bb-meta");
      head.append(title, meta);
      const slider = h("input"); slider.type = "range"; slider.min = "0"; slider.step = String(Math.max(10, Math.round(base[kind][i] / 400)));
      slider.setAttribute("aria-label", name + ", $ amount");
      const dollar = h("input", "bb-num"); dollar.type = "number"; dollar.min = "0"; dollar.step = "0.1"; dollar.inputMode = "decimal";
      dollar.setAttribute("aria-label", name + ", $ billion");
      const pct = h("input", "bb-num"); pct.type = "number"; pct.min = "0"; pct.step = "0.01"; pct.inputMode = "decimal";
      pct.setAttribute("aria-label", name + ", % of GDP");
      const reset = h("button", "bb-reset", "Reset"); reset.type = "button"; reset.setAttribute("aria-label", "Reset " + name + " to the Budget figure");
      const fields = h("div", "bb-fields");
      const lab1 = h("label", "bb-field"); lab1.append(h("span", null, "$bn"), dollar);
      const lab2 = h("label", "bb-field"); lab2.append(h("span", null, "% of GDP"), pct);
      const delta = h("span", "bb-delta");
      fields.append(lab1, lab2, delta, reset);
      row.append(head, slider, fields);
      const n = NOTES[kind + ":" + i];
      if (n) {
        const p = h("p", "bb-note", n);
        if (kind === "expenses" && i === I.defence) {
          const b = h("button", "btn btn-ghost bb-inline", "Set to 3.5% of GDP"); b.type = "button";
          b.addEventListener("click", () => preset("defence"));
          p.append(" ", b);
        }
        row.appendChild(p);
      }
      slider.addEventListener("input", () => setLine(kind, i, Number(slider.value)));
      dollar.addEventListener("input", () => { if (dollar.value !== "" && isFinite(dollar.value)) setLine(kind, i, Number(dollar.value) * 1000); });
      pct.addEventListener("input", () => { if (pct.value !== "" && isFinite(pct.value)) setLine(kind, i, Number(pct.value) / 100 * GDP); });
      reset.addEventListener("click", () => {
        if (rates && kind === "revenue" && i === I.pit) { rates.br = cloneRates(baseRates).br; rates.ml = baseRates.ml; }
        if (rates && kind === "revenue" && i === I.gst) rates.gst = baseRates.gst;
        setLine(kind, i, base[kind][i]);
      });
      box.appendChild(row);
      return { slider, dollar, pct, delta, meta, reset };
    });
  }
  buildRows("revenue", document.getElementById("bb-revenue"));
  buildRows("expenses", document.getElementById("bb-expenses"));

  const modeBox = document.getElementById("bb-mode");
  [["deficit", "Borrow the difference"], ["spending", "Change other spending"], ["taxes", "Change taxes"]].forEach(([v, label]) => {
    const b = h("button", null, label); b.type = "button"; b.dataset.value = v;
    b.addEventListener("click", () => { mode = v; syncMode(); });
    modeBox.appendChild(b);
  });
  const MODE_HELP = {
    deficit: "When you change a line, nothing else moves: extra spending or lower taxes add to the deficit, which is borrowed.",
    spending: "When you change a line, other spending moves the opposite way, in proportion to its size, so the bottom line stays the same.",
    taxes: "When you change a line, taxes move to cover it, spread across every tax in proportion to its size, so the bottom line stays the same.",
  };
  function syncMode() {
    modeBox.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === mode)));
    document.getElementById("bb-mode-help").textContent = MODE_HELP[mode];
  }

  function preset(which) {
    note = "";
    if (which === "defence") {
      const target = base.expenses[I.defence] + (0.035 * GDP - DEF_FUNDING);
      setLine("expenses", I.defence, target);
      note = `Defence set so funding reaches 3.5% of GDP: ${bn(0.035 * GDP)}, an extra ${bn(0.035 * GDP - DEF_FUNDING)} a year. ` + (note || "");
    } else if (which === "cuts") {
      spread("expenses", sum(cur.revenue) - sum(cur.expenses), -1);
      note = "Spending (other than interest) scaled so the budget balances.";
    } else if (which === "taxes") {
      spread("revenue", sum(cur.expenses) - sum(cur.revenue), -1);
      note = "Taxes scaled so the budget balances.";
    } else if (which === "pit") {
      setLine("revenue", I.pit, cur.revenue[I.pit] * 0.9);
      note = "Personal income tax cut by 10%. " + (note || "");
    }
    changed();
  }
  document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => preset(b.dataset.preset)));

  document.getElementById("bb-reset-all").addEventListener("click", async () => {
    const ok = window.Site ? await window.Site.confirm({ title: "Start again from the Budget?", body: `This puts every figure back to the government's ${Y.year} Budget. Your changes will be lost unless you've copied your link.`, confirm: "Start again" }) : true;
    if (!ok) return;
    cur = clone(base); if (baseRates) rates = cloneRates(baseRates); if (baseMig) mig = { ...baseMig }; note = ""; changed();
  });
  document.getElementById("bb-share").addEventListener("click", async (e) => {
    const url = location.href.split("#")[0] + "#" + encodeURIComponent(encode(cur));
    const ok = window.Site ? await window.Site.copy(url) : false;
    e.target.textContent = ok ? "Link copied" : "Copy failed";
    setTimeout(() => (e.target.textContent = "Copy link to my budget"), 2200);
  });

  /* ---------- tax rates ---------- */
  // Personal income tax for one person at taxable income x, under rate set t: the resident scale, less the low income
  // tax offset (non-refundable; it can't reduce the Medicare levy), plus the Medicare levy with its low-income shade-in.
  function personTax(x, t) {
    let tax = 0;
    t.br.forEach((b, k) => {
      const lo = b[0], hi = k + 1 < t.br.length ? t.br[k + 1][0] : Infinity;
      if (x > lo) tax += (Math.min(x, hi) - lo) * b[1] / 100;
    });
    const L = TX.lito;
    let lito = 0;
    if (L) {
      lito = x <= L.full_to ? L.max : x <= L.mid_to ? L.max - (x - L.full_to) * L.rate1 : Math.max(0, L.mid_value - (x - L.mid_to) * L.rate2);
    }
    tax = Math.max(0, tax - lito);
    const low = TX.medicare_low || 0;
    const levy = x <= low ? 0 : Math.min(0.1 * (x - low), x * t.ml / 100);
    return tax + levy;
  }
  // Tax paid by everyone, using the ATO's count of people and total taxable income in each income band, with incomes
  // grown to the Budget year by wage growth. Each band is spread across five points so thresholds inside it are felt.
  const POINTS = (() => {
    if (!TX) return [];
    const g = TX.distribution.growth || 1, pts = [];
    TX.distribution.bands.forEach(([lo, hi, n, total]) => {
      if (!n) return;
      const mean = total / n;
      let xs;
      if (hi == null) xs = [mean];
      else {
        xs = [0, 1, 2, 3, 4].map((k) => lo + (k + 0.5) / 5 * (hi - lo));
        const avg = xs.reduce((a, b) => a + b, 0) / 5, f = avg ? mean / avg : 1;
        xs = xs.map((x) => x * f);
      }
      xs.forEach((x) => pts.push([x * g, n / xs.length]));
    });
    return pts;
  })();
  const totalTax = (t) => POINTS.reduce((a, [x, n]) => a + n * personTax(x, t), 0);
  const BASE_TOTAL = TX ? totalTax(baseRates) : 0;
  // Revenue under the visitor's rates: the Budget's own income tax figure, scaled by how much more or less tax the same
  // people would pay. Static: people's incomes and behaviour are assumed not to change.
  // Income splitting: each couple may be taxed as if each partner earned half their combined income. Costed on the ATO
  // sample of couples' incomes (TX.couples.cells: [own income, partner income, number of couples]); a couple only splits
  // if it lowers their tax.
  const CP = TX && TX.couples ? TX.couples.cells.map(([a, b, n]) => [a * TX.couples.growth, b * TX.couples.growth, n]) : null;
  const splitGain = (x, y, t) => Math.max(0, personTax(x, t) + personTax(y, t) - 2 * personTax((x + y) / 2, t));
  const splitCost = (t) => CP ? CP.reduce((a, [x, y, n]) => a + n * splitGain(x, y, t), 0) : 0;
  // Couples with children: the sample doesn't record children, so their share of the all-couples cost is set from the
  // PBO's costing of that design (TX.couples.pbo), computed at the tax rates the PBO costed it under.
  const KIDS_SHARE = CP && TX.couples.pbo && Array.isArray(TX.couples.pbo.brackets) ? Math.min(1, TX.couples.pbo.cost_m * 1e6 / splitCost({ ...baseRates, br: TX.couples.pbo.brackets })) : 0;
  const splitCostFor = (t) => t.split === 1 ? splitCost(t) : t.split === 2 ? splitCost(t) * KIDS_SHARE : 0;   // $
  const pitFromRates = () => base.revenue[I.pit] * totalTax(rates) / BASE_TOTAL - splitCostFor(rates) / 1e6;
  const gstFromRates = () => base.revenue[I.gst] * rates.gst / baseRates.gst;

  const ratesBox = document.getElementById("bb-rates");
  const rateUI = {};
  if (TX && ratesBox && I.pit >= 0 && I.gst >= 0) {
    ratesBox.hidden = false;
    const num = (id, label, step, max) => {
      const i = h("input", "bb-num"); i.type = "number"; i.id = id; i.min = "0"; i.step = step; i.inputMode = "decimal";
      if (max) i.max = max;
      i.setAttribute("aria-label", label);
      return i;
    };
    const applyPit = () => { setLine("revenue", I.pit, pitFromRates()); };
    // GST
    const gst = num("bb-rate-gst", "GST rate, per cent", "0.5", "50");
    gst.addEventListener("input", () => { const v = Number(gst.value); if (gst.value !== "" && isFinite(v) && v >= 0 && v <= 50) { rates.gst = v; setLine("revenue", I.gst, gstFromRates()); } });
    document.getElementById("bb-gst-field").append(gst);
    rateUI.gst = gst;
    // income tax scale
    const tb = document.getElementById("bb-brackets");
    rateUI.br = rates.br.map((b, k) => {
      const tr = h("tr");
      const th = num("bb-th-" + k, `Income tax bracket ${k + 1}, starts above this income`, "1000");
      const rt = num("bb-rt-" + k, `Income tax bracket ${k + 1}, rate per cent`, "0.5", "100");
      const upto = h("td", "bb-upto");
      if (k === 0) { th.disabled = true; th.setAttribute("aria-label", "First bracket starts at $0"); }
      th.addEventListener("change", () => {
        const v = Math.round(Number(th.value));
        const lo = k > 0 ? rates.br[k - 1][0] + 1 : 0, hi = k + 1 < rates.br.length ? rates.br[k + 1][0] - 1 : Infinity;
        if (th.value === "" || !isFinite(v) || v < lo || v > hi) { note = `That threshold must sit between the brackets either side of it (${money(lo)} to ${hi === Infinity ? "any amount" : money(hi)}).`; changed(); return; }
        rates.br[k][0] = v; applyPit();
      });
      rt.addEventListener("input", () => { const v = Number(rt.value); if (rt.value !== "" && isFinite(v) && v >= 0 && v <= 100) { rates.br[k][1] = v; applyPit(); } });
      const c1 = h("td"); const w1 = h("span", "bb-dollar"); w1.append("$", th); c1.append(w1);
      const c2 = h("td"); const w2 = h("span", "bb-pct"); w2.append(rt, "%"); c2.append(w2);
      tr.append(c1, upto, c2, h("td", "bb-was"));
      tb.appendChild(tr);
      return { th, rt, upto, was: tr.lastChild };
    });
    // Medicare levy
    const ml = num("bb-rate-ml", "Medicare levy, per cent", "0.1", "10");
    ml.addEventListener("input", () => { const v = Number(ml.value); if (ml.value !== "" && isFinite(v) && v >= 0 && v <= 10) { rates.ml = v; applyPit(); } });
    document.getElementById("bb-ml-field").append(ml);
    rateUI.ml = ml;
    // income splitting for couples
    const sws = [...document.querySelectorAll('input[name="bb-split"]')];
    sws.forEach((r) => {
      if ((!CP && r.value !== "0") || (!KIDS_SHARE && r.value === "2")) r.disabled = true;
      r.addEventListener("change", () => { if (r.checked) { rates.split = Number(r.value); applyPit(); } });
    });
    rateUI.split = sws;
    ["bb-couple-income", "bb-couple-share"].forEach((id) => document.getElementById(id).addEventListener("input", () => changed()));
    const dist = TX.distribution;
    document.getElementById("bb-rates-method").innerHTML =
      `Costed on the ATO's count of ${Math.round(dist.bands.reduce((a, b) => a + b[2], 0) / 1e5) / 10} million resident taxpayers by income (<a href="${dist.url}">${dist.income_year} tax statistics</a>), with incomes grown to ${TX.income_year} by wage growth. ` +
      `Includes the <a href="${TX.lito_url}">low income tax offset</a> and the Medicare levy's low-income phase-in. Assumes nobody changes how much they earn in response. ` +
      `Starting rates: <a href="${TX.brackets_url}">ATO, ${TX.income_year}</a>. A GST change scales GST revenue in proportion to the rate.`;
    document.getElementById("bb-rates-reset").addEventListener("click", () => {
      rates = cloneRates(baseRates);
      setLine("revenue", I.gst, base.revenue[I.gst]);
      setLine("revenue", I.pit, base.revenue[I.pit]);
    });
  }
  const TYPICAL = [30000, 50000, 75000, 100000, 150000, 200000, 300000];
  function renderRates() {
    if (!rateUI.gst) return;
    const active = document.activeElement;
    if (active !== rateUI.gst) rateUI.gst.value = String(rates.gst);
    if (active !== rateUI.ml) rateUI.ml.value = String(rates.ml);
    rateUI.br.forEach((u, k) => {
      if (active !== u.th) u.th.value = String(rates.br[k][0]);
      if (active !== u.rt) u.rt.value = String(rates.br[k][1]);
      const next = rates.br[k + 1];
      u.upto.textContent = next ? "to " + money(next[0]) : "and over";
      const b0 = baseRates.br[k], same = b0[0] === rates.br[k][0] && b0[1] === rates.br[k][1];
      u.was.textContent = same ? "" : `Budget: ${k ? "over " + money(b0[0]) : "$0"}, ${b0[1]}%`;
      u.upto.parentNode.classList.toggle("bb-changed", !same);
      u.upto.parentNode.title = same ? "" : `Budget: ${k ? "over " + money(b0[0]) : "$0"}, ${b0[1]}%`;
    });
    // tax on typical incomes, Budget rates vs yours
    const body = document.getElementById("bb-typical");
    body.replaceChildren(...TYPICAL.map((x) => {
      const a = personTax(x, baseRates), b = personTax(x, rates), d = b - a;
      const tr = h("tr");
      const dc = h("td", "num" + (Math.abs(d) < 1 ? "" : d > 0 ? " bb-more" : " bb-less"), Math.abs(d) < 1 ? "No change" : (d > 0 ? "+" : "−") + money(d) + " a year");
      tr.append(h("td", null, money(x)), h("td", "num", money(a)), h("td", "num", money(b)), dc);
      return tr;
    }));
    const pitGap = Math.abs(cur.revenue[I.pit] - pitFromRates()) > 50, gstGap = Math.abs(cur.revenue[I.gst] - gstFromRates()) > 50;
    const drift = document.getElementById("bb-rates-drift");
    drift.hidden = !(pitGap || gstGap);
    drift.textContent = `You've also changed ${pitGap && gstGap ? "income tax and GST" : pitGap ? "income tax" : "GST"} directly (or through an example or by paying for another change), so ${pitGap && gstGap ? "those dollar figures" : "that dollar figure"} no longer come${pitGap && gstGap ? "" : "s"} only from the rates here. Changing a rate resets it to what the rates raise.`;
    document.getElementById("bb-rates-reset").hidden = JSON.stringify(rates) === JSON.stringify(baseRates);
    // splitting: switch state, national cost, and the couple calculator
    rateUI.split.forEach((r) => { r.checked = Number(r.value) === rates.split; });
    const costAll = CP ? splitCost(rates) / 1e6 : null, costKids = costAll * KIDS_SHARE;   // $m
    const which = JSON.stringify({ ...rates, split: 0 }) !== JSON.stringify(baseRates) ? "your" : "current";
    const taken = (k) => rates.split === k ? " <i>(taken off your income tax line)</i>" : "";
    document.getElementById("bb-split-cost").innerHTML = !CP
      ? "The national cost can't be estimated, so income splitting can't be switched on. The calculator below still works."
      : `Estimated cost a year at ${which} rates: <b>all couples, roughly ${bn(costAll, 1)}</b>${taken(1)}; <b>couples with at least one child, roughly ${bn(costKids, 1)}</b>${taken(2)}. ` +
        `The figure for couples with children is anchored to the <a href="${TX.couples.pbo.url}">${TX.couples.pbo.source}</a> costing of that design: ${bn(TX.couples.pbo.cost_m, 1)} in ${TX.couples.pbo.year}, ${TX.couples.pbo.timing}. The PBO assumed ${TX.couples.pbo.take_up}. The estimate here moves with your rates. ` +
        `The all-couples figure uses the <a href="${TX.couples.url}">ATO's ${TX.couples.income_year} sample of couples' incomes</a> (the latest with both partners' incomes), grown to today's wages and scaled to today's ${(TX.couples.count / 1e6).toFixed(1)} million couple families, and assumes nobody changes how much they work. Treat it as a rough guide.`;
    const inc = Math.max(0, Number(document.getElementById("bb-couple-income").value) || 0);
    const share = Math.min(100, Math.max(50, Number(document.getElementById("bb-couple-share").value) || 50)) / 100;
    const a = inc * share, b = inc - a;
    const sep = personTax(a, rates) + personTax(b, rates), spl = 2 * personTax(inc / 2, rates);
    const gain = Math.max(0, sep - spl);
    document.getElementById("bb-couple-out").innerHTML =
      `Earning ${money(a)} and ${money(b)}, this couple pays <b>${money(sep)}</b> taxed separately at your rates. ` +
      (gain < 1 ? "Splitting wouldn't change their tax, because their incomes are already even enough." :
        `Split evenly (${money(inc / 2)} each) they would pay <b>${money(spl)}</b>, saving <b>${money(gain)} a year</b>.`);
  }

  /* ---------- migration ---------- */
  const migBox = document.getElementById("bb-mig");
  const migUI = {};
  const fmtN = (v) => Math.round(v).toLocaleString("en-AU");
  const signedN = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(Math.round(v)).toLocaleString("en-AU");
  if (MG && migBox) {
    migBox.hidden = false;
    const makeRow = (host, key, name, sub, baseVal, max) => {
      const row = h("div", "bb-row");
      const head = h("div", "bb-head");
      head.append(h("div", "bb-name", name), h("div", "bb-meta", sub));
      const slider = h("input"); slider.type = "range"; slider.min = "0"; slider.max = String(max); slider.step = "1000";
      slider.id = "bb-mig-range-" + key; slider.setAttribute("aria-label", name + ", people a year");
      const num = h("input", "bb-num"); num.type = "number"; num.min = "0"; num.step = "1000"; num.inputMode = "numeric"; num.id = "bb-mig-" + key;
      num.setAttribute("aria-label", name + ", people a year");
      const lab = h("label", "bb-field"); lab.append(h("span", null, "People a year"), num);
      const delta = h("span", "bb-delta");
      const reset = h("button", "bb-reset", "Reset"); reset.type = "button"; reset.setAttribute("aria-label", "Reset " + name + " to the Budget figure");
      const fields = h("div", "bb-fields"); fields.append(lab, delta, reset);
      row.append(head, slider, fields);
      const set = (v) => { if (isFinite(v) && v >= 0) { mig[key] = Math.min(v, max); changed(); } };
      slider.addEventListener("input", () => set(Number(slider.value)));
      num.addEventListener("input", () => { if (num.value !== "") set(Number(num.value)); });
      reset.addEventListener("click", () => set(baseVal));
      host.appendChild(row);
      migUI[key] = { slider, num, delta, reset, base: baseVal };
    };
    const flows = document.getElementById("bb-mig-flows");
    MG.components.forEach((c) => {
      if (c.fixed) {
        const row = h("div", "bb-row bb-fixed");
        const head = h("div", "bb-head");
        head.append(h("div", "bb-name", c.name), h("div", "bb-meta", fmtN(c.value) + " a year, as forecast"));
        row.append(head, h("p", "bb-note", c.note));
        flows.appendChild(row);
      } else makeRow(flows, c.id, c.name, c.sub, c.value, Math.max(c.value * 3, 100000));
    });
    const prog = document.getElementById("bb-mig-program");
    MG.program.forEach((p) => makeRow(prog, p.id, p.name, `Lifetime budget effect per person: ${p.value < 0 ? "−" : "+"}${money(p.value)}`, p.places, Math.max(p.places * 3, 30000)));
    // temporary visa context table
    const tt = document.getElementById("bb-mig-temp");
    MG.temp_values.forEach((t) => {
      const tr = h("tr");
      tr.append(h("td", null, t.name), h("td", "num", (t.value < 0 ? "−" : "+") + money(t.value)));
      tt.appendChild(tr);
    });
    // evidence, grouped by topic
    const ev = document.getElementById("bb-mig-evidence");
    const topics = [...new Set(MG.evidence.map((e) => e.topic))];
    topics.forEach((t, i) => {
      const d = h("details", "bb-ev"); if (i === 0) d.open = true;
      d.appendChild(h("summary", null, t));
      const ul = h("ul");
      MG.evidence.filter((e) => e.topic === t).forEach((e) => {
        const li = h("li");
        li.append(document.createTextNode(e.finding + " "));
        const a = h("a", null, e.source); a.href = e.url; a.rel = "noopener";
        const src = h("span", "bb-ev-src"); src.append("Source: ", a, ".");
        li.appendChild(src);
        ul.appendChild(li);
      });
      d.appendChild(ul);
      ev.appendChild(d);
    });
  }
  function renderMig() {
    if (!MG || !migBox) return;
    const active = document.activeElement;
    Object.entries(migUI).forEach(([k, u]) => {
      const v = mig[k], d = v - u.base;
      u.slider.max = String(Math.max(Number(u.slider.max), v));
      if (active !== u.slider) u.slider.value = String(v);
      if (active !== u.num) u.num.value = String(Math.round(v));
      u.delta.textContent = Math.abs(d) < 1 ? "As forecast" : signedN(d) + " a year";
      u.delta.classList.toggle("up", d >= 1); u.delta.classList.toggle("down", d <= -1);
      u.reset.hidden = Math.abs(d) < 1;
    });
    const R = MG.rules;
    const dNom = MG.components.filter((c) => !c.fixed).reduce((a, c) => a + mig[c.id] - c.value, 0);
    const nom = MG.nom_forecast + dNom;
    const more = dNom > 0, n = Math.abs(dNom);
    const out = [];
    const cite = (e) => { const id = MG.evidence.findIndex((x) => x.key === e); return id >= 0 ? ` <a href="${MG.evidence[id].url}" rel="noopener">(${MG.evidence[id].short})</a>` : ""; };
    out.push(`<b>Net overseas migration: ${fmtN(nom)}</b> in ${MG.year}, against the Budget forecast of ${fmtN(MG.nom_forecast)}${n >= 1 ? ` (${fmtN(n)} ${more ? "more" : "fewer"} people)` : ""}.`);
    if (n >= 1) {
      const gdpPct = n / 100000 * R.gdp_pct_per_100k;
      out.push(`<b>Size of the economy:</b> about ${gdpPct.toFixed(2)}% ${more ? "larger" : "smaller"} over time, roughly ${bn(gdpPct / 100 * GDP)} a year at today's size, because there are ${more ? "more" : "fewer"} people working and spending.${cite("cfp")}`);
      out.push(`<b>Economy per person:</b> little change either way. Official long-run modelling finds migration shifts GDP per person by well under 1%, because it grows the economy and the population together.${cite("igr")}`);
      const b10 = dNom / R.pbo_step * (more ? R.pbo_up_m : R.pbo_down_m);
      out.push(`<b>Federal budget:</b> about <b>${bn(Math.abs(b10), 0)} ${more ? "better" : "worse"}</b> over the ${R.pbo_period} if migration stays ${fmtN(n)} ${more ? "above" : "below"} forecast every year, mostly through income tax.${cite("pbo")} This covers the federal budget only: state budgets carry much of the cost of the extra schools, hospitals, housing and roads.${n > R.pbo_max ? ` <i>This change is larger than the ${fmtN(R.pbo_max)} a year the PBO modelled, so treat it as rough.</i>` : ""}`);
      out.push(`<b>Rents:</b> about ${(n / R.rent_step * R.rent_pct).toFixed(1)}% ${more ? "higher" : "lower"} than otherwise, on the Reserve Bank's estimate that ${fmtN(R.rent_step)} extra people raise rents by about ${R.rent_pct}%.${cite("rba")}`);
      out.push(`<b>Homes:</b> about ${fmtN(Math.round(n / R.persons_per_home / 100) * 100)} ${more ? "more" : "fewer"} homes needed (at ${R.persons_per_home} people per home). For scale, ${fmtN(R.completions)} homes were completed in ${R.completions_year}.${cite("nhsac")}`);
    } else {
      out.push("Change the numbers above to see what more or fewer people would mean for the economy, the budget, rents and housing.");
    }
    const lifetime = MG.program.reduce((a, p) => a + (mig[p.id] - p.places) * p.value, 0);
    const dProg = MG.program.reduce((a, p) => a + mig[p.id] - p.places, 0);
    if (Math.abs(dProg) >= 1) {
      out.push(`<b>Permanent program:</b> ${fmtN(Math.abs(dProg))} ${dProg > 0 ? "more" : "fewer"} places. Over their lifetimes, one year's intake like this would be worth about <b>${lifetime >= 0 ? "+" : "−"}${bn(Math.abs(lifetime) / 1e6, 1)}</b> to federal and state budgets combined compared with the planned program (Treasury's estimate, in 2018–19 dollars).${cite("treasury")} Many permanent visas go to people already living here on temporary visas, so a change here does not change net migration one-for-one.`);
    }
    document.getElementById("bb-mig-effects").replaceChildren(...out.map((t) => { const li = h("li"); li.innerHTML = t; return li; }));
  }

  /* ---------- rendering ---------- */
  function pie(targetId, kind, colors) {
    const box = document.getElementById(targetId);
    box.replaceChildren();
    const all = cur[kind].map((v, i) => ({ name: names[kind][i], value: v, color: colors[i], i }));
    const total = sum(cur[kind]);
    const left = h("div");
    const table = h("table", "pie-legend");
    const trs = [];
    const shown = all.filter((s) => s.value > 0.5);
    if (shown.length) {
      const ctl = pieChart(left, shown, { label: (kind === "revenue" ? "Your revenue" : "Your spending") + " pie chart", fmt: (v) => bn(v), onFocus: (j) => trs.forEach((r) => r.classList.toggle("hl", j >= 0 && Number(r.dataset.i) === shown[j].i)) });
      trs.ctl = ctl;
    }
    const tot = h("div"); tot.style.textAlign = "center"; tot.style.marginTop = "10px";
    tot.append(h("div", "pie-total", bn(total, 0)), h("div", "rc-sub", "your total " + (kind === "revenue" ? "revenue" : "spending")));
    left.appendChild(tot);
    const tb = h("tbody");
    all.forEach((s) => {
      const tr = h("tr"); tr.dataset.i = s.i;
      const nm = h("td"); const sw = h("span", "swatch"); sw.style.background = s.color; nm.append(sw, document.createTextNode(s.name));
      tr.append(nm, h("td", "num", bn(s.value)), h("td", "num", total ? (s.value / total * 100).toFixed(1) + "%" : "–"));
      const j = shown.findIndex((x) => x.i === s.i);
      if (trs.ctl && j >= 0) { tr.addEventListener("mouseenter", () => trs.ctl.focus(j, true)); tr.addEventListener("mouseleave", () => trs.ctl.focus(j, false)); }
      trs.push(tr); tb.appendChild(tr);
    });
    table.appendChild(tb);
    box.append(left, table);
  }

  function stat(v, l, cls) { const s = h("div", "stat" + (cls ? " " + cls : "")); s.append(h("div", "v", v), h("div", "l", l)); return s; }

  function render() {
    const active = document.activeElement;
    KINDS.forEach((kind) => {
      const total = sum(cur[kind]);
      rows[kind].forEach((r, i) => {
        const v = cur[kind][i], b0 = base[kind][i];
        r.slider.max = String(Math.max(b0 * 3, v * 1.2, 1000));
        if (active !== r.slider) r.slider.value = String(v);
        if (active !== r.dollar) r.dollar.value = (v / 1000).toFixed(1);
        if (active !== r.pct) r.pct.value = (v / GDP * 100).toFixed(2);
        const d = v - b0;
        r.delta.textContent = Math.abs(d) < 50 ? "As in the Budget" : `${signedBn(d)} (${d > 0 ? "+" : "−"}${Math.abs(d / (b0 || 1) * 100).toFixed(0)}%)`;
        r.delta.classList.toggle("up", d >= 50); r.delta.classList.toggle("down", d <= -50);
        r.reset.hidden = Math.abs(d) < 50;
        r.meta.textContent = `${pctOf(v, total || 1)} of ${kind === "revenue" ? "revenue" : "spending"}`;
      });
    });
    const rev = sum(cur.revenue), exp = sum(cur.expenses), bal = rev - exp;
    const baseBal = sum(base.revenue) - sum(base.expenses);
    const dBal = bal - baseBal;

    const strip = document.getElementById("bb-summary");
    strip.replaceChildren(
      stat(bn(rev), `Revenue · ${pctOf(rev, GDP)} of GDP`),
      stat(bn(exp), `Spending · ${pctOf(exp, GDP)} of GDP`),
      Math.abs(bal) < 50 ? stat("$0bn", "Balanced · 0% of GDP", "bb-good")
        : stat((bal > 0 ? "+" : "") + bn(bal), `${bal > 0 ? "Surplus" : "Deficit"} · ${pctOf(Math.abs(bal), GDP)} of GDP`, bal > 0 ? "bb-good" : "bb-bad"),
      stat(Math.abs(dBal) < 50 ? "No change" : signedBn(dBal), "Bottom line vs the Budget", dBal > 49 ? "bb-good" : dBal < -49 ? "bb-bad" : ""),
    );
    document.getElementById("bb-status").textContent = note;

    // what it means
    const r = Y.expenses[I.interest].value_m / ((BASE_DEBT + PRIOR_DEBT) / 2);   // average interest rate implied by the Budget
    const debt = BASE_DEBT - dBal;
    const defFund = DEF_FUNDING + (cur.expenses[I.defence] - base.expenses[I.defence]);
    const perPerson = POP ? dBal * 1e6 / POP : null;
    const pts = [];
    pts.push((Math.abs(bal) < 50 ? "Your budget is <b>balanced</b>: revenue covers spending." : `Your budget has ${bal > 0 ? "a surplus" : "a deficit"} of <b>${bn(Math.abs(bal))}</b> (${pctOf(Math.abs(bal), GDP)} of GDP).`) + ` The government's Budget has ${baseBal < 0 ? "a deficit" : "a surplus"} of ${bn(Math.abs(baseBal))} on the same measure.`);
    if (Math.abs(dBal) >= 50) {
      pts.push(`That is <b>${bn(Math.abs(dBal))} a year ${dBal > 0 ? "better" : "worse"}</b> than the Budget${perPerson ? `, or about <b>${money(perPerson)} per Australian</b> a year` : ""}.`);
      pts.push(`Gross debt at ${FY_END} would be roughly <b>${bn(debt, 0)}</b> (${pctOf(debt, GDP)} of GDP) instead of ${bn(BASE_DEBT, 0)}.`);
      if (dBal < 0) pts.push(`At the average interest rate the Budget implies (about ${(r * 100).toFixed(1)}%), the extra borrowing adds about <b>${bn(-dBal * r, 2)} a year in interest</b> from then on. Kept up for four years, the extra debt would be about ${bn(-dBal * 4, 0)}, costing roughly ${bn(-dBal * 4 * r, 1)} a year in interest.`);
      else pts.push(`Borrowing ${bn(dBal)} less would save about <b>${bn(dBal * r, 2)} a year in interest</b> from then on, at the average rate the Budget implies (about ${(r * 100).toFixed(1)}%).`);
    }
    if (bal <= -50) {
      const pit = cur.revenue[I.pit], cuttable = exp - cur.expenses[I.interest];
      pts.push(`To balance your budget you would need to raise personal income tax by <b>${(-bal / pit * 100).toFixed(1)}%</b>, or cut all spending other than interest by <b>${(-bal / cuttable * 100).toFixed(1)}%</b>, or some mix of the two.`);
    }
    pts.push(`Defence funding would be <b>${(defFund / GDP * 100).toFixed(2)}% of GDP</b> on the traditional measure (Budget: ${(DEF_FUNDING / GDP * 100).toFixed(2)}%; the level the US has asked for is 3.5%).`);
    pts.push(`For every $1 of revenue, your government spends <b>$${(exp / rev).toFixed(2)}</b> (Budget: $${(sum(base.expenses) / sum(base.revenue)).toFixed(2)}).`);
    const ul = document.getElementById("bb-impact");
    ul.replaceChildren(...pts.map((t) => { const li = h("li"); li.innerHTML = t; return li; }));

    renderRates();
    renderMig();
    pie("bb-pie-revenue", "revenue", REV_COLORS);
    pie("bb-pie-expenses", "expenses", EXP_COLORS);
  }

  let queued = false;
  function changed() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  }
  syncMode();
  render();
})();
