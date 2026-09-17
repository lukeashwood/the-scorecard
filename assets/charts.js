/* The Scorecard: dependency-free SVG charts (line, step, column, horizontal bar, pie). */
(function () {
  const NS = "http://www.w3.org/2000/svg";
  // Colours are CSS custom properties (styles.css) so charts follow the light/dark theme without redrawing.
  const ROLE = { primary: "var(--series-primary)", accent: "var(--series-accent)", muted: "var(--series-muted)", good: "var(--series-primary)" };
  const GRID = "var(--grid)", AXIS_TXT = "var(--axis-ink)", INK = "var(--ink)", TERM_FILL = "var(--term-fill)", SURFACE = "var(--surface)";
  const SLICE_INK = "#1A1C2E";   // pie labels sit on the slice colour, not the page, so they never flip
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function el(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) {
      // presentation attributes can't resolve var(); the style property can
      if ((k === "fill" || k === "stroke") && String(attrs[k]).startsWith("var(")) n.style.setProperty(k, attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(n);
    return n;
  }
  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const parseDate = (s) => new Date(s + "T00:00:00Z").getTime();

  function niceTicks(min, max, count) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
    return { lo, hi, ticks, step };
  }

  function fmtNum(v, unit, decimals, opts) {
    opts = opts || {};
    if (v == null || isNaN(v)) return "–";
    const d = decimals == null ? 1 : decimals;
    const abs = Math.abs(v);
    let s;
    if (opts.compact && abs >= 1e6) s = (abs / 1e6).toFixed(abs >= 1e7 ? 1 : 2).replace(/\.0+$/, "") + "M";
    else if (opts.compact && abs >= 1e4) s = Math.round(abs / 1e3).toLocaleString("en-AU") + "k";
    else s = abs.toLocaleString("en-AU", { minimumFractionDigits: d, maximumFractionDigits: d });
    const sign = v < 0 ? "−" : (opts.signed && v > 0 ? "+" : "");
    if (unit === "$") return sign + "$" + s;
    if (unit === "$bn") return sign + "$" + s + "bn";
    if (unit === "%") return sign + s + "%";
    if (unit === "$'000") return sign + "$" + s + "k";
    return sign + s;
  }

  function periodLabel(iso, freq) {
    const d = new Date(iso + "T00:00:00Z");
    if (freq === "fy") { const y = d.getUTCFullYear(); return (y - 1) + "–" + String(y).slice(2); }
    if (freq === "day") return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear();
    if (freq === "q") return MONTHS[d.getUTCMonth()] + " qtr " + d.getUTCFullYear();
    return MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear();
  }

  function legend(series, box) {
    const lg = h("div", "legend");
    series.forEach((s) => {
      const it = h("span");
      const i = h("i", box ? "box" : "");
      i.style.background = ROLE[s.role] || ROLE.primary;
      it.append(i, document.createTextNode(s.name));
      lg.appendChild(it);
    });
    return lg;
  }

  function tableView(headers, rows) {
    const d = h("details", "table-view");
    d.appendChild(h("summary", null, "View data table"));
    const wrap = h("div", "table-scroll");
    const t = h("table"), th = h("thead"), tr = h("tr");
    headers.forEach((x) => tr.appendChild(h("th", null, x)));
    th.appendChild(tr); t.appendChild(th);
    const tb = h("tbody");
    rows.forEach((r) => { const row = h("tr"); r.forEach((x) => row.appendChild(h("td", null, x))); tb.appendChild(row); });
    t.appendChild(tb); wrap.appendChild(t); d.appendChild(wrap);
    return d;
  }

  function onResize(node, fn) {
    let w = 0;
    const ro = new ResizeObserver((ents) => {
      const nw = Math.round(ents[0].contentRect.width);
      if (nw && Math.abs(nw - w) > 4) { w = nw; fn(nw); }
    });
    ro.observe(node);
  }

  /* ---------------- time-series: line / step / column ---------------- */
  function timeChart(container, spec, meta) {
    const series = spec.series.map((s) => ({ ...s, pts: s.points.map((p) => [parseDate(p[0]), p[1], p[0]]) }));
    const multi = series.length > 1;
    if (multi) container.appendChild(legend(series, spec.kind === "bar"));
    if (spec.estimateFrom) {
      const lg = legend([{ name: "Actual", role: series[0].role }, { name: "Forecast", role: series[0].role }], true);
      lg.lastChild.querySelector("i").style.opacity = 0.4;
      container.appendChild(lg);
    }
    const holder = h("div", "chart");
    container.appendChild(holder);
    const tip = h("div", "tooltip");
    holder.appendChild(tip);
    const freq = spec.freq || "m";
    const fmt = (v) => fmtNum(v, spec.unit === "index" ? "" : spec.unit, spec.decimals, { compact: spec.unit === "people" || spec.unit === "homes" });

    // table view: union of dates
    const dates = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p[0])))).sort();
    const lookup = series.map((s) => Object.fromEntries(s.points));
    // "extra" = related values shown in the tooltip and table but not plotted (avoids a second axis)
    const extras = (spec.extra || []).map((x) => ({ ...x, map: Object.fromEntries(x.points) }));
    const rows = dates.slice().reverse().map((d) => [
      periodLabel(d, spec.kind === "step" ? "day" : freq) + (spec.estimateFrom && d >= spec.estimateFrom ? " (forecast)" : ""),
      ...lookup.map((l) => (l[d] == null ? "" : fmtNum(l[d], spec.unit === "index" ? "" : spec.unit, spec.decimals))),
      ...extras.map((x) => (x.map[d] == null ? "" : fmtNum(x.map[d], x.unit, x.decimals))),
    ]);
    container.appendChild(tableView(["Period", ...series.map((s) => s.name), ...extras.map((x) => x.name)], rows));
    if (spec.note) container.appendChild(h("p", "chart-note", spec.note));

    function draw(W) {
      holder.querySelectorAll("svg").forEach((n) => n.remove());
      const H = Math.max(210, Math.min(300, W * 0.52));
      const m = { t: 22, r: 16, b: 26, l: 48 };
      const iw = W - m.l - m.r, ih = H - m.t - m.b;
      const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": meta.title + " chart" });
      holder.insertBefore(svg, tip);

      let x0 = Math.min(...series.map((s) => s.pts[0][0])), x1 = Math.max(...series.map((s) => s.pts[s.pts.length - 1][0]));
      if (spec.kind === "bar") { const pad = (x1 - x0) / Math.max(8, series[0].pts.length) / 1.6; x0 -= pad; x1 += pad; }
      let ys = series.flatMap((s) => s.pts.map((p) => p[1]));
      (spec.ref || []).forEach((r) => ys.push(r.value));
      if (spec.band) ys.push(spec.band.lo, spec.band.hi);
      if (spec.kind === "bar") ys.push(0);
      let ymin = Math.min(...ys), ymax = Math.max(...ys);
      const padY = (ymax - ymin) * 0.08;
      if (spec.kind !== "bar" || ymin < 0) ymin -= padY;
      ymax += padY;
      const nt = niceTicks(ymin, ymax, H < 240 ? 4 : 5);
      const X = (t) => m.l + ((t - x0) / (x1 - x0)) * iw;
      const Y = (v) => m.t + ih - ((v - nt.lo) / (nt.hi - nt.lo)) * ih;

      // government term shading + marker
      // Financial-year bars: the first budget year of this government is 2022–23, so mark between the 2021–22 and 2022–23 bars.
      const sworn = freq === "fy" ? parseDate("2022-12-30") : parseDate(window.SCORECARD ? window.SCORECARD.sworn_in : "2022-05-23");
      if (sworn > x0 && sworn < x1) {
        el("rect", { x: X(sworn), y: m.t, width: m.l + iw - X(sworn), height: ih, fill: TERM_FILL }, svg);
        el("line", { x1: X(sworn), x2: X(sworn), y1: m.t - 8, y2: m.t + ih, stroke: "var(--term-line)", "stroke-width": 1 }, svg);
        const lblRight = X(sworn) < m.l + iw * 0.7;
        const t = el("text", { x: X(sworn) + (lblRight ? 5 : -5), y: m.t - 10, "font-size": 11, fill: "var(--term-ink)", "font-weight": 700, "text-anchor": lblRight ? "start" : "end" }, svg);
        t.textContent = "Albanese Government →";
      }
      // grid + y labels
      nt.ticks.forEach((v) => {
        el("line", { x1: m.l, x2: m.l + iw, y1: Y(v), y2: Y(v), stroke: v === 0 && nt.lo < 0 ? "var(--zero-line)" : GRID, "stroke-width": 1 }, svg);
        const t = el("text", { x: m.l - 8, y: Y(v) + 4, "text-anchor": "end", "font-size": 11.5, fill: AXIS_TXT }, svg);
        t.textContent = fmtNum(v, spec.unit === "index" || spec.unit === "homes" || spec.unit === "people" ? "" : spec.unit, nt.step < 1 ? (nt.step < 0.1 ? 2 : 1) : 0, { compact: Math.abs(v) >= 1e4 && spec.unit !== "$bn" });
      });
      // x year ticks
      const y0 = new Date(x0).getUTCFullYear(), y1 = new Date(x1).getUTCFullYear();
      const years = []; for (let y = y0; y <= y1 + 1; y++) years.push(y);
      const every = Math.ceil(years.length / Math.max(2, Math.floor(iw / 58)));
      if (freq === "fy" || freq === "q") {
        const pts = series[0].pts;
        const n = Math.ceil(pts.length / Math.max(2, Math.floor(iw / 62)));
        pts.forEach((p, i) => {
          if ((pts.length - 1 - i) % n !== 0) return;
          const tx = el("text", { x: X(p[0]), y: m.t + ih + 18, "text-anchor": "middle", "font-size": 11.5, fill: AXIS_TXT }, svg);
          tx.textContent = freq === "fy" ? periodLabel(p[2], "fy") : periodLabel(p[2], "q").replace(" qtr ", " ");
        });
      } else years.forEach((y) => {
        const t = Date.UTC(y, 0, 1);
        if (t < x0 || t > x1 || (y % every !== 0 && every > 1)) return;
        const tx = el("text", { x: X(t), y: m.t + ih + 18, "text-anchor": "middle", "font-size": 11.5, fill: AXIS_TXT }, svg);
        tx.textContent = y;
      });
      // band
      if (spec.band) {
        el("rect", { x: m.l, width: iw, y: Y(spec.band.hi), height: Y(spec.band.lo) - Y(spec.band.hi), fill: "var(--band-fill)" }, svg);
        const t = el("text", { x: m.l + 6, y: Y(spec.band.hi) - 4, "font-size": 11, fill: "var(--band-ink)", "font-weight": 700 }, svg);
        t.textContent = spec.band.label;
      }
      // reference lines
      (spec.ref || []).forEach((r) => {
        el("line", { x1: m.l, x2: m.l + iw, y1: Y(r.value), y2: Y(r.value), stroke: AXIS_TXT, "stroke-width": 1 }, svg);
        if (r.label) {
          const t = el("text", { x: m.l + 6, y: Y(r.value) - 5, "font-size": 11, fill: "var(--ref-ink)", "font-weight": 600 }, svg);
          t.textContent = r.label;
        }
      });

      if (spec.kind === "bar") {
        const s = series[0];
        const slot = iw / s.pts.length;
        const bw = Math.max(2, Math.min(24, slot - 2));
        s.pts.forEach((p) => {
          const cx = X(p[0]), y = Y(Math.max(0, p[1])), yb = Y(Math.min(0, p[1]));
          const hgt = Math.max(1, yb - y);
          const r = Math.min(4, bw / 2, hgt);
          const neg = p[1] < 0;
          const color = neg ? ROLE.accent : ROLE[s.role] || ROLE.primary;
          const est = spec.estimateFrom && p[2] >= spec.estimateFrom;
          const x = cx - bw / 2;
          const d = neg
            ? `M${x},${y} h${bw} v${hgt - r} q0,${r} ${-r},${r} h${-(bw - 2 * r)} q${-r},0 ${-r},${-r} Z`
            : `M${x},${yb} v${-(hgt - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${hgt - r} Z`;
          el("path", { d, fill: color, "fill-opacity": est ? 0.4 : 1, "data-t": p[0] }, svg);
        });
      } else {
        series.forEach((s) => {
          let d = "";
          s.pts.forEach((p, i) => {
            const px = X(p[0]), py = Y(p[1]);
            if (i === 0) d += `M${px},${py}`;
            else if (spec.kind === "step") d += `H${px}V${py}`;
            else d += `L${px},${py}`;
          });
          el("path", { d, fill: "none", stroke: ROLE[s.role] || ROLE.primary, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
        });
        // end dot + label for the lead series
        const lead = series[0];
        const lp = lead.pts[lead.pts.length - 1];
        el("circle", { cx: X(lp[0]), cy: Y(lp[1]), r: 4.5, fill: ROLE[lead.role] || ROLE.primary, stroke: SURFACE, "stroke-width": 2 }, svg);
      }

      // hover layer
      const cross = el("line", { y1: m.t, y2: m.t + ih, stroke: INK, "stroke-width": 1, opacity: 0 }, svg);
      const dots = series.map((s) => el("circle", { r: 4.5, fill: ROLE[s.role] || ROLE.primary, stroke: SURFACE, "stroke-width": 2, opacity: 0 }, svg));
      const hit = el("rect", { x: m.l, y: 0, width: iw, height: H, fill: "transparent", tabindex: 0, "aria-label": "Chart data: use left and right arrow keys" }, svg);
      const xs = series[0].pts.map((p) => p[0]);
      let idx = xs.length - 1;
      function show(i) {
        idx = Math.max(0, Math.min(xs.length - 1, i));
        const t = xs[idx];
        cross.setAttribute("x1", X(t)); cross.setAttribute("x2", X(t)); cross.setAttribute("opacity", spec.kind === "bar" ? 0 : 0.35);
        tip.replaceChildren();
        tip.appendChild(h("div", "tt-date", periodLabel(series[0].pts[idx][2], spec.kind === "step" ? "day" : freq)));
        series.forEach((s, si) => {
          let best = null, bd = Infinity;
          for (const p of s.pts) { const dd = Math.abs(p[0] - t); if (dd < bd) { bd = dd; best = p; } }
          if (spec.kind === "step") { best = null; for (const p of s.pts) if (p[0] <= t) best = p; }
          if (!best || (spec.kind !== "step" && bd > 50 * 86400000)) { dots[si].setAttribute("opacity", 0); return; }
          if (spec.kind !== "bar") { dots[si].setAttribute("cx", X(best[0] > t ? t : spec.kind === "step" ? t : best[0])); dots[si].setAttribute("cy", Y(best[1])); dots[si].setAttribute("opacity", 1); }
          const row = h("div", "tt-row");
          const key = h("i"); key.style.background = ROLE[s.role] || ROLE.primary;
          row.append(key, h("b", null, fmt(best[1])));
          if (multi) row.appendChild(h("span", null, s.name));
          tip.appendChild(row);
          if (si === 0) extras.forEach((x) => {
            const xv = x.map[best[2]];
            if (xv == null) return;
            const er = h("div", "tt-row");
            er.append(h("i"), h("b", null, fmtNum(xv, x.unit, x.decimals)), h("span", null, x.name));
            er.firstChild.style.background = "transparent";
            tip.appendChild(er);
          });
          if (si === 0 && spec.estimateFrom && best[2] >= spec.estimateFrom) tip.appendChild(h("div", "tt-date", "Budget forecast"));
        });
        svg.querySelectorAll("path[data-t]").forEach((p) => p.setAttribute("opacity", +p.getAttribute("data-t") === t ? 1 : 0.55));
        const px = (X(t) / W) * holder.clientWidth;
        tip.classList.add("show");
        const tw = tip.offsetWidth;
        tip.style.left = Math.max(0, Math.min(holder.clientWidth - tw, px + (px > holder.clientWidth / 2 ? -tw - 12 : 12))) + "px";
        tip.style.top = "8px";
      }
      function hide() {
        tip.classList.remove("show"); cross.setAttribute("opacity", 0); dots.forEach((d) => d.setAttribute("opacity", 0));
        svg.querySelectorAll("path[data-t]").forEach((p) => p.setAttribute("opacity", 1));
      }
      hit.addEventListener("pointermove", (e) => {
        const r = svg.getBoundingClientRect();
        const t = x0 + (((e.clientX - r.left) * (W / r.width) - m.l) / iw) * (x1 - x0);
        let bi = 0, bd = Infinity;
        xs.forEach((x, i) => { const dd = Math.abs(x - t); if (dd < bd) { bd = dd; bi = i; } });
        show(bi);
      });
      hit.addEventListener("pointerleave", hide);
      hit.addEventListener("focus", () => show(idx));
      hit.addEventListener("blur", hide);
      hit.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft") { show(idx - 1); e.preventDefault(); }
        if (e.key === "ArrowRight") { show(idx + 1); e.preventDefault(); }
      });
    }
    onResize(holder, draw);
  }

  /* ---------------- horizontal bars (HTML, wraps long labels) ---------------- */
  function hbarChart(container, spec) {
    const bars = spec.bars;
    const roles = Array.from(new Set(bars.map((b) => b.role)));
    if (spec.legend) container.appendChild(legend(spec.legend, true));
    const vals = bars.map((b) => b.value);
    const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    const span = hi - lo || 1;
    const pos = (v) => ((v - lo) / span) * 100;
    const wrap = h("div", "hbars");
    const tip = h("div", "tooltip");
    const holder = h("div", "chart");
    bars.forEach((b) => {
      const row = h("div", "hbar-row");
      row.tabIndex = 0;
      const u = spec.unit === "%" || spec.unit === "$" ? spec.unit : "";
      const signedVals = bars.some((x) => x.value < 0) || spec.unit === "'000 jobs" || spec.unit === "%" && !spec.unsigned;
      row.setAttribute("aria-label", `${b.name}: ${fmtNum(b.value, u, spec.decimals, { signed: signedVals })}`);
      const name = h("div", "hbar-name", b.name);
      const track = h("div", "hbar-track");
      const zero = h("div", "hbar-zero"); zero.style.left = pos(0) + "%";
      const fill = h("div", "hbar-fill " + (b.value >= 0 ? "pos" : "neg"));
      fill.style.left = pos(Math.min(0, b.value)) + "%";
      fill.style.width = Math.max(0.6, Math.abs(pos(b.value) - pos(0))) + "%";
      fill.style.background = ROLE[b.role] || ROLE.muted;
      track.append(fill, zero);
      if (spec.refValue != null) { const r = h("div", "hbar-ref"); r.style.left = pos(spec.refValue) + "%"; track.appendChild(r); }
      const val = h("div", "hbar-val", fmtNum(b.value, u, spec.decimals, { signed: signedVals }) + (spec.unit === "'000 jobs" ? "k" : ""));
      row.append(name, track, val);
      wrap.appendChild(row);
    });
    holder.append(wrap);
    container.appendChild(holder);
    container.appendChild(tableView(["Category", spec.unit === "'000 jobs" ? "Change ('000 jobs)" : "Change (%)"], bars.map((b) => [b.name, fmtNum(b.value, "", spec.decimals, { signed: true })])));
    if (spec.note) container.appendChild(h("p", "chart-note", spec.note));
  }

  /* ---------------- pie ---------------- */
  function pieChart(container, slices, opts) {
    const total = slices.reduce((a, s) => a + s.value, 0);
    const size = 250, R = 118, cx = size / 2, cy = size / 2;
    const svg = el("svg", { viewBox: `0 0 ${size} ${size}`, class: "pie-svg", role: "img", "aria-label": opts.label });
    const holder = h("div", "chart");
    holder.style.maxWidth = "250px";
    const tip = h("div", "tooltip");
    holder.append(svg, tip);
    let a0 = -Math.PI / 2;
    const paths = [];
    slices.forEach((s, i) => {
      const frac = s.value / total, a1 = a0 + frac * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a) => [cx + R * Math.cos(a), cy + R * Math.sin(a)];
      const [sx, sy] = p(a0), [ex, ey] = p(a1);
      const d = frac >= 0.9999 ? `M${cx - R},${cy} a${R},${R} 0 1,0 ${2 * R},0 a${R},${R} 0 1,0 ${-2 * R},0` : `M${cx},${cy} L${sx},${sy} A${R},${R} 0 ${large} 1 ${ex},${ey} Z`;
      const mid = (a0 + a1) / 2;
      const path = el("path", { d, fill: s.color, stroke: SURFACE, "stroke-width": 2, "stroke-linejoin": "round", tabindex: 0, "aria-label": `${s.name}: ${(frac * 100).toFixed(1)}%` }, svg);
      path.dataset.dx = Math.cos(mid) * 6; path.dataset.dy = Math.sin(mid) * 6;
      if (frac > 0.07) {
        const lr = R * 0.64;
        const lum = luminance(s.color);
        const t = el("text", { x: cx + lr * Math.cos(mid), y: cy + lr * Math.sin(mid) + 5, "text-anchor": "middle", "font-size": 14, "font-weight": 800, fill: lum > 0.45 ? SLICE_INK : "#fff", "pointer-events": "none" }, svg);
        t.textContent = Math.round(frac * 100) + "%";
      }
      paths.push(path);
      a0 = a1;
    });
    function focus(i, on, evt) {
      paths.forEach((p, j) => {
        p.style.transform = on && j === i ? `translate(${p.dataset.dx}px, ${p.dataset.dy}px)` : "";
        p.style.opacity = on && j !== i ? 0.55 : 1;
      });
      if (opts.onFocus) opts.onFocus(on ? i : -1);
      if (on) {
        const s = slices[i];
        tip.replaceChildren(h("div", "tt-date", s.name));
        const row = h("div", "tt-row"); const k = h("i"); k.style.background = s.color;
        row.append(k, h("b", null, opts.fmt(s.value)), h("span", null, (s.value / total * 100).toFixed(1) + "%"));
        tip.appendChild(row);
        tip.classList.add("show");
        const r = holder.getBoundingClientRect();
        const x = evt && evt.clientX ? evt.clientX - r.left : r.width / 2;
        const y = evt && evt.clientY ? evt.clientY - r.top : r.height / 2;
        tip.style.left = Math.max(0, Math.min(r.width - tip.offsetWidth, x + 12)) + "px";
        tip.style.top = Math.max(0, y - 50) + "px";
      } else tip.classList.remove("show");
    }
    paths.forEach((p, i) => {
      p.addEventListener("pointermove", (e) => focus(i, true, e));
      p.addEventListener("pointerleave", () => focus(i, false));
      p.addEventListener("focus", () => focus(i, true));
      p.addEventListener("blur", () => focus(i, false));
    });
    container.appendChild(holder);
    return { focus };
  }

  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function render(container, spec, meta) {
    if (!spec) return;
    if (spec.kind === "hbar") return hbarChart(container, spec);
    return timeChart(container, spec, meta || {});
  }

  window.Charts = { render, pieChart, fmtNum, periodLabel, h };
})();
