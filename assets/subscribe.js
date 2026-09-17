/* The Scorecard: subscribe page. Sign-ups, suggestions and unsubscribes are sent via window.Site.send (Formspree);
   choices are also kept in localStorage so the page and the homepage remember them. */
(function () {
  const { h } = window.Charts;
  const D = window.SCORECARD;
  if (!D) return;

  const PREFS_KEY = "scorecard_prefs";
  const SUBSCRIPTION_KEY = "scorecard_subscription";
  const SUGGESTIONS_KEY = "scorecard_suggestions";

  function readJSON(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
  }
  function writeJSON(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }

  // A `.toggle` button group (same pattern as the Budget page's year switcher): clicking a button marks it
  // pressed, un-presses its siblings, and writes the chosen value into a hidden input for the form to read.
  function buildToggle(container, hiddenInput, options, initial) {
    options.forEach((opt) => {
      const b = h("button", null, opt.label);
      b.type = "button";
      b.dataset.value = opt.value;
      b.setAttribute("aria-pressed", String(opt.value === initial));
      b.addEventListener("click", () => setToggle(container, hiddenInput, opt.value));
      container.appendChild(b);
    });
  }
  function setToggle(container, hiddenInput, value) {
    hiddenInput.value = value;
    container.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === value)));
  }

  function buildCheckboxGrid(container, groups, name, checkedSet) {
    groups.forEach((g) => {
      if (g.label) container.appendChild(h("div", "cb-group", g.label));
      g.items.forEach((item) => {
        const label = h("label");
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.name = name; cb.value = item.value;
        cb.checked = checkedSet.has(item.value);
        label.append(cb, document.createTextNode(item.label));
        container.appendChild(label);
      });
    });
  }

  function showSuccess(el, message, isError) {
    el.textContent = message;
    el.classList.toggle("is-error", !!isError);
    el.classList.add("show");
    clearTimeout(el._hideTimer);
    if (!isError) el._hideTimer = setTimeout(() => el.classList.remove("show"), 6000);
  }

  /* ---------- Email updates + per-measure alerts ---------- */
  const existingSub = readJSON(SUBSCRIPTION_KEY, null);

  const freqInput = document.getElementById("freq-value");
  buildToggle(document.getElementById("freq-toggle"), freqInput, [
    { value: "weekly", label: "Weekly digest" },
    { value: "monthly", label: "Monthly digest" },
    { value: "instant", label: "Alerts only" },
  ], (existingSub && existingSub.frequency) || "weekly");
  freqInput.value = (existingSub && existingSub.frequency) || "weekly";

  const alertGrid = document.getElementById("alert-metrics");
  buildCheckboxGrid(
    alertGrid,
    D.sections.map((sec) => ({
      label: sec.title,
      items: D.metrics.filter((m) => m.section === sec.id).map((m) => ({ value: m.id, label: m.title })),
    })),
    "alertMetrics",
    new Set((existingSub && existingSub.alertMetrics) || [])
  );

  const emailInput = document.getElementById("sub-email");
  if (existingSub && existingSub.email) emailInput.value = existingSub.email;

  const FREQ_NAME = { weekly: "Weekly digest", monthly: "Monthly digest", instant: "Alerts only" };
  const titleOf = (id) => (D.metrics.find((m) => m.id === id) || {}).title || id;

  document.getElementById("subscribe-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const email = emailInput.value.trim();
    if (!email) return;
    const alertMetrics = Array.from(alertGrid.querySelectorAll("input:checked")).map((cb) => cb.value);
    const btn = form.querySelector('button[type="submit"]');
    const out = document.getElementById("subscribe-success");
    window.Site.busy(btn, true, "Subscribing\u2026");
    const res = await window.Site.send("Email sign-up", {
      email, frequency: FREQ_NAME[freqInput.value] || freqInput.value,
      alerts: alertMetrics.length ? alertMetrics.map(titleOf).join(", ") : "None", signed_up_from: "Subscribe page",
    }, form);
    window.Site.busy(btn, false);
    if (!res.ok) { showSuccess(out, res.error, true); return; }
    writeJSON(SUBSCRIPTION_KEY, { email, frequency: freqInput.value, alertMetrics, updatedAt: new Date().toISOString() });
    showSuccess(out, "Thanks \u2014 you're signed up.");
    updateSummary();
  });

  /* ---------- Customise view ---------- */
  const prefs = readJSON(PREFS_KEY, { pinned: [], filter: "all" });

  const pinGrid = document.getElementById("pin-categories");
  buildCheckboxGrid(
    pinGrid,
    [{ label: null, items: D.sections.map((s) => ({ value: s.id, label: s.title })) }],
    "pinned",
    new Set(prefs.pinned || [])
  );

  const filterInput = document.getElementById("filter-value");
  buildToggle(document.getElementById("filter-toggle"), filterInput, [
    { value: "all", label: "All measures" },
    { value: "watch_off", label: "Watch + off track" },
    { value: "off", label: "Off track only" },
  ], prefs.filter || "all");
  filterInput.value = prefs.filter || "all";

  document.getElementById("customise-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const pinned = Array.from(pinGrid.querySelectorAll("input:checked")).map((cb) => cb.value);
    writeJSON(PREFS_KEY, { pinned, filter: filterInput.value });
    showSuccess(document.getElementById("customise-success"), "Saved — your Scorecard homepage will reflect this next time you open it.");
    updateSummary();
  });

  /* ---------- Suggest a measure ---------- */
  document.getElementById("suggest-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const topic = document.getElementById("suggest-topic").value.trim();
    const why = document.getElementById("suggest-why").value.trim();
    const email = document.getElementById("suggest-email").value.trim();
    if (!topic || !why) return;
    const btn = form.querySelector('button[type="submit"]');
    const out = document.getElementById("suggest-success");
    window.Site.busy(btn, true);
    const res = await window.Site.send("Measure suggestion", { suggested_measure: topic, why_it_matters: why, email }, form);
    window.Site.busy(btn, false);
    if (!res.ok) { showSuccess(out, res.error, true); return; }
    const suggestions = readJSON(SUGGESTIONS_KEY, []);
    suggestions.push({ id: Date.now() + "-" + Math.random().toString(36).slice(2, 8), topic, why, email, createdAt: new Date().toISOString() });
    writeJSON(SUGGESTIONS_KEY, suggestions);
    form.reset();
    showSuccess(out, "Thanks \u2014 your suggestion has been sent.");
    updateSummary();
  });

  /* ---------- Your saved data: unsubscribe / delete everything (both confirmed first) ---------- */
  const FREQ_LABEL = { weekly: "weekly digest", monthly: "monthly digest", instant: "alerts only" };
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const unsubBtn = document.getElementById("unsubscribe-btn");
  const clearBtn = document.getElementById("clear-data-btn");

  function updateSummary() {
    const sub = readJSON(SUBSCRIPTION_KEY, null);
    const p = readJSON(PREFS_KEY, null);
    const sugg = readJSON(SUGGESTIONS_KEY, []);
    const parts = [];
    if (sub && sub.email) {
      const alerts = (sub.alertMetrics || []).length;
      parts.push(`Signed up as ${sub.email} (${FREQ_LABEL[sub.frequency] || "weekly digest"}${alerts ? ", " + plural(alerts, "alert") : ""})`);
    }
    if (p && ((p.pinned || []).length || (p.filter && p.filter !== "all"))) {
      parts.push(`${((n) => `${n} pinned ${n === 1 ? "category" : "categories"}`)((p.pinned || []).length)}${p.filter && p.filter !== "all" ? ", default filter on" : ""}`);
    }
    if (sugg.length) parts.push(plural(sugg.length, "suggestion") + " saved");
    const reports = readJSON("scorecard_corrections", []);
    if (reports.length) parts.push(plural(reports.length, "error report") + " saved");
    let theme = null;
    try { theme = localStorage.getItem("scorecard_theme"); } catch (err) { theme = null; }
    if (theme) parts.push(`${theme} theme chosen`);
    document.getElementById("data-summary").textContent = parts.length ? parts.join(" · ") + "." : "Nothing saved yet.";
    unsubBtn.disabled = !(sub && sub.email);
  }
  updateSummary();

  unsubBtn.addEventListener("click", async () => {
    const sub = readJSON(SUBSCRIPTION_KEY, null);
    if (!sub) return;
    const ok = await window.Site.confirm({
      title: "Unsubscribe from email updates?",
      body: `This stops email updates to ${sub.email} and removes any measure alerts you picked. Your view preferences are kept.`,
      confirm: "Unsubscribe",
    });
    if (!ok) return;
    const res = await window.Site.send("Unsubscribe request", { email: sub.email, unsubscribed_from: "Subscribe page" });
    if (!res.ok) { showSuccess(document.getElementById("data-success"), res.error, true); return; }
    try { localStorage.removeItem(SUBSCRIPTION_KEY); } catch (err) { /* nothing stored */ }
    emailInput.value = "";
    alertGrid.querySelectorAll("input:checked").forEach((cb) => { cb.checked = false; });
    setToggle(document.getElementById("freq-toggle"), freqInput, "weekly");
    updateSummary();
    showSuccess(document.getElementById("data-success"), "You've been unsubscribed.");
  });

  clearBtn.addEventListener("click", async () => {
    const ok = await window.Site.confirm({
      title: "Delete all your saved data?",
      body: "This unsubscribes you from email updates and permanently removes your alerts, pinned categories, default filter, saved suggestions and error reports, and theme choice from this browser. It can't be undone.",
      confirm: "Delete everything",
    });
    if (!ok) return;
    const sub = readJSON(SUBSCRIPTION_KEY, null);
    if (sub && sub.email) {
      clearBtn.disabled = true;
      const res = await window.Site.send("Unsubscribe request", { email: sub.email, unsubscribed_from: "Delete all my saved data" });
      clearBtn.disabled = false;
      if (!res.ok) { showSuccess(document.getElementById("data-success"), res.error + " Your data hasn't been deleted.", true); return; }
    }
    Object.values(window.Site.keys).forEach((k) => { try { localStorage.removeItem(k); } catch (err) { /* nothing stored */ } });
    window.location.reload();
  });
})();
