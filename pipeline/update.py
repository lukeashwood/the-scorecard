#!/usr/bin/env python3
"""
The Scorecard: daily data pipeline.

Pulls every automated figure directly from official machine-readable sources
(Reserve Bank of Australia statistical tables and the Australian Bureau of
Statistics Data API / time-series spreadsheets), runs verification checks,
merges the hand-verified metrics in data/manual.json, and writes:

  data/metrics.json       everything the website displays
  data/metrics.js         same data as a script (so the site also works offline / file://)
  data/verification.json  the public audit log of every check run

Standard library only, so it runs anywhere Python 3.9+ is installed.

Usage:
  python3 pipeline/update.py            # normal run (fetches everything)
  python3 pipeline/update.py --cache    # reuse files downloaded in the last 12h (for development)

Exit code is 1 if any CRITICAL check fails. The previous good value is kept
and flagged on the site rather than publishing a number we cannot verify.
"""
import calendar
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import time
import traceback
import urllib.error
import urllib.request
import zipfile
from xml.etree import ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
CACHE_DIR = os.path.join(ROOT, "pipeline", ".cache")
USE_CACHE = "--cache" in sys.argv
# Some government sites drop connections from user agents containing "bot"; this still identifies the checker honestly.
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 ScorecardLinkCheck/1.0"

SWORN_IN = "2022-05-23"          # Albanese Ministry sworn in
BASE_Q = "2022-06-30"            # June quarter 2022: first quarter under this government
BASE_M = "2022-05-31"            # May 2022: the month the government took office
NOW = dt.datetime.now(dt.timezone.utc)

CHECKS = []                      # the audit log for this run
SOURCES_USED = {}                # source key -> retrieval metadata


# --------------------------------------------------------------------------- helpers

def log_check(metric, check, status, detail, critical=False):
    CHECKS.append({"metric": metric, "check": check, "status": status,
                   "critical": critical, "detail": detail})
    mark = {"pass": "ok ", "warn": "WRN", "fail": "ERR"}[status]
    print(f"  [{mark}] {metric}: {check}: {detail}")


def _download(url):
    """urllib first; if Python's certificate store can't validate the chain (common on macOS),
    fall back to the system curl, which still verifies TLS against the OS trust store."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read()
    except urllib.error.URLError as e:
        if "CERTIFICATE_VERIFY_FAILED" not in str(e):
            raise
    import subprocess
    return subprocess.run(["curl", "-sSfL", "--max-time", "120", "-A", UA, url],
                          check=True, capture_output=True).stdout


def http_status(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except urllib.error.URLError as e:
        if "CERTIFICATE_VERIFY_FAILED" not in str(e):
            return str(e)[:60]
    import subprocess
    out = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-L", "--max-time", "30",
                          "-A", UA, url], capture_output=True, text=True).stdout
    return int(out) if out.isdigit() else out


def fetch(url, key):
    """Download with retries; optional local cache for development."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    cache = os.path.join(CACHE_DIR, re.sub(r"[^A-Za-z0-9]+", "_", key))
    if USE_CACHE and os.path.exists(cache) and time.time() - os.path.getmtime(cache) < 43200:
        with open(cache, "rb") as f:
            body = f.read()
    else:
        last = None
        for attempt in range(3):
            try:
                body = _download(url)
                break
            except Exception as e:  # noqa: BLE001
                last = e
                time.sleep(3 * (attempt + 1))
        else:
            raise RuntimeError(f"download failed for {url}: {last}")
        with open(cache, "wb") as f:
            f.write(body)
    SOURCES_USED[key] = {"url": url, "retrieved_at": NOW.isoformat(timespec="seconds"),
                         "bytes": len(body)}
    return body


def month_end(y, m):
    return dt.date(y, m, calendar.monthrange(y, m)[1]).isoformat()


def parse_period(p):
    p = p.strip()
    if m := re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", p):          # RBA dd/mm/yyyy
        return month_end(int(m[3]), int(m[2]))
    if m := re.fullmatch(r"(\d{4})-Q([1-4])", p):                      # ABS quarter
        return month_end(int(m[1]), int(m[2]) * 3)
    if m := re.fullmatch(r"(\d{4})-(\d{2})", p):                       # ABS month
        return month_end(int(m[1]), int(m[2]))
    if m := re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", p):
        return month_end(int(m[1]), int(m[2]))
    raise ValueError(f"unrecognised period {p!r}")


def label(date, freq):
    d = dt.date.fromisoformat(date)
    mon = calendar.month_name[d.month]
    return f"{mon} quarter {d.year}" if freq == "Q" else f"{mon} {d.year}"


def since(series, start):
    return [p for p in series if p[0] >= start]


def at(series, date):
    """Last observation on or before date."""
    pts = [p for p in series if p[0] <= date]
    if not pts:
        raise ValueError(f"no observation on/before {date}")
    return pts[-1]


def latest(series):
    return series[-1]


def pct(a, b):
    return (b / a - 1) * 100


def rebase(series, base_date):
    base = at(series, base_date)[1]
    return [[d, round(v / base * 100, 2)] for d, v in series]


def annualised(v0, v1, d0, d1):
    years = (dt.date.fromisoformat(d1) - dt.date.fromisoformat(d0)).days / 365.25
    return ((v1 / v0) ** (1 / years) - 1) * 100


def mean(xs):
    xs = list(xs)
    return sum(xs) / len(xs)


def rnd(series, n=2):
    return [[d, round(v, n)] for d, v in series]


def fmt(v, n=1):
    return f"{v:,.{n}f}"


def signed(v, n=1):
    return f"{'+' if v >= 0 else '−'}{abs(v):,.{n}f}"


# --------------------------------------------------------------------------- source readers

RBA_TABLE_NAMES = {
    "g1": "Consumer Price Inflation", "h1": "Gross Domestic Product and Income",
    "h2": "Demand and Income", "h4": "Labour Costs and Productivity",
    "h5": "Labour Force", "f1.1": "Interest Rates and Yields – Money Market",
    "f6": "Housing Lending Rates", "h3": "Monthly Activity Indicators",
}
_rba_cache = {}


def rba(table):
    """Return {series_id: {'title','units','type','points':[(date,val)]}, '_published': str}."""
    if table in _rba_cache:
        return _rba_cache[table]
    url = f"https://www.rba.gov.au/statistics/tables/csv/{table}-data.csv"
    raw = fetch(url, f"rba_{table}").decode("utf-8-sig", errors="replace")
    rows = list(csv.reader(io.StringIO(raw)))
    hdr = {r[0]: r for r in rows[:25] if r}
    ids = hdr["Series ID"]
    start = next(i for i, r in enumerate(rows) if r and r[0] == "Series ID") + 1
    out = {"_published": hdr.get("Publication date", ["", ""])[1]}
    for j in range(1, len(ids)):
        if not ids[j]:
            continue
        pts = []
        for r in rows[start:]:
            if r and j < len(r) and r[j].strip():
                try:
                    pts.append((parse_period(r[0]), float(r[j])))
                except ValueError:
                    pass
        out[ids[j]] = {"title": hdr["Title"][j], "units": hdr.get("Units", [""] * len(ids))[j],
                       "type": hdr.get("Type", [""] * len(ids))[j], "points": pts}
    SOURCES_USED[f"rba_{table}"]["published"] = out["_published"]
    _rba_cache[table] = out
    return out


def rba_series(table, sid, metric):
    t = rba(table)
    if sid not in t or not t[sid]["points"]:
        log_check(metric, f"RBA {table.upper()} series {sid} present", "fail",
                  "series missing from table", critical=True)
        raise RuntimeError(f"RBA {table}/{sid} missing")
    return t[sid]["points"]


def abs_api(flow, key, start, source_key):
    url = (f"https://data.api.abs.gov.au/rest/data/ABS,{flow}/{key}"
           f"?startPeriod={start}&format=csv")
    raw = fetch(url, source_key).decode("utf-8-sig", errors="replace")
    if raw.startswith("NoRecordsFound") or "OBS_VALUE" not in raw[:2000]:
        raise RuntimeError(f"ABS {flow} returned no records for {key}")
    return list(csv.DictReader(io.StringIO(raw)))


def abs_group(rows, dim):
    out = {}
    for r in rows:
        if r["OBS_VALUE"] == "":
            continue
        out.setdefault(r[dim], []).append((parse_period(r["TIME_PERIOD"]), float(r["OBS_VALUE"])))
    return {k: sorted(v) for k, v in out.items()}


def abs_timeseries_xlsx(url, source_key):
    """Parse an ABS time-series workbook (Data1 sheet) with the standard library."""
    z = zipfile.ZipFile(io.BytesIO(fetch(url, source_key)))
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
          "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
    strings = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns):
            strings.append("".join(t.text or "" for t in si.iter(f"{{{ns['m']}}}t")))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    relmap = {r.get("Id"): r.get("Target") for r in rels}
    sheet = next(s for s in wb.find("m:sheets", ns) if s.get("name") == "Data1")
    target = relmap[sheet.get(f"{{{ns['r']}}}id")].lstrip("/")
    target = target if target.startswith("xl/") else "xl/" + target
    grid = {}
    for row in ET.fromstring(z.read(target)).iter(f"{{{ns['m']}}}row"):
        rn = int(row.get("r"))
        for c in row.findall("m:c", ns):
            col = re.match(r"[A-Z]+", c.get("r"))[0]
            v = c.find("m:v", ns)
            if v is None:
                continue
            val = strings[int(v.text)] if c.get("t") == "s" else v.text
            grid.setdefault(rn, {})[col] = val
    cols = [c for c in grid[1] if c != "A"]
    series = {}
    for col in cols:
        pts = []
        for rn in sorted(grid):
            if rn < 11 or col not in grid[rn] or "A" not in grid[rn]:
                continue
            d = dt.date(1899, 12, 30) + dt.timedelta(days=int(float(grid[rn]["A"])))
            pts.append((month_end(d.year, d.month), float(grid[rn][col])))
        series[grid[10][col]] = {"description": grid[1][col], "unit": grid[2].get(col, ""),
                                 "type": grid[3].get(col, ""), "points": pts}
    return series


