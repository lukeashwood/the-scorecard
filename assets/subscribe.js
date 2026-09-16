/* The Scorecard: subscribe page. No backend yet — everything here reads/writes localStorage on this device. */
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
    const btns = options.map((opt) => {
      const b = h("button", null, opt.label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(opt.value === initial));
      b.addEventListener("click", () => {
        btns.forEach((x) => x.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        hiddenInput.value = opt.value;
      });
      container.appendChild(b);
      return b;
    });
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

  function showSuccess(el, message) {
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => el.classList.remove("show"), 5000);
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

  document.getElementById("subscribe-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    if (!email) return;
    const alertMetrics = Array.from(alertGrid.querySelectorAll("input:checked")).map((cb) => cb.value);
    writeJSON(SUBSCRIPTION_KEY, { email, frequency: freqInput.value, alertMetrics, updatedAt: new Date().toISOString() });
    showSuccess(document.getElementById("subscribe-success"), "Saved — you're set up to hear from us.");
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
  });

  /* ---------- Suggest a measure ---------- */
  document.getElementById("suggest-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const topic = document.getElementById("suggest-topic").value.trim();
    const why = document.getElementById("suggest-why").value.trim();
    const email = document.getElementById("suggest-email").value.trim();
    if (!topic || !why) return;
    const suggestions = readJSON(SUGGESTIONS_KEY, []);
    suggestions.push({ id: Date.now() + "-" + Math.random().toString(36).slice(2, 8), topic, why, email, createdAt: new Date().toISOString() });
    writeJSON(SUGGESTIONS_KEY, suggestions);
    e.target.reset();
    showSuccess(document.getElementById("suggest-success"), "Thanks — we'll take a look.");
  });
})();
