/* Budget page: revenue and expense pies, side by side. */
(function () {
  const { h, pieChart } = window.Charts;
  const B = window.SCORECARD && window.SCORECARD.budget;
  if (!B) return;
  // Slot orders validated for colour-vision deficiency, including the wrap-around pair on a circle.
  const REV_COLORS = ["#3f4bc0", "#C82028", "#6da7ec", "#eda100", "#8a4f9e", "#1baf7a"];
  const EXP_COLORS = ["#3f4bc0", "#C82028", "#6da7ec", "#eda100", "#e87ba4", "#8a4f9e", "#1baf7a"];
  const bn = (m, d) => "$" + (m / 1000).toLocaleString("en-AU", { minimumFractionDigits: d == null ? 1 : d, maximumFractionDigits: d == null ? 1 : d }) + "bn";

  function pie(targetId, items, colors, total, label) {
    const box = document.getElementById(targetId);
    box.replaceChildren();
    const slices = items.map((x, i) => ({ name: x.name, value: x.value_m, color: colors[i] }));
    const sum = slices.reduce((a, s) => a + s.value, 0);
    const left = h("div");
    const table = h("table", "pie-legend");
    const rows = [];
    const ctl = pieChart(left, slices, {
      label: label + " pie chart",
      fmt: (v) => bn(v),
      onFocus: (i) => rows.forEach((r, j) => r.classList.toggle("hl", i === j)),
    });
    const totalBox = h("div");
    totalBox.style.textAlign = "center";
    totalBox.style.marginTop = "10px";
    totalBox.appendChild(h("div", "pie-total", bn(total, 0)));
    totalBox.appendChild(h("div", "rc-sub", "total " + label.toLowerCase()));
    left.appendChild(totalBox);
    const tb = h("tbody");
    slices.forEach((s, i) => {
      const tr = h("tr");
      const name = h("td");
      const sw = h("span", "swatch"); sw.style.background = s.color;
      name.append(sw, document.createTextNode(s.name));
      tr.append(name, h("td", "num", bn(s.value)), h("td", "num", (s.value / sum * 100).toFixed(1) + "%"));
      tr.addEventListener("mouseenter", () => ctl.focus(i, true));
      tr.addEventListener("mouseleave", () => ctl.focus(i, false));
      rows.push(tr);
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    box.append(left, table);
  }

  function detail(title, items, total) {
    const c = h("div");
    c.appendChild(h("h4", null, title));
    const wrap = h("div", "table-scroll");
    wrap.style.maxHeight = "none";
    const t = h("table");
    const th = h("thead"); const hr = h("tr");
    ["Category / line item", "$ million", "Share"].forEach((x) => hr.appendChild(h("th", null, x)));
    th.appendChild(hr); t.appendChild(th);
    const tb = h("tbody");
    items.forEach((x) => {
      const r = h("tr"); r.style.fontWeight = "700";
      r.append(h("td", null, x.name), h("td", null, x.value_m.toLocaleString("en-AU")), h("td", null, (x.value_m / total * 100).toFixed(1) + "%"));
      tb.appendChild(r);
      if (x.detail.length > 1) x.detail.forEach(([n, v]) => {
        const rr = h("tr"); rr.style.color = "var(--body-grey)";
        rr.append(h("td", null, "   " + n), h("td", null, v.toLocaleString("en-AU")), h("td", null, (v / total * 100).toFixed(1) + "%"));
        rr.firstChild.style.paddingLeft = "22px";
        tb.appendChild(rr);
      });
    });
    const tr = h("tr"); tr.style.fontWeight = "800";
    tr.append(h("td", null, "Published total"), h("td", null, total.toLocaleString("en-AU")), h("td", null, "100%"));
    tb.appendChild(tr);
    t.appendChild(tb); wrap.appendChild(t); c.appendChild(wrap);
    return c;
  }

  function show(y) {
    document.getElementById("doc-type").textContent = y.type;
    document.getElementById("year-title").textContent = y.year + ": the Commonwealth's accounts";
    document.getElementById("doc-line").textContent = "Source: " + y.document;
    const perDollar = y.expenses_total_m / y.revenue_total_m;
    const pdi = y.expenses.find((x) => /interest/i.test(x.name)).value_m;
    const stats = [
      [bn(y.revenue_total_m, 1), "Total revenue"],
      [bn(y.expenses_total_m, 1), "Total expenses"],
      [(y.ucb_m < 0 ? "−" : "+") + bn(Math.abs(y.ucb_m), 1), "Underlying cash balance (" + (y.ucb_m < 0 ? "deficit" : "surplus") + ")"],
      ["$" + (pdi / 365).toFixed(0) + "m", "Interest on government debt, every day"],
      ["$" + perDollar.toFixed(2), "Spent for every $1 of revenue"],
      ["$" + y.gross_debt_bn.toLocaleString("en-AU", { maximumFractionDigits: 1 }) + "bn", "Gross debt at 30 June " + ("20" + y.year.slice(-2))],
    ];
    const sb = document.getElementById("stats");
    sb.replaceChildren();
    stats.forEach(([v, l]) => { const s = h("div", "stat"); s.append(h("div", "v", v), h("div", "l", l)); sb.appendChild(s); });
    pie("pie-revenue", y.revenue, REV_COLORS, y.revenue_total_m, "Revenue");
    pie("pie-expenses", y.expenses, EXP_COLORS, y.expenses_total_m, "Expenses");
    const dt = document.getElementById("detail-tables");
    dt.replaceChildren(detail("Revenue", y.revenue, y.revenue_total_m), detail("Expenses", y.expenses, y.expenses_total_m));
    const src = document.getElementById("budget-sources");
    src.replaceChildren(
      window.Scorecard.sourceItem({ publisher: "Australian Government (Treasury & Finance)", title: y.document, url: y.url, table: "Revenue: " + y.revenue_table, published: y.published, accessed: B.verified_on }),
      window.Scorecard.sourceItem({ publisher: "Australian Government (Treasury & Finance)", title: y.document + " (expenses)", url: y.url, table: "Expenses: " + y.expense_table, published: y.published, accessed: B.verified_on })
    );
    document.getElementById("budget-note").textContent = B.note + " 'Interest on government debt, every day' = public debt interest expense ÷ 365. 'Spent for every $1 of revenue' = total expenses ÷ total revenue.";
  }

  const tg = document.getElementById("year-toggle");
  const btns = B.years.map((y, i) => {
    const b = h("button", null, y.label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(i === 0));
    b.addEventListener("click", () => { btns.forEach((x) => x.setAttribute("aria-pressed", "false")); b.setAttribute("aria-pressed", "true"); show(y); });
    tg.appendChild(b);
    return b;
  });
  show(B.years[0]);
})();