def xlsx_sheet(url, source_key, sheet_name):
    """Return {row_number: {column_letter: value}} for one worksheet (standard library only)."""
    z = zipfile.ZipFile(io.BytesIO(fetch(url, source_key)))
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
          "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
    strings = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns):
            strings.append("".join(t.text or "" for t in si.iter(f"{{{ns['m']}}}t")))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    relmap = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    sheet = next(sh for sh in wb.find("m:sheets", ns) if sh.get("name") == sheet_name)
    target = relmap[sheet.get(f"{{{ns['r']}}}id")].lstrip("/")
    target = target if target.startswith("xl/") else "xl/" + target
    grid = {}
    for row in ET.fromstring(z.read(target)).iter(f"{{{ns['m']}}}row"):
        for c in row.findall("m:c", ns):
            v = c.find("m:v", ns)
            if v is None:
                continue
            col = re.match(r"[A-Z]+", c.get("r"))[0]
            grid.setdefault(int(row.get("r")), {})[col] = strings[int(v.text)] if c.get("t") == "s" else v.text
    return grid


# --------------------------------------------------------------------------- citations

def src_rba(table, sids):
    return {"publisher": "Reserve Bank of Australia",
            "title": f"Statistical Table {table.upper()} – {RBA_TABLE_NAMES[table]}",
            "url": "https://www.rba.gov.au/statistics/tables/",
            "data_url": f"https://www.rba.gov.au/statistics/tables/csv/{table}-data.csv",
            "series": sids, "published": _rba_cache.get(table, {}).get("_published", ""),
            "retrieved_at": NOW.isoformat(timespec="seconds"), "automated": True}


ABS_PAGES = {
    "CPI": ("Consumer Price Index, Australia",
            "https://www.abs.gov.au/statistics/economy/price-indexes-and-inflation/consumer-price-index-australia/latest-release"),
    "WPI": ("Wage Price Index, Australia",
            "https://www.abs.gov.au/statistics/economy/price-indexes-and-inflation/wage-price-index-australia/latest-release"),
    "LF": ("Labour Force, Australia",
           "https://www.abs.gov.au/statistics/labour/employment-and-unemployment/labour-force-australia/latest-release"),
    "LFD": ("Labour Force, Australia, Detailed – Table 4: Employed persons by Industry",
            "https://www.abs.gov.au/statistics/labour/employment-and-unemployment/labour-force-australia-detailed/latest-release"),
    "BUILDING_ACTIVITY": ("Building Activity, Australia",
                          "https://www.abs.gov.au/statistics/industry/building-and-construction/building-activity-australia/latest-release"),
    "RES_DWELL_ST": ("Total Value of Dwellings",
                     "https://www.abs.gov.au/statistics/economy/price-indexes-and-inflation/total-value-dwellings/latest-release"),
    "ERP_COMP_Q": ("National, state and territory population",
                   "https://www.abs.gov.au/statistics/people/population/national-state-and-territory-population/latest-release"),
}


def src_abs(flow, detail, data_url=None):
    title, page = ABS_PAGES[flow]
    return {"publisher": "Australian Bureau of Statistics", "title": title, "url": page,
            "data_url": data_url or f"https://data.api.abs.gov.au/rest/data/ABS,{flow}",
            "series": detail, "retrieved_at": NOW.isoformat(timespec="seconds"), "automated": True}


# --------------------------------------------------------------------------- verification helpers

def check_fresh(metric, date, freq, max_age=None):
    max_age = max_age or {"M": 80, "Q": 200, "Q_LAG": 290}[freq]
    freq = freq[0]
    age = max(0, (NOW.date() - dt.date.fromisoformat(date)).days)
    if age <= max_age:
        log_check(metric, "freshness", "pass", f"latest observation {date} ({age} days old)")
    else:
        log_check(metric, "freshness", "warn",
                  f"latest observation {date} is {age} days old (expected ≤{max_age}); "
                  "source may have discontinued or delayed a release")


def check_range(metric, name, v, lo, hi):
    if lo <= v <= hi:
        log_check(metric, f"plausible range: {name}", "pass", f"{v} within [{lo}, {hi}]")
    else:
        log_check(metric, f"plausible range: {name}", "fail",
                  f"{v} outside [{lo}, {hi}] – value withheld pending manual review", critical=True)
        raise RuntimeError(f"{metric}: {name}={v} failed range check")


def check_cross(metric, name, a, b, tol, a_label, b_label):
    diff = abs(a - b)
    status = "pass" if diff <= tol else "fail"
    log_check(metric, f"cross-source check: {name}", status,
              f"{a_label} = {a:.2f}, {b_label} = {b:.2f} (difference {diff:.2f}, tolerance {tol})",
              critical=status == "fail")
    if status == "fail":
        raise RuntimeError(f"{metric}: cross-source mismatch on {name}")


# --------------------------------------------------------------------------- metrics
# Every number in "headline", "context" and "benchmark" is computed from the fetched
# data below: nothing is typed in by hand here. Hand-verified figures live in manual.json.

METRICS = []


def metric(fn):
    METRICS.append(fn)
    return fn


def status_of(bad, watch=False):
    return "fail" if bad else ("warn" if watch else "pass")


@metric
def inflation():
    mid = "inflation"
    yoy = rba_series("g1", "GCPIAGYP", mid)          # quarterly, long history
    tm = rba_series("g1", "GCPIOCPMTMYP", mid)
    idx = rba_series("g1", "GCPIAG", mid)
    qd, qv = latest(yoy)
    check_range(mid, "quarterly headline CPI y/y", qv, -5, 20)
    # independent check 1: recompute quarterly year-ended inflation from the ABS CPI index
    cpi_q = abs_group(abs_api("CPI", "1.10001.10.50.Q", "2020-Q1", "abs_cpi_allgroups"), "INDEX")["10001"]
    if latest(cpi_q)[0] == qd:
        check_cross(mid, "quarterly year-ended CPI", qv, pct(at(cpi_q, f"{int(qd[:4]) - 1}{qd[4:]}")[1], latest(cpi_q)[1]),
                    0.15, "RBA G1", "ABS quarterly CPI index (recomputed)")
    # headline: the ABS monthly CPI (the ABS's lead inflation measure since late 2025)
    mrows = abs_api("CPI", "1+3.10001.10.50.M", "2024-01", "abs_cpi_monthly")
    mg = abs_group(mrows, "MEASURE")
    m_yoy, m_idx = mg["3"], mg["1"]
    d, v = latest(m_yoy)
    check_fresh(mid, d, "M")
    check_range(mid, "monthly headline CPI y/y", v, -5, 20)
    check_cross(mid, "monthly year-ended CPI", v, pct(at(m_idx, f"{int(d[:4]) - 1}{d[4:]}")[1], at(m_idx, d)[1]),
                0.1, "ABS published", "ABS monthly index (recomputed)")
    base_v = at(yoy, BASE_Q)[1]
    after = since(yoy, BASE_Q)
    above = sum(1 for _, x in after if x > 3)
    cum = pct(at(idx, BASE_Q)[1], latest(idx)[1])
    return {
        "id": mid, "section": "cost", "title": "Inflation",
        "question": "Is inflation back inside the Reserve Bank's 2–3% target band?",
        "headline": {"value": v, "unit": "%", "decimals": 1, "period": label(d, "M"),
                     "caption": "annual CPI inflation, measured over the past 12 months"},
        "benchmark": {"label": "RBA target band", "text": "2–3%"},
        "baseline": {"label": "June quarter 2022", "value": base_v, "unit": "%"},
        "status": status_of(not (2 <= v <= 3)),
        "status_rule": "On track if the latest annual CPI inflation rate is within the RBA's 2–3% target band; otherwise off track.",
        "context": [
            f"Prices overall are {fmt(cum)}% higher than in the June quarter 2022.",
            f"On the quarterly measure, inflation has been above the top of the 2–3% target band in {above} of the {len(after)} quarters since the government took office. It was {fmt(qv)}% in the {label(qd, 'Q')}.",
            f"Underlying (trimmed mean) inflation, which strips out volatile items, was {fmt(latest(tm)[1])}% in the {label(latest(tm)[0], 'Q')}.",
            f"Inflation was already {fmt(base_v)}% in the June quarter 2022 when the government took office. The test is how quickly it has come back down, and whether it has stayed down.",
        ],
        "chart": {"kind": "line", "unit": "%", "decimals": 1,
                  "series": [{"name": "Annual CPI inflation (quarterly)", "role": "primary", "points": rnd(since(yoy, "2015-01-01"), 1)},
                             {"name": "Annual CPI inflation (new monthly CPI)", "role": "accent", "points": rnd(m_yoy, 1)}],
                  "band": {"lo": 2, "hi": 3, "label": "RBA target 2–3%"}},
        "sources": [src_abs("CPI", ["All groups CPI, weighted average of eight capital cities: monthly annual % change (headline) and index (cross-check); quarterly index (cross-check)"]),
                    src_rba("g1", ["GCPIAGYP", "GCPIOCPMTMYP", "GCPIAG"])],
        "method": "Headline: the ABS monthly Consumer Price Index, percentage change from the same month a year earlier (all groups, eight capitals). History: year-ended quarterly CPI inflation from RBA Table G1, which extends back decades. The cumulative change compares the latest quarterly CPI index with the June quarter 2022.",
    }


CPI_GROUPS = [("40055", "Electricity"), ("115528", "Insurance"), ("115522", "Rents"),
              ("115498", "Child care"), ("20001", "Food"), ("115486", "Health"),
              ("115493", "Education"), ("40081", "Petrol & fuel"), ("10001", "All prices (CPI)")]
_wpi = {}


def wpi_index(sector="7"):
    """ABS WPI, total hourly rates excl. bonuses. Sector 7 = all, 1 = private, 2 = public."""
    if not _wpi:
        rows = abs_api("WPI", "1.THRPEB.1+2+7.TOT.10.AUS.Q", "2010-Q1", "abs_wpi")
        _wpi.update(abs_group(rows, "SECTOR"))
    return _wpi[sector]


def cpi_indexes():
    key = "+".join(c for c, _ in CPI_GROUPS)
    return abs_group(abs_api("CPI", f"1.{key}.10.50.Q", "2015-Q1", "abs_cpi_groups"), "INDEX")


@metric
def prices_vs_wages():
    mid = "prices_vs_wages"
    g = cpi_indexes()
    wpi = wpi_index()
    common = min(latest(wpi)[0], min(latest(g[c])[0] for c, _ in CPI_GROUPS))
    check_fresh(mid, common, "Q")
    bars = []
    for code, name in CPI_GROUPS:
        ch = pct(at(g[code], BASE_Q)[1], at(g[code], common)[1])
        check_range(mid, name, ch, -60, 150)
        bars.append({"name": name, "value": round(ch, 1), "role": "muted" if code != "10001" else "accent"})
    w = pct(at(wpi, BASE_Q)[1], at(wpi, common)[1])
    bars.append({"name": "Wages (WPI)", "value": round(w, 1), "role": "good"})
    bars.sort(key=lambda b: -b["value"])
    allp = next(b["value"] for b in bars if b["name"].startswith("All prices"))
    faster = [b["name"] for b in bars if b["value"] > w and not b["name"].startswith(("All", "Wages"))]
    return {
        "id": mid, "section": "cost", "title": "Prices vs wages since the election",
        "question": "Have wages kept up with the cost of essentials?",
        "headline": {"value": len(faster), "unit": "", "decimals": 0, "period": f"June quarter 2022 → {label(common, 'Q')}",
                     "caption": f"of {len(CPI_GROUPS) - 1} essential price categories rose faster than wages"},
        "benchmark": {"label": "Wages growth over the same period", "text": f"{fmt(w)}%"},
        "baseline": {"label": "June quarter 2022", "value": 0, "unit": "%"},
        "status": status_of(allp > w),
        "status_rule": "Off track if the overall price level has risen faster than wages since the June quarter 2022.",
        "context": [
            f"Wages (Wage Price Index) are up {fmt(w)}%; overall prices are up {fmt(allp)}%.",
            "Rising faster than wages: " + (", ".join(faster) if faster else "none") + ".",
            "The ABS counts government energy bill rebates as a cut in electricity prices while they are paid, so the electricity figure is after taxpayer-funded rebates.",
        ],
        "chart": {"kind": "hbar", "unit": "%", "decimals": 1, "bars": bars, "refValue": round(w, 1),
                  "legend": [{"name": "Wages (blue line marks wage growth)", "role": "primary"}, {"name": "All prices", "role": "accent"}, {"name": "Essential items", "role": "muted"}],
                  "note": f"Change in price index, June quarter 2022 to {label(common, 'Q')}. Bars crossing the blue line rose faster than wages."},
        "sources": [src_abs("CPI", [f"{n} (index {c}), eight capital cities, original" for c, n in CPI_GROUPS]),
                    src_abs("WPI", ["Total hourly rates of pay excluding bonuses; private and public; all industries; original"])],
        "method": "Percentage change in each ABS CPI expenditure-class index and the Wage Price Index between the June quarter 2022 and the latest quarter available for all series.",
    }


@metric
def real_wages():
    mid = "real_wages"
    wpi = wpi_index()
    cpi = cpi_indexes()["10001"]
    common = min(latest(wpi)[0], latest(cpi)[0])
    check_fresh(mid, common, "Q")
    def real_of(w):
        return rebase([(d, x / at(cpi, d)[1]) for d, x in w if "2015-03-31" <= d <= common], BASE_Q)
    real = real_of(wpi)
    real_priv, real_pub = real_of(wpi_index("1")), real_of(wpi_index("2"))
    v = real[-1][1]
    vp, vg = real_priv[-1][1], real_pub[-1][1]
    check_range(mid, "real wage index", v, 70, 130)
    check_range(mid, "private real wage index", vp, 70, 130)
    check_range(mid, "public real wage index", vg, 70, 130)
    wg_priv = rba_series("h4", "GWPIPRIYP", mid)
    wg_pub = rba_series("h4", "GWPIPUBYP", mid)
    wg = rba_series("h4", "GWPIYP", mid)
    inf = rba_series("g1", "GCPIAGYP", mid)
    # cross-check the RBA's year-ended wage growth against our ABS recomputation
    wd = latest(wg)[0]
    abs_w = pct(at(wpi, f"{int(wd[:4]) - 1}{wd[4:]}")[1], at(wpi, wd)[1])
    check_cross(mid, "year-ended wage growth", latest(wg)[1], abs_w, 0.15, "RBA H4", "ABS WPI index (recomputed)")
    gap = [(d, round(x - at(inf, d)[1], 1)) for d, x in since(wg, "2015-01-01") if d <= latest(inf)[0]]
    neg = sum(1 for d, x in gap if d >= BASE_Q and x < 0)
    tot = sum(1 for d, _ in gap if d >= BASE_Q)
    peak_real = max(x for d, x in real if d < BASE_Q)
    li = latest(inf)[1]
    return {
        "id": mid, "section": "cost", "title": "Real wages: private vs public sector",
        "question": "Can a worker's pay buy more than it could when the government took office, and has the private sector done as well as government employees?",
        "headline": {"value": round(vp - 100, 1), "unit": "%", "decimals": 1, "signed": True,
                     "period": label(common, "Q"), "caption": "change in private-sector real wages since June quarter 2022"},
        "benchmark": {"label": "Public-sector real wages, same period", "text": f"{signed(vg - 100)}%"},
        "baseline": {"label": "June quarter 2022", "value": 100, "unit": "index"},
        "status": status_of(vp < 100, vp < vg),
        "status_rule": "Off track if private-sector wages adjusted for inflation are below their June quarter 2022 level; watch if they have grown less than public-sector real wages.",
        "context": [
            f"Private sector: real wages {signed(vp - 100)}%. Public sector: {signed(vg - 100)}%. All workers: {signed(v - 100)}%.",
            f"Latest year: private wages {signed(latest(wg_priv)[1])}%, public wages {signed(latest(wg_pub)[1])}%, prices {signed(li)}%. Real wage growth is private {signed(latest(wg_priv)[1] - li)} and public {signed(latest(wg_pub)[1] - li)} percentage points.",
            f"Across all workers, wages grew more slowly than prices in {neg} of the {tot} quarters since the government took office.",
            f"All-worker real wages are {fmt(abs(pct(peak_real, v)))}% {'below' if v < peak_real else 'above'} their pre-election peak on this measure.",
        ],
        "chart": {"kind": "line", "unit": "index", "decimals": 1,
                  "series": [{"name": "Private sector", "role": "primary", "points": real_priv},
                             {"name": "Public sector", "role": "accent", "points": real_pub}],
                  "ref": [{"value": 100, "label": "Level when the government took office"}]},
        "sources": [src_abs("WPI", ["Total hourly rates of pay excluding bonuses; private sector, public sector and all sectors; all industries; original"]),
                    src_abs("CPI", ["All groups CPI index, eight capitals"]),
                    src_rba("h4", ["GWPIYP", "GWPIPRIYP", "GWPIPUBYP"]), src_rba("g1", ["GCPIAGYP"])],
        "method": "ABS Wage Price Index (by sector) divided by the Consumer Price Index, rebased so the June quarter 2022 = 100. A value below 100 means pay buys less than it did then. Year-ended wage growth by sector from RBA Table H4.",
    }


@metric
def electricity():
    mid = "electricity"
    g = cpi_indexes()
    e, a = g["40055"], g["10001"]
    d = min(latest(e)[0], latest(a)[0])
    check_fresh(mid, d, "Q")
    er, ar = rebase(since(e, "2019-03-31"), BASE_Q), rebase(since(a, "2019-03-31"), BASE_Q)
    ch = at(er, d)[1] - 100
    check_range(mid, "electricity change", ch, -60, 200)
    return {
        "id": mid, "section": "energy", "title": "Electricity prices",
        "question": "Did power bills come down, as promised?",
        "headline": {"value": round(ch, 1), "unit": "%", "decimals": 1, "signed": True,
                     "period": label(d, "Q"), "caption": "change in electricity prices since June quarter 2022"},
        "benchmark": {"label": "Election promise", "text": "Lower bills (see promise below)"},
        "baseline": {"label": "June quarter 2022", "value": 100, "unit": "index"},
        "status": status_of(ch > 0),
        "status_rule": "Off track if household electricity prices are higher than in the June quarter 2022.",
        "context": [
            f"Overall prices rose {fmt(at(ar, d)[1] - 100)}% over the same period.",
            "The ABS measures electricity prices after government energy bill rebates. While rebates are paid they lower the measured price, but taxpayers still fund them.",
        ],
        "chart": {"kind": "line", "unit": "index", "decimals": 1,
                  "series": [{"name": "Electricity", "role": "primary", "points": er},
                             {"name": "All prices (CPI)", "role": "muted", "points": ar}],
                  "ref": [{"value": 100, "label": "June qtr 2022 = 100"}]},
        "sources": [src_abs("CPI", ["Electricity (index 40055), eight capitals", "All groups CPI (index 10001)"])],
        "method": "ABS CPI electricity index and all-groups index, each rebased so the June quarter 2022 = 100.",
    }


@metric
def mortgage():
    mid = "mortgage"
    rate = rba_series("f6", "FLRHOOVA", mid)
    cash = rba_series("f1.1", "FIRMMCRT", mid)
    d, v = latest(rate)
    check_fresh(mid, d, "M")
    check_range(mid, "variable mortgage rate", v, 1, 15)
    b = at(rate, BASE_M)[1]

    def repay(r, principal=600000, years=30):
        i = r / 100 / 12
        n = years * 12
        return principal * i / (1 - (1 + i) ** -n)
    extra = repay(v) - repay(b)
    return {
        "id": mid, "section": "housing", "title": "Mortgage costs",
        "question": "How much more are households paying on a typical mortgage?",
        "headline": {"value": round(extra), "unit": "$", "decimals": 0, "signed": True, "prefix": True,
                     "period": label(d, "M"), "caption": "extra per month on a $600,000 loan vs May 2022"},
        "benchmark": {"label": "Rate when government took office", "text": f"{fmt(b, 2)}%"},
        "baseline": {"label": "May 2022", "value": b, "unit": "%"},
        "status": status_of(extra > 0),
        "status_rule": "Off track if repayments on a typical variable mortgage are higher than in May 2022.",
        "context": [
            f"The average variable rate on existing owner-occupier loans is {fmt(v, 2)}%, up from {fmt(b, 2)}% in May 2022.",
            f"That is about ${fmt(extra * 12, 0)} a year more on a $600,000, 30-year principal-and-interest loan.",
            f"The RBA cash rate is {fmt(latest(cash)[1], 2)}%. The RBA sets rates independently to control inflation, and government spending adds to demand and inflation.",
        ],
        "chart": {"kind": "line", "unit": "%", "decimals": 2,
                  "series": [{"name": "Owner-occupier variable rate (outstanding loans)", "role": "primary", "points": rnd(rate)},
                             {"name": "RBA cash rate target", "role": "muted", "points": rnd(since(cash, "2019-06-30"))}]},
        "sources": [src_rba("f6", ["FLRHOOVA"]), src_rba("f1.1", ["FIRMMCRT"])],
        "method": "Standard amortisation formula applied to a $600,000 30-year principal-and-interest loan, using the RBA's average rate on outstanding owner-occupier variable loans in May 2022 and the latest month.",
    }


def rba_decisions():
    raw = fetch("https://www.rba.gov.au/statistics/tables/csv/a2-data.csv", "rba_a2").decode("utf-8-sig", errors="replace")
    rows = list(csv.reader(io.StringIO(raw)))
    start = next(i for i, r in enumerate(rows) if r and r[0] == "Series ID") + 1
    pub = next((r[1] for r in rows[:start] if r and r[0] == "Publication date"), "")
    SOURCES_USED["rba_a2"]["published"] = pub
    out = []
    for r in rows[start:]:
        if len(r) < 3 or not r[0].strip():
            continue
        d = dt.datetime.strptime(r[0].strip(), "%d-%b-%Y").date().isoformat()
        new_nums = re.findall(r"-?\d+(?:\.\d+)?", r[2])
        chg_nums = re.findall(r"[-+]?\d+(?:\.\d+)?", r[1])
        if not new_nums:
            continue
        new = float(new_nums[-1])
        chg = float(chg_nums[-1]) if chg_nums else 0.0
        out.append((d, chg, new))
    return out, pub


@metric
def interest_rates():
    mid = "interest_rates"
    dec, pub = rba_decisions()
    cash = rba_series("f1.1", "FIRMMCRT", mid)
    # cross-check: latest decision target must equal latest monthly cash rate target
    check_cross(mid, "cash rate target", dec[-1][2], latest(cash)[1], 0.001, "RBA A2 latest decision", "RBA F1.1 latest month")
    at_swear = [x for x in dec if x[0] <= SWORN_IN][-1][2]
    after = [x for x in dec if x[0] > SWORN_IN]
    rises = [x for x in after if x[1] > 0]
    cuts = [x for x in after if x[1] < 0]
    now = dec[-1][2]
    check_range(mid, "cash rate", now, 0, 20)
    step = []
    prev = [x for x in dec if x[0] <= "2019-01-01"][-1][2]
    step.append(["2019-01-01", prev])
    for d, _, new in dec:
        if d > "2019-01-01":
            step.append([d, new])
    step.append([NOW.date().isoformat(), now])
    return {
        "id": mid, "section": "housing", "title": "Interest rate rises",
        "question": "How many times have interest rates gone up under this government?",
        "headline": {"value": len(rises), "unit": "", "decimals": 0, "period": f"since 23 May 2022 (to {dt.date.fromisoformat(dec[-1][0]).strftime('%-d %b %Y')})",
                     "caption": f"cash rate rises, versus {len(cuts)} cuts"},
        "benchmark": {"label": "Cash rate when government was sworn in", "text": f"{fmt(at_swear, 2)}%"},
        "baseline": {"label": "23 May 2022", "value": at_swear, "unit": "%"},
        "status": status_of(now > at_swear),
        "status_rule": "Off track if the cash rate is higher than on the day the government was sworn in.",
        "context": [
            f"The cash rate is {fmt(now, 2)}%, up {fmt(now - at_swear, 2)} percentage points from {fmt(at_swear, 2)}% when the government was sworn in.",
            f"There have been {len(rises)} rises and {len(cuts)} cuts since then, including {sum(1 for x in rises if x[0] >= '2026-01-01')} rises so far in 2026.",
            "The RBA sets the cash rate independently. It raises rates when inflation is too high, and government spending adds to demand in the economy.",
        ],
        "chart": {"kind": "step", "unit": "%", "decimals": 2,
                  "series": [{"name": "RBA cash rate target", "role": "primary", "points": step}]},
        "sources": [src_rba("f1.1", ["FIRMMCRT"]),
                    {"publisher": "Reserve Bank of Australia", "title": "Statistical Table A2 – Changes in Monetary Policy and Administered Rates",
                     "url": "https://www.rba.gov.au/statistics/cash-rate/", "data_url": "https://www.rba.gov.au/statistics/tables/csv/a2-data.csv",
                     "series": ["ARBAMPCCCR", "ARBAMPCNCRT"], "published": pub, "retrieved_at": NOW.isoformat(timespec="seconds"), "automated": True}],
        "method": "Every cash rate target decision published in RBA Table A2 after 23 May 2022, cross-checked against the monthly cash rate target in Table F1.1.",
    }


@metric
def consumer_confidence():
    mid = "consumer_confidence"
    s = rba_series("h3", "GICWMICS", mid)
    d, v = latest(s)
    check_fresh(mid, d, "M")
    check_range(mid, "consumer sentiment index", v, 40, 150)
    after = [x for dd, x in s if dd > BASE_M]
    below = sum(1 for x in after if x < 100)
    pre = mean(x for dd, x in s if "2010-01-01" <= dd <= "2019-12-31")
    return {
        "id": mid, "section": "living", "title": "Consumer confidence",
        "question": "Do Australians feel confident about their finances and the economy?",
        "headline": {"value": v, "unit": "", "decimals": 1, "period": label(d, "M"),
                     "caption": "consumer sentiment index (100 = optimists equal pessimists)"},
        "benchmark": {"label": "Neutral", "text": f"100 (2010–2019 average: {fmt(pre)})"},
        "baseline": {"label": "May 2022", "value": at(s, BASE_M)[1], "unit": "index"},
        "status": status_of(v < 100),
        "status_rule": "Off track if pessimists outnumber optimists (index below 100).",
        "context": [
            f"Pessimists have outnumbered optimists in {below} of the {len(after)} months since the government took office.",
            f"In May 2022 the index was {fmt(at(s, BASE_M)[1])}. The 2010–2019 average was {fmt(pre)}.",
        ],
        "chart": {"kind": "line", "unit": "index", "decimals": 1,
                  "series": [{"name": "Westpac–Melbourne Institute consumer sentiment", "role": "primary", "points": rnd(since(s, "2015-01-01"), 1)}],
                  "ref": [{"value": 100, "label": "100 = neutral"}]},
        "sources": [dict(src_rba("h3", ["GICWMICS"]), note="Index compiled by Westpac Banking Corporation and the Melbourne Institute; republished by the RBA in Table H3.")],
        "method": "Westpac–Melbourne Institute Index of Consumer Sentiment, seasonally adjusted, as republished in RBA Table H3. An index above 100 means more consumers are optimistic than pessimistic.",
    }


@metric
def unemployment():
    mid = "unemployment"
    ur = rba_series("h5", "GLFSURSA", mid)
    d, v = latest(ur)
    check_fresh(mid, d, "M")
    check_range(mid, "unemployment rate", v, 1, 20)
    rows = abs_api("LF", "M13.3.1599.20.AUS.M", "2025-01", "abs_lf_ur")
    abs_ur = abs_group(rows, "MEASURE")["M13"]
    if latest(abs_ur)[0] == d:
        check_cross(mid, "unemployment rate", v, latest(abs_ur)[1], 0.05, "RBA H5", "ABS Labour Force API")
    else:
        log_check(mid, "cross-source check: unemployment rate", "warn",
                  f"period mismatch RBA {d} vs ABS {latest(abs_ur)[0]}; skipped")
    b = at(ur, BASE_M)[1]
    unemp = rba_series("h5", "GLFSUPSA", mid)
    extra = (latest(unemp)[1] - at(unemp, BASE_M)[1]) * 1000
    return {
        "id": mid, "section": "jobs", "title": "Unemployment",
        "question": "Are more Australians out of work than when the government took office?",
        "headline": {"value": v, "unit": "%", "decimals": 1, "period": label(d, "M"), "caption": "unemployment rate"},
        "benchmark": {"label": "When government took office (May 2022)", "text": f"{fmt(b)}%"},
        "baseline": {"label": "May 2022", "value": b, "unit": "%"},
        "status": status_of(v > b),
        "status_rule": "Off track if the unemployment rate is higher than in May 2022.",
        "context": [
            f"{fmt(abs(extra), 0)} {'more' if extra >= 0 else 'fewer'} Australians are unemployed than in May 2022.",
            "Job growth has been concentrated in publicly funded sectors (see Who is creating the jobs?).",
        ],
        "chart": {"kind": "line", "unit": "%", "decimals": 1,
                  "series": [{"name": "Unemployment rate (seasonally adjusted)", "role": "primary", "points": rnd(since(ur, "2015-01-01"), 1)}],
                  "ref": [{"value": b, "label": f"May 2022: {fmt(b)}%"}]},
        "sources": [src_rba("h5", ["GLFSURSA", "GLFSUPSA"]),
                    src_abs("LF", ["Unemployment rate, persons, seasonally adjusted (independent cross-check)"])],
        "method": "Seasonally adjusted unemployment rate from the ABS Labour Force survey (via RBA Table H5), cross-checked against the ABS Data API.",
    }


INDUSTRY_NAMES = {
    "A": "Agriculture, forestry & fishing", "B": "Mining", "C": "Manufacturing", "D": "Electricity, gas, water & waste",
    "E": "Construction", "F": "Wholesale trade", "G": "Retail trade", "H": "Accommodation & food",
    "I": "Transport, postal & warehousing", "J": "Information media & telecoms", "K": "Financial & insurance",
    "L": "Rental, hiring & real estate", "M": "Professional, scientific & technical", "N": "Administrative & support",
    "O": "Public administration & safety", "P": "Education & training", "Q": "Health care & social assistance",
    "R": "Arts & recreation", "S": "Other services",
}
NON_MARKET = ["O", "P", "Q"]
_la = {}


def labour_account():
    """ABS Labour Account (quarterly, balanced, seasonally adjusted): filled jobs by sector and industry, '000."""
    if not _la:
        rows = abs_api("LABOUR_ACCT_Q", "M12+M13+M14.AUS..20.Q", "2015-Q1", "abs_labour_account")
        for r in rows:
            if r["OBS_VALUE"]:
                _la.setdefault((r["MEASURE"], r["LABOURACCT_IND"]), []).append(
                    (parse_period(r["TIME_PERIOD"]), float(r["OBS_VALUE"])))
        for k in _la:
            _la[k].sort()
    return _la


LA_SRC = "https://data.api.abs.gov.au/rest/data/ABS,LABOUR_ACCT_Q"
ABS_PAGES["LABOUR_ACCT_Q"] = ("Labour Account Australia (quarterly)",
                              "https://www.abs.gov.au/statistics/labour/labour-accounts/labour-account-australia/latest-release")


@metric
def public_private_jobs():
    mid = "public_private_jobs"
    la = labour_account()
    tot, priv, pub = la[("M12", "TOTAL")], la[("M13", "TOTAL")], la[("M14", "TOTAL")]
    d = latest(tot)[0]
    check_fresh(mid, d, "Q")
    check_cross(mid, "private + public = total filled jobs ('000)", at(priv, d)[1] + at(pub, d)[1], at(tot, d)[1],
                at(tot, d)[1] * 0.005, "Private + public", "Total filled jobs")
    ch_pub = at(pub, d)[1] - at(pub, BASE_Q)[1]
    ch_priv = at(priv, d)[1] - at(priv, BASE_Q)[1]
    share_growth = ch_pub / (ch_pub + ch_priv) * 100
    share_level = at(pub, BASE_Q)[1] / (at(pub, BASE_Q)[1] + at(priv, BASE_Q)[1]) * 100
    g_pub, g_priv = pct(at(pub, BASE_Q)[1], at(pub, d)[1]), pct(at(priv, BASE_Q)[1], at(priv, d)[1])
    check_range(mid, "public share of job growth", share_growth, -100, 200)
    return {
        "id": mid, "section": "jobs", "title": "Public vs private sector jobs",
        "question": "Are government jobs growing faster than jobs in private business?",
        "headline": {"value": round(g_pub, 1), "unit": "%", "decimals": 1, "signed": True,
                     "period": f"June quarter 2022 → {label(d, 'Q')}", "caption": "growth in public-sector jobs"},
        "benchmark": {"label": "Private-sector job growth, same period", "text": f"{signed(g_priv)}%"},
        "baseline": {"label": "June quarter 2022", "value": round(share_level, 1), "unit": "% of jobs in public sector"},
        "status": status_of(g_pub > g_priv * 1.25, g_pub > g_priv),
        "status_rule": "Off track if public-sector jobs have grown more than 1.25× as fast as private-sector jobs since June quarter 2022; watch if faster at all.",
        "context": [
            f"Public-sector filled jobs rose by {fmt(ch_pub, 0)},000 ({signed(g_pub)}%). Private-sector jobs rose by {fmt(ch_priv, 0)},000 ({signed(g_priv)}%).",
            f"The public sector made up {fmt(share_level)}% of jobs in June quarter 2022 but {fmt(share_growth)}% of the jobs added since.",
            "Many jobs funded by government, such as NDIS disability support workers and aged-care workers, are counted as private-sector jobs. See 'Who is creating the jobs?' for the industry picture.",
        ],
        "chart": {"kind": "line", "unit": "index", "decimals": 1,
                  "series": [{"name": "Public-sector jobs", "role": "accent", "points": rebase(since(pub, "2019-01-01"), BASE_Q)},
                             {"name": "Private-sector jobs", "role": "primary", "points": rebase(since(priv, "2019-01-01"), BASE_Q)}],
                  "ref": [{"value": 100, "label": "June qtr 2022 = 100"}]},
        "sources": [src_abs("LABOUR_ACCT_Q", ["Filled jobs – public sector (M14), private sector (M13) and total (M12); all industries; seasonally adjusted"], LA_SRC)],
        "method": "ABS Labour Account filled jobs by institutional sector (public = all levels of government and public corporations), seasonally adjusted. Growth measured from the June quarter 2022.",
    }


@metric
def jobs_by_sector():
    mid = "jobs_by_sector"
    la = labour_account()
    inds = {c: la[("M12", c)] for c in INDUSTRY_NAMES if ("M12", c) in la}
    if len(inds) < 19:
        log_check(mid, "industry series present", "fail", f"found {len(inds)} of 19 industries", critical=True)
        raise RuntimeError("industry data incomplete")
    log_check(mid, "industry series present", "pass", "19 industry divisions, seasonally adjusted")
    d = min(latest(p)[0] for p in inds.values())
    check_fresh(mid, d, "Q")
    base = BASE_Q
    ch = {c: (at(p, d)[1] - at(p, base)[1]) for c, p in inds.items()}   # '000
    lvl = {c: at(p, base)[1] for c, p in inds.items()}
    total_ch, total_lvl = sum(ch.values()), sum(lvl.values())
    tot = la[("M12", "TOTAL")]
    check_cross(mid, "19 industries sum to total filled jobs ('000)", sum(at(p, d)[1] for p in inds.values()),
                at(tot, d)[1], at(tot, d)[1] * 0.005, "Sum of industries", "Total filled jobs")
    series_type = "Seasonally adjusted"
    url = LA_SRC
    nm_ch = sum(ch[n] for n in NON_MARKET)
    nm_share_growth = nm_ch / total_ch * 100
    nm_share_emp = sum(lvl[n] for n in NON_MARKET) / total_lvl * 100
    check_range(mid, "non-market share of growth", nm_share_growth, -500, 500)
    bars = sorted(({"name": INDUSTRY_NAMES[c], "value": round(v), "role": "accent" if c in NON_MARKET else "muted"}
                   for c, v in ch.items()), key=lambda b: -b["value"])
    mkt_ch = total_ch - nm_ch
    return {
        "id": mid, "section": "jobs", "title": "Who is creating the jobs?",
        "question": "Is employment growth coming from the private economy or from taxpayer-funded sectors?",
        "headline": {"value": round(nm_share_growth), "unit": "%", "decimals": 0,
                     "period": f"June quarter 2022 → {label(d, 'Q')}", "caption": "of all new jobs were in health & social assistance (incl. NDIS), education and public administration"},
        "benchmark": {"label": "Those sectors' share of all jobs in June qtr 2022", "text": f"{fmt(nm_share_emp)}%"},
        "baseline": {"label": "June quarter 2022", "value": round(nm_share_emp, 1), "unit": "%"},
        "status": status_of(nm_share_growth > nm_share_emp * 1.5, nm_share_growth > nm_share_emp),
        "status_rule": "Off track if these largely publicly funded industries account for more than 1.5× their share of jobs in new jobs; watch if above their share.",
        "context": [
            f"Filled jobs grew by {fmt(total_ch, 0)},000. {fmt(nm_ch, 0)},000 of them were in health care & social assistance, education and public administration. Health care & social assistance alone added {fmt(ch['Q'], 0)},000.",
            f"Those three industries held {fmt(nm_share_emp)}% of jobs in June quarter 2022. The other 16 industries, mostly the market economy, added {fmt(mkt_ch, 0)},000.",
            "Economists call these three industries the 'non-market' sector because they are largely government funded. They include some private employers (such as private hospitals and schools), so this is not a pure public-sector count. See 'Public vs private sector jobs' for that.",
        ],
        "chart": {"kind": "hbar", "unit": "'000 jobs", "decimals": 0, "bars": bars,
                  "legend": [{"name": "Largely publicly funded industries", "role": "accent"}, {"name": "Other industries", "role": "muted"}],
                  "note": f"Change in filled jobs by industry ('000), June quarter 2022 to {label(d, 'Q')}, seasonally adjusted. Highlighted: largely publicly funded industries."},
        "sources": [src_abs("LABOUR_ACCT_Q", ["Filled jobs (M12) by ANZSIC industry division, seasonally adjusted, quarterly"], url)],
        "method": "Change in ABS Labour Account filled jobs in each of the 19 ANZSIC industry divisions between the June quarter 2022 and the latest quarter. 'Non-market' = Health Care & Social Assistance + Education & Training + Public Administration & Safety. (The ABS ceased the Labour Force, Detailed industry tables in April 2026; the Labour Account is the continuing official quarterly source.)",
    }


@metric
def productivity():
    mid = "productivity"
    idx = rba_series("h4", "GNFPROSQI", mid)
    yoy = rba_series("h4", "GNFPROSQP", mid)
    d, v = latest(idx)
    check_fresh(mid, d, "Q")
    check_range(mid, "productivity index", v, 50, 150)
    lr0, lr1 = at(idx, "2000-03-31"), at(idx, "2019-12-31")
    long_run = annualised(lr0[1], lr1[1], lr0[0], lr1[0])
    b = at(idx, BASE_Q)
    since_el = annualised(b[1], v, b[0], d)
    return {
        "id": mid, "section": "jobs", "title": "Productivity",
        "question": "Are we producing more for every hour worked? Productivity drives lasting wage growth.",
        "headline": {"value": round(since_el, 2), "unit": "%", "decimals": 2, "signed": True,
                     "period": f"June quarter 2022 → {label(d, 'Q')}", "caption": "average annual productivity growth since the government took office"},
        "benchmark": {"label": "Long-run average (2000–2019)", "text": f"{signed(long_run, 2)}% a year"},
        "baseline": {"label": "June quarter 2022", "value": b[1], "unit": "index"},
        "status": status_of(since_el < long_run),
        "status_rule": "Off track if annual productivity growth since June quarter 2022 is below the 2000–2019 average.",
        "context": [
            f"Output per hour worked in the non-farm economy is {fmt(abs(pct(b[1], v)))}% {'above' if v >= b[1] else 'below'} its June quarter 2022 level.",
            f"Over the latest year productivity changed by {signed(latest(yoy)[1])}%.",
            f"Measured productivity was temporarily lifted during the COVID period, so the June 2022 starting point was unusually high. Against the pre-COVID December quarter 2019, productivity is {fmt(abs(pct(lr1[1], v)))}% {'higher' if v >= lr1[1] else 'lower'}: an average of {signed(annualised(lr1[1], v, lr1[0], d), 2)}% a year, still below the long-run {signed(long_run, 2)}%.",
            "Without productivity growth, real wages cannot rise sustainably.",
        ],
        "chart": {"kind": "line", "unit": "index", "decimals": 1,
                  "series": [{"name": "Non-farm labour productivity per hour", "role": "primary", "points": rnd(since(idx, "2015-01-01"), 1)}],
                  "ref": [{"value": b[1], "label": "June qtr 2022 level"}]},
        "sources": [src_rba("h4", ["GNFPROSQI", "GNFPROSQP"])],
        "method": "ABS national accounts non-farm GDP per hour worked (RBA Table H4). Annualised growth rates are compound averages between the quarters shown.",
    }


@metric
def gdp_per_capita():
    mid = "gdp_per_capita"
    s = rba_series("h1", "GGDPCVGDPFY", mid)
    d, v = latest(s)
    check_fresh(mid, d, "Q")
    check_range(mid, "GDP per capita growth", v, -15, 15)
    after = [x for dd, x in s if dd > BASE_Q]
    pre = [x for dd, x in s if "2010-03-31" <= dd <= "2019-12-31"]
    neg = sum(1 for x in after if x < 0)
    return {
        "id": mid, "section": "living", "title": "GDP per person",
        "question": "Is the economy growing for each Australian, or only because the population is growing?",
        "headline": {"value": v, "unit": "%", "decimals": 1, "signed": True, "period": label(d, "Q"),
                     "caption": "annual growth in real GDP per person"},
        "benchmark": {"label": "2010–2019 average", "text": f"{signed(mean(pre))}% a year"},
        "baseline": {"label": "June quarter 2022", "value": at(s, BASE_Q)[1], "unit": "%"},
        "status": status_of(mean(after) < mean(pre)),
        "status_rule": "Off track if average annual per-person GDP growth since the election is below the 2010–2019 average.",
        "context": [
            f"Average growth since the government took office: {signed(mean(after))}% a year, compared with {signed(mean(pre))}% in 2010–2019.",
            f"Per-person GDP was lower than a year earlier in {neg} of the {len(after)} quarterly readings since the election.",
            f"Total GDP grew {fmt(latest(rba_series('h1', 'GGDPCVGDPY', mid))[1])}% over the latest year. The gap is population growth.",
        ],
        "chart": {"kind": "bar", "unit": "%", "decimals": 1,
                  "series": [{"name": "Real GDP per capita, year-ended growth", "role": "primary", "points": rnd(since(s, "2015-01-01"), 1)}],
                  "ref": [{"value": 0, "label": ""}]},
        "sources": [src_rba("h1", ["GGDPCVGDPFY", "GGDPCVGDPY"])],
        "method": "Year-ended growth in real (chain volume) GDP per capita, seasonally adjusted, ABS national accounts via RBA Table H1. Averages are simple means of quarterly year-ended readings.",
    }


@metric
def household_income():
    mid = "household_income"
    rhdi = rba_series("h2", "GGDPICHRDI", mid)
    pop = abs_group(abs_api("ERP_COMP_Q", "10.AUS.Q", "2014-Q1", "abs_erp"), "MEASURE")["10"]
    d = min(latest(rhdi)[0], latest(pop)[0])
    check_fresh(mid, d, "Q_LAG")
    pc = [(dd, x * 1e6 / (at(pop, dd)[1] * 1e3) * 4) for dd, x in rhdi if "2015-03-31" <= dd <= d]
    v_now = at(pc, d)[1]
    check_range(mid, "real disposable income per person ($/yr)", v_now, 20000, 120000)
    idx = rebase(pc, BASE_Q)
    ch = at(idx, d)[1] - 100
    return {
        "id": mid, "section": "living", "title": "Household income per person",
        "question": "After tax and inflation, are households better off per person?",
        "headline": {"value": round(ch, 1), "unit": "%", "decimals": 1, "signed": True, "period": label(d, "Q"),
                     "caption": "change in real disposable income per person since June quarter 2022"},
        "benchmark": {"label": "Break-even", "text": "0% (no worse off than in 2022)"},
        "baseline": {"label": "June quarter 2022", "value": 100, "unit": "index"},
        "status": status_of(ch < 0),
        "status_rule": "Off track if real household disposable income per person is below its June quarter 2022 level.",
        "context": [
            f"That is about ${fmt(v_now, 0)} a year per person after adjusting for inflation, compared with ${fmt(at(pc, BASE_Q)[1], 0)} in the June quarter 2022 (ABS chain-volume dollars).",
            "Disposable income is what households have left after income tax and interest payments, adjusted for inflation.",
        ],
        "chart": {"kind": "line", "unit": "index", "decimals": 1,
                  "series": [{"name": "Real household disposable income per person (June qtr 2022 = 100)", "role": "primary", "points": idx}],
                  "ref": [{"value": 100, "label": "June quarter 2022"}]},
        "sources": [src_rba("h2", ["GGDPICHRDI"]), src_abs("ERP_COMP_Q", ["Estimated resident population, Australia"])],
        "method": "Real household disposable income ($m, chain volume, seasonally adjusted; RBA Table H2) divided by ABS estimated resident population, annualised (×4) and rebased to June quarter 2022 = 100. Limited to the latest quarter for which both series are available.",
    }


@metric
def government_size():
    mid = "government_size"
    s = rba_series("h2", "GGDPECCVPDS", mid)
    d, v = latest(s)
    check_fresh(mid, d, "Q")
    check_range(mid, "public demand share", v, 10, 50)
    pre = mean(x for dd, x in s if "2000-03-31" <= dd <= "2019-12-31")
    return {
        "id": mid, "section": "budget", "title": "Size of government in the economy",
        "question": "How much of the economy is now government spending and investment?",
        "headline": {"value": v, "unit": "%", "decimals": 1, "period": label(d, "Q"), "caption": "of the economy is public demand"},
        "benchmark": {"label": "2000–2019 average", "text": f"{fmt(pre)}%"},
        "baseline": {"label": "June quarter 2022", "value": at(s, BASE_Q)[1], "unit": "%"},
        "status": status_of(v > pre + 1, v > pre),
        "status_rule": "Off track if public demand's share of output is more than 1 percentage point above its 2000–2019 average; watch if above average.",
        "context": [
            f"Public demand (spending and investment by all levels of government) is {fmt(v - pre)} percentage points above its pre-COVID two-decade average.",
            f"In the June quarter 2022 it was {fmt(at(s, BASE_Q)[1])}%.",
            "This includes state and local governments as well as the Commonwealth.",
        ],
        "chart": {"kind": "line", "unit": "%", "decimals": 1,
                  "series": [{"name": "Public demand share of output", "role": "primary", "points": rnd(since(s, "2000-01-01"), 1)}],
                  "ref": [{"value": round(pre, 1), "label": f"2000–19 average {fmt(pre)}%"}]},
        "sources": [src_rba("h2", ["GGDPECCVPDS"])],
        "method": "Public final demand as a share of real output, ABS national accounts via RBA Table H2.",
    }


@metric
def housing_accord():
    mid = "housing_accord"
    rows = abs_api("BUILDING_ACTIVITY", "M6+M7.AUS.CUR.1.9.100.10.Q", "2015-Q1", "abs_building")
    g = abs_group(rows, "MEASURE")
    comp, comm = g["M7"], g["M6"]
    d = latest(comp)[0]
    check_fresh(mid, d, "Q")
    check_range(mid, "quarterly completions", latest(comp)[1], 10000, 120000)
    acc = since(comp, "2024-09-30")
    done = sum(x for _, x in acc)
    target_pace = 60000 * len(acc)
    shortfall = target_pace - done
    quarters_left = 20 - len(acc)
    needed = (1_200_000 - done) / quarters_left if quarters_left > 0 else float("nan")
    return {
        "id": mid, "section": "housing", "title": "Housing Accord: 1.2 million homes",
        "question": "Is the government on track to build 1.2 million new homes in five years from July 2024?",
        "headline": {"value": round(done / target_pace * 100), "unit": "%", "decimals": 0, "period": f"September quarter 2024 → {label(d, 'Q')}",
                     "caption": "of the required pace achieved"},
        "benchmark": {"label": "Required pace", "text": "60,000 completions a quarter (240,000 a year)"},
        "baseline": {"label": "Target", "value": 1200000, "unit": "homes"},
        "status": status_of(done < target_pace * 0.95, done < target_pace),
        "status_rule": "Off track if cumulative completions since July 2024 are more than 5% behind the 60,000-a-quarter pace needed; watch if behind at all.",
        "context": [
            f"{fmt(done, 0)} homes completed in {len(acc)} quarters, against {fmt(target_pace, 0)} needed to stay on pace: a shortfall of {fmt(shortfall, 0)}.",
            f"To reach 1.2 million, completions would now need to average {fmt(needed, 0)} a quarter for the remaining {quarters_left} quarters.",
            f"Latest quarter: {fmt(latest(comp)[1], 0)} completions and {fmt(latest(comm)[1], 0)} commencements.",
        ],
        "chart": {"kind": "bar", "unit": "homes", "decimals": 0,
                  "series": [{"name": "New dwellings completed per quarter", "role": "primary", "points": since(comp, "2019-01-01")}],
                  "ref": [{"value": 60000, "label": "Accord pace: 60,000/qtr"}]},
        "sources": [src_abs("BUILDING_ACTIVITY", ["Dwelling units completed, new residential, all sectors, Australia, original"])],
        "method": "Sum of ABS new residential dwelling completions (original series) from the September quarter 2024 (the Accord began 1 July 2024) to the latest quarter, compared with 1.2 million ÷ 20 quarters = 60,000 per quarter.",
    }


@metric
def home_prices():
    mid = "home_prices"
    price = abs_group(abs_api("RES_DWELL_ST", "5.AUS.Q", "2015-Q1", "abs_dwell_price"), "MEASURE")["5"]
    wpi = wpi_index()
    d = latest(price)[0]
    check_fresh(mid, d, "Q")
    v = latest(price)[1]
    check_range(mid, "mean dwelling price ($'000)", v, 300, 3000)
    pc = pct(at(price, BASE_Q)[1], v)
    wd = min(d, latest(wpi)[0])
    wc = pct(at(wpi, BASE_Q)[1], at(wpi, wd)[1])
    return {
        "id": mid, "section": "housing", "title": "Home prices",
        "question": "Is home ownership getting further out of reach?",
        "headline": {"value": round(v * 1000, -3), "unit": "$", "decimals": 0, "prefix": True, "period": label(d, "Q"),
                     "caption": "average price of a residential dwelling in Australia"},
        "benchmark": {"label": "Wages growth since June quarter 2022", "text": f"{fmt(wc)}%"},
        "baseline": {"label": "June quarter 2022", "value": at(price, BASE_Q)[1] * 1000, "unit": "$"},
        "status": status_of(pc > wc),
        "status_rule": "Off track if average dwelling prices have risen faster than wages since the June quarter 2022.",
        "context": [
            f"The average dwelling price is up {fmt(pc)}% (${fmt((v - at(price, BASE_Q)[1]) * 1000, 0)}) since the June quarter 2022, while wages rose {fmt(wc)}%.",
            "Homes are less affordable for first-home buyers relying on wages.",
        ],
        "chart": {"kind": "line", "unit": "$'000", "decimals": 0,
                  "series": [{"name": "Mean price of residential dwellings ($'000)", "role": "primary", "points": rnd(price, 1)}]},
        "sources": [src_abs("RES_DWELL_ST", ["Mean price of residential dwellings, Australia"]), src_abs("WPI", ["Wage Price Index, all sectors"])],
        "method": "ABS Total Value of Dwellings: mean price of residential dwellings (total value of dwelling stock ÷ number of dwellings). Compared with the Wage Price Index over the same period.",
    }


@metric
def migration():
    mid = "migration"
    rows = abs_api("ERP_COMP_Q", "9+10.AUS.Q", "2009-Q3", "abs_nom")
    g = abs_group(rows, "MEASURE")
    nom, pop = g["9"], g["10"]
    d = latest(nom)[0]
    check_fresh(mid, d, "Q_LAG")
    roll = [(nom[i][0], sum(x for _, x in nom[i - 3:i + 1])) for i in range(3, len(nom))]
    v = latest(roll)[1]
    check_range(mid, "annual NOM ('000)", v, -300, 1000)
    pre = mean(x for dd, x in roll if dd[5:7] == "06" and "2010-06-30" <= dd <= "2019-06-30")
    since_el = sum(x for dd, x in nom if dd >= "2022-09-30")
    comp = abs_group(abs_api("BUILDING_ACTIVITY", "M7.AUS.CUR.1.9.100.10.Q", "2021-Q1", "abs_building_comp"), "MEASURE")["M7"]
    cd = min(d, latest(comp)[0])
    pop_growth = at(pop, cd)[1] - at(pop, f"{int(cd[:4]) - 1}{cd[4:]}")[1]
    homes = sum(x for dd, x in comp if dd > f"{int(cd[:4]) - 1}{cd[4:]}" and dd <= cd)
    return {
        "id": mid, "section": "population", "title": "Net overseas migration",
        "question": "How fast is migration adding to demand for housing and services?",
        "headline": {"value": round(v * 1000, -3), "unit": "", "decimals": 0, "period": f"12 months to {label(d, 'Q')}",
                     "caption": "net overseas migration"},
        "benchmark": {"label": "Pre-COVID average (2009–10 to 2018–19)", "text": f"{fmt(pre * 1000, 0)} a year"},
        "baseline": {"label": "12 months to June quarter 2022", "value": at(roll, BASE_Q)[1] * 1000, "unit": "people"},
        "status": status_of(v > pre * 1.1, v > pre),
        "status_rule": "Off track if annual net overseas migration is more than 10% above the pre-COVID decade average; watch if above average.",
        "context": [
            f"{fmt(since_el * 1000, 0)} people have been added through net overseas migration since July 2022.",
            f"In the year to {label(cd, 'Q')} Australia's population grew by {fmt(pop_growth * 1000, 0)} while {fmt(homes, 0)} new homes were completed: {fmt(pop_growth * 1000 / homes, 1)} new residents for every new home.",
        ],
        "chart": {"kind": "line", "unit": "people", "decimals": 0,
                  "series": [{"name": "Net overseas migration, rolling 12 months", "role": "primary", "points": [[dd, round(x * 1000)] for dd, x in since(roll, "2012-01-01")]}],
                  "ref": [{"value": round(pre * 1000), "label": "Pre-COVID average"}]},
        "sources": [src_abs("ERP_COMP_Q", ["Net overseas migration, Australia, quarterly", "Estimated resident population"]),
                    src_abs("BUILDING_ACTIVITY", ["Dwelling units completed, new residential, all sectors, original"])],
        "method": "Sum of the latest four quarters of ABS net overseas migration. Pre-COVID benchmark is the average of financial-year totals 2009–10 to 2018–19. Population growth is the change in estimated resident population over the same 12 months.",
    }


# --------------------------------------------------------------------------- manual (hand-verified) metrics

def load_manual():
    path = os.path.join(DATA_DIR, "manual.json")
    if not os.path.exists(path):
        return {"metrics": [], "attachments": []}
    with open(path) as f:
        man = json.load(f)
    today = NOW.date().isoformat()
    for m in man.get("metrics", []):
        for s in m.get("sources", []):
            s.setdefault("automated", False)
        rb = m.get("recheck_by")
        if rb and rb < today:
            log_check(m["id"], "manual re-verification due", "warn",
                      f"recheck_by {rb} has passed: figure must be re-verified against source")
            m["recheck_overdue"] = True
        else:
            log_check(m["id"], "manual verification date", "pass",
                      f"verified {m.get('verified_on')}, next check by {rb}")
    return man


def check_links(urls):
    """Confirm every cited source page still resolves. 403s from bot-protection are warnings."""
    for url in sorted(set(urls)):
        code = http_status(url)
        if code == 200:
            log_check("sources", "link resolves", "pass", url)
        elif code in (0, 401, 403, 429):
            log_check("sources", "link resolves", "warn", f"{url} returned {code} to automated check (site blocks bots). Verify manually")
        else:
            log_check("sources", "link resolves", "fail", f"{url} returned {code}")


# --------------------------------------------------------------------------- automated benchmarks for hand-verified metrics

def enrich_aps(m):
    """Compare APS growth (30 Jun 2022 → 30 Jun 2025) with ABS population growth over the same dates."""
    pop = abs_group(abs_api("ERP_COMP_Q", "10.AUS.Q", "2014-Q1", "abs_erp"), "MEASURE")["10"]
    p0, p1 = at(pop, "2022-06-30")[1], at(pop, "2025-06-30")[1]
    pg = pct(p0, p1)
    aps_g = m["headline"]["value"]
    m["benchmark"] = {"label": "Population growth, same period (ABS)", "text": f"{signed(pg)}%"}
    m["status"] = status_of(aps_g > 2 * pg, aps_g > pg)
    m["status_rule"] = "Off track if APS headcount grew more than twice as fast as Australia's population over the same period; watch if faster at all."
    m["context"].insert(1, f"Australia's population grew {fmt(pg)}% over the same three years, so the APS grew about {fmt(aps_g / pg, 1)} times faster than the population it serves.")
    m["sources"].append(src_abs("ERP_COMP_Q", ["Estimated resident population, Australia, June 2022 and June 2025 (benchmark computed automatically)"]))
    log_check(m["id"], "automated benchmark", "pass", f"population growth {pg:.2f}% computed from ABS ERP")


AOFM_EOFY_URL = ("https://www.aofm.gov.au/sites/default/files/2025-06-06/"
                 "portfolio_aggregate_-_executive_summary_-_dealt.xlsx")


def enrich_gross_debt(m):
    """Cross-check every actual year of gross debt against AOFM's register of securities on issue at 30 June,
    and surface any newer 30 June position that the Budget papers haven't reported yet."""
    grid = xlsx_sheet(AOFM_EOFY_URL, "aofm_eofy", "Portfolio")
    hdr_row = next(rn for rn, c in grid.items() if str(c.get("A", "")).strip().lower() == "liability / asset")
    tot_row = next(rn for rn, c in grid.items() if any(str(v).strip() == "Total AUD/Non-AUD LIABILITY" for v in c.values()))
    aofm = {}
    for col, v in grid[hdr_row].items():
        try:
            d = dt.date(1899, 12, 30) + dt.timedelta(days=int(float(v)))
        except ValueError:
            continue
        if d.month == 6 and d.day == 30 and col in grid[tot_row]:
            aofm[d.isoformat()] = abs(float(grid[tot_row][col])) / 1e9      # $ billion, face value
    if not aofm:
        raise RuntimeError("AOFM sheet layout changed: no 30 June columns found")
    est_from = m["chart"].get("estimateFrom", "9999")
    actual = [(d, v) for d, v in m["chart"]["series"][0]["points"] if d < est_from]
    bad = []
    for d, v in actual:
        if d not in aofm:
            log_check(m["id"], f"AOFM cross-check {d}", "warn", "no AOFM 30 June column for this year")
            continue
        if abs(aofm[d] - v) > 0.06:
            bad.append(f"{d}: site ${v:,.1f}bn vs AOFM ${aofm[d]:,.1f}bn")
    matched = sum(1 for d, _ in actual if d in aofm)
    if bad:
        log_check(m["id"], "AOFM cross-check of actual years", "fail", "; ".join(bad), critical=True)
        m["stale"] = True
        m["stale_reason"] = "Today's cross-check against the AOFM register found a mismatch. These figures are under review."
    else:
        m["cross_checked"] = True
        log_check(m["id"], "AOFM cross-check of actual years", "pass",
                  f"{matched} years ({actual[0][0][:4]}–{actual[-1][0][:4]}) match AOFM securities on issue within $0.06bn")
    last_actual = actual[-1][0]
    newer = sorted(d for d in aofm if d > last_actual)
    if newer:
        d = newer[-1]
        budget_est = dict(m["chart"]["series"][0]["points"]).get(d)
        yr = dt.date.fromisoformat(d)
        line = (f"AOFM's register shows ${aofm[d]:,.1f} billion of Australian Government Securities on issue at "
                f"30 June {yr.year}"
                + (f", compared with the Budget estimate of ${budget_est:,.1f} billion" if budget_est else "")
                + f". The official {yr.year - 1}–{str(yr.year)[2:]} figure is confirmed in the Final Budget Outcome.")
        m["context"].insert(2, line)
        log_check(m["id"], "newer AOFM position available", "warn",
                  f"AOFM reports 30 June {yr.year} = ${aofm[d]:,.1f}bn; update manual.json when the Final Budget Outcome is published")
    m["sources"].append({"publisher": "Australian Office of Financial Management", "title": "Data Hub: End of Financial Year Positions – Executive Summary (automated daily cross-check)",
                         "url": "https://www.aofm.gov.au/data-hub", "data_url": AOFM_EOFY_URL,
                         "series": ["Total AUD/Non-AUD LIABILITY, face value at 30 June"],
                         "retrieved_at": NOW.isoformat(timespec="seconds"), "automated": True})


ENRICH = {"aps_headcount": enrich_aps, "gross_debt": enrich_gross_debt}


# --------------------------------------------------------------------------- main

def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    prev_path = os.path.join(DATA_DIR, "metrics.json")
    prev = {}
    if os.path.exists(prev_path):
        with open(prev_path) as f:
            prev = {m["id"]: m for m in json.load(f).get("metrics", [])}

    results, critical = [], False
    for fn in METRICS:
        print(f"\n▶ {fn.__name__}")
        try:
            m = fn()
            m["automated"] = True
            m["updated_at"] = NOW.isoformat(timespec="seconds")
            m["explainer"] = EXPLAINERS.get(m["id"])
            old = prev.get(m["id"])
            if old and old.get("headline", {}).get("period") == m["headline"]["period"] \
                    and old["headline"]["value"] != m["headline"]["value"]:
                log_check(m["id"], "revision detected", "warn",
                          f"{old['headline']['value']} → {m['headline']['value']} for the same period "
                          "(official statistics are routinely revised)")
            results.append(m)
        except Exception as e:  # noqa: BLE001
            critical = True
            traceback.print_exc()
            log_check(fn.__name__, "metric build", "fail", f"{type(e).__name__}: {e}", critical=True)
            if fn.__name__ in prev:
                keep = prev[fn.__name__]
                keep["stale"] = True
                keep["stale_reason"] = ("Today's automated check could not confirm this figure. "
                                        "The last verified value is shown until it can be re-verified.")
                results.append(keep)

    man = load_manual()
    by_id = {m["id"]: m for m in results}
    for att in man.get("attachments", []):          # hand-verified context attached to automated metrics
        if att["metric"] in by_id:
            tgt = by_id[att["metric"]]
            tgt.setdefault("promise", att.get("promise"))
            tgt["context"] = tgt["context"] + att.get("context", [])
            tgt["sources"] = tgt["sources"] + [dict(s, automated=False) for s in att.get("sources", [])]
    for m in man.get("metrics", []):
        try:
            ENRICH.get(m["id"], lambda x: None)(m)
        except Exception as e:  # noqa: BLE001
            log_check(m["id"], "automated benchmark", "warn", f"could not compute: {e}")
    results += man.get("metrics", [])

    budget = man.get("budget")
    if budget:
        for y in budget["years"]:
            for kind in ("revenue", "expenses"):
                parts = sum(x["value_m"] for x in y[kind])
                total = y[f"{kind}_total_m"]
                ok = abs(parts - total) <= max(5, total * 0.0005)
                log_check("budget", f"{y['year']} {kind}: categories sum to published total", "pass" if ok else "fail",
                          f"categories ${parts:,}m vs published ${total:,}m", critical=not ok)
                for x in y[kind]:
                    sub = sum(v for _, v in x["detail"])
                    if sub != x["value_m"]:
                        log_check("budget", f"{y['year']} {x['name']} detail sums", "fail", f"{sub} != {x['value_m']}", critical=True)
                        critical = True
                critical = critical or not ok

    urls = [s["url"] for m in results for s in m.get("sources", []) if s.get("url")]
    urls += [y["url"] for y in (budget or {}).get("years", [])]
    print("\n▶ source links")
    check_links(urls)

    order = ["cost", "energy", "housing", "jobs", "living", "budget", "population", "governance"]
    results.sort(key=lambda m: order.index(m["section"]) if m["section"] in order else 99)

    summary = {
        "generated_at": NOW.isoformat(timespec="seconds"),
        "checks_total": len(CHECKS),
        "checks_passed": sum(c["status"] == "pass" for c in CHECKS),
        "checks_warn": sum(c["status"] == "warn" for c in CHECKS),
        "checks_failed": sum(c["status"] == "fail" for c in CHECKS),
        "metrics_total": len(results),
        "metrics_off_track": sum(m.get("status") == "fail" for m in results),
        "metrics_watch": sum(m.get("status") == "warn" for m in results),
        "metrics_on_track": sum(m.get("status") == "pass" for m in results),
        "metrics_rated": sum(m.get("status") in ("pass", "warn", "fail") for m in results),
    }
    out = {"summary": summary, "sworn_in": SWORN_IN, "sections": SECTIONS, "metrics": results, "budget": budget}
    with open(prev_path, "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    with open(os.path.join(DATA_DIR, "metrics.js"), "w") as f:
        f.write("window.SCORECARD = " + json.dumps(out, ensure_ascii=False) + ";\n")

    vpath = os.path.join(DATA_DIR, "verification.json")
    history = []
    if os.path.exists(vpath):
        with open(vpath) as f:
            history = json.load(f).get("history", [])
    history = ([{**summary, "sources": SOURCES_USED}] + history)[:90]
    with open(vpath, "w") as f:
        json.dump({"latest": {**summary, "checks": CHECKS, "sources": SOURCES_USED}, "history": history},
                  f, indent=1, ensure_ascii=False)
    with open(os.path.join(DATA_DIR, "verification.js"), "w") as f:
        f.write("window.VERIFICATION = " + json.dumps({"latest": {**summary, "checks": CHECKS}}, ensure_ascii=False) + ";\n")

    print(f"\n{summary}")
    return 1 if critical else 0


# Plain-English explainers shown behind each metric's (i) icon.
EXPLAINERS = {
    "inflation": {
        "what": "Inflation is how fast prices are rising across a typical basket of goods and services: food, rent, petrol, power, insurance and more. The ABS measures it with the Consumer Price Index (CPI), and this figure compares prices with the same quarter a year earlier.",
        "why": "When inflation runs above wage growth, household budgets shrink. The Reserve Bank aims to keep inflation between 2% and 3% on average. Inflation above that band usually means higher interest rates.",
    },
    "prices_vs_wages": {
        "what": "This compares how much the prices of everyday essentials have risen since mid-2022 with how much wages have risen. Wages are measured by the ABS Wage Price Index, which tracks pay for the same jobs over time.",
        "why": "If the things you must buy rise faster than your pay, you are worse off even if your pay rose. It shows where the squeeze on households is coming from.",
    },
    "real_wages": {
        "what": "'Real' wages are wages adjusted for inflation: what your pay can actually buy. We divide the Wage Price Index by the Consumer Price Index and set mid-2022 to 100. Below 100 means pay buys less than it did then. Private-sector and public-sector workers are shown separately.",
        "why": "A pay rise is only a real gain if it beats inflation. The sector split shows whether workers in private business have fared differently from government employees.",
    },
    "electricity": {
        "what": "The change in household electricity prices recorded in the Consumer Price Index since the June quarter 2022, shown next to overall inflation. The ABS counts government bill rebates as a price reduction while they are paid.",
        "why": "Power bills hit every household and business. Before the 2022 election, lower power bills were a central promise.",
    },
    "mortgage": {
        "what": "The average interest rate on existing variable home loans for owner-occupiers (RBA data), and what that means in monthly repayments on a typical $600,000, 30-year loan compared with May 2022.",
        "why": "About a third of Australian households are paying off a mortgage. Higher repayments take money directly out of their budgets.",
    },
    "interest_rates": {
        "what": "The cash rate is the Reserve Bank's official interest rate. Banks base their lending rates on it. This counts every decision to raise or cut it since the government was sworn in on 23 May 2022.",
        "why": "The RBA is independent, but it raises rates when inflation is too high, and government spending affects inflation. At current rates, each 0.25-point rise adds about $100 a month to repayments on a $600,000 loan.",
    },
    "consumer_confidence": {
        "what": "The Westpac–Melbourne Institute survey asks around 1,200 Australian adults each month how they feel about their family finances and the economy. 100 means optimists and pessimists are evenly balanced. Below 100 means pessimists outnumber optimists.",
        "why": "Confidence shapes spending, hiring and investment. A long run below 100 is a clear sign that households feel worse off.",
    },
    "unemployment": {
        "what": "The share of people in the labour force (working or actively looking for work) who do not have a job, from the ABS Labour Force Survey of about 50,000 people each month. Seasonally adjusted.",
        "why": "It is the most-watched measure of whether the economy is providing enough work. It doesn't show underemployment (people who want more hours) or what kind of jobs are being created.",
    },
    "public_private_jobs": {
        "what": "The ABS Labour Account counts filled jobs and classifies each employer as public sector (federal, state and local government and government-owned businesses) or private sector. This compares how fast each has grown since mid-2022.",
        "why": "Private businesses fund the tax base. If government employment grows faster than private employment, more of the economy depends on taxpayers.",
    },
    "jobs_by_sector": {
        "what": "Change in filled jobs in each of the 19 major industries since mid-2022. Health care & social assistance (which includes NDIS and aged care), education, and public administration are highlighted. Economists call these the 'non-market' sector because they are mostly paid for by government.",
        "why": "Headline job numbers can look strong even when growth relies on government-funded programs rather than a thriving private economy. This shows where the jobs are actually coming from.",
    },
    "productivity": {
        "what": "Labour productivity is how much the economy produces for each hour worked, measured here for the non-farm economy in the ABS national accounts. We compare average annual growth since mid-2022 with the 2000–2019 average.",
        "why": "Productivity is the only lasting way to raise wages and living standards. The Productivity Commission and RBA have both warned that weak productivity growth holds back real incomes.",
    },
    "gdp_per_capita": {
        "what": "Gross domestic product (the total value of everything the economy produces), adjusted for inflation and divided by the population. This figure is the change over the past year.",
        "why": "Total GDP can grow just because the population grows. GDP per person shows whether the economy is growing for each Australian. When it falls for two quarters in a row, it is often called a 'per capita recession'.",
    },
    "household_income": {
        "what": "Real household disposable income is the income households have left after income tax and interest payments, adjusted for inflation. We divide it by the population and set mid-2022 to 100.",
        "why": "It is one of the most complete measures of whether the average person is better or worse off, because it includes the effects of tax, interest rates and prices.",
    },
    "government_size": {
        "what": "Public demand is spending and investment by federal, state and local governments (such as salaries, services, infrastructure and defence) as a share of total economic output, from the ABS national accounts.",
        "why": "When government takes up a bigger share of the economy, it can crowd out private investment and add to inflation. We compare it with the two decades before COVID.",
    },
    "housing_accord": {
        "what": "Under the National Housing Accord, federal and state governments committed to 1.2 million new homes in the five years from 1 July 2024. That is 60,000 a quarter. We add up ABS new dwelling completions since then.",
        "why": "It is the government's own target. Falling behind means rents and prices stay under pressure, especially while population growth is strong.",
    },
    "home_prices": {
        "what": "The ABS calculates the average price of a residential dwelling by dividing the total value of all homes by the number of homes. We compare its growth since mid-2022 with wage growth.",
        "why": "When home prices grow faster than wages, saving a deposit and paying off a mortgage takes longer. Home ownership moves out of reach for younger Australians.",
    },
    "migration": {
        "what": "Net overseas migration is the number of people arriving to live in Australia (for at least 12 of the next 16 months), minus residents leaving on the same basis. It includes students, workers and permanent migrants. ABS data, summed over the latest 12 months.",
        "why": "Migration drives population growth, which adds to demand for housing, roads, hospitals and schools. We compare it with the pre-COVID average and with how many homes are being built.",
    },
}

SECTIONS = [
    {"id": "cost", "title": "Cost of living", "blurb": "What families pay, and whether pay packets have kept up."},
    {"id": "energy", "title": "Energy", "blurb": "Power bills and the promises made about them."},
    {"id": "housing", "title": "Housing", "blurb": "Building targets, prices and mortgage pain."},
    {"id": "jobs", "title": "Jobs, business & productivity", "blurb": "Who is hiring, who is going broke, and whether we're getting more productive."},
    {"id": "living", "title": "Living standards", "blurb": "Growth that matters: per person, after inflation."},
    {"id": "budget", "title": "Budget, debt & the size of government", "blurb": "Spending, debt, interest and the bureaucracy."},
    {"id": "population", "title": "Population", "blurb": "Migration and pressure on homes and services."},
    {"id": "governance", "title": "Governance, defence & delivery", "blurb": "Legislation, defence and big-program delivery."},
]

if __name__ == "__main__":
    sys.exit(main())
