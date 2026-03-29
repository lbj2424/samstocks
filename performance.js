// ---------------- Period logic ----------------
function monthFromISODate(iso) {
  return String(iso || "").trim().slice(0, 7);
}

function addMonths(yyyymm, delta) {
  const [y, m] = yyyymm.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, 1));
  dt.setUTCMonth(dt.getUTCMonth() + delta);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}

function quarterStartMonth(yyyymm) {
  const [y, m] = yyyymm.split("-").map(Number);
  const qStart = m <= 3 ? 1 : m <= 6 ? 4 : m <= 9 ? 7 : 10;
  return `${y}-${String(qStart).padStart(2, "0")}`;
}

function prevQuarterRange(yyyymm) {
  const [y] = yyyymm.split("-").map(Number);
  const thisQStart = Number(quarterStartMonth(yyyymm).split("-")[1]);
  let endMonth = thisQStart - 1;
  let endYear  = y;
  if (endMonth <= 0) { endMonth += 12; endYear -= 1; }

  const startMonth = endMonth - 2;
  const startYear  = startMonth <= 0 ? endYear - 1 : endYear;
  const sm         = startMonth <= 0 ? startMonth + 12 : startMonth;

  return {
    start: `${startYear}-${String(sm).padStart(2, "0")}`,
    end:   `${endYear}-${String(endMonth).padStart(2, "0")}`
  };
}

function inMonthRange(m, start, end) {
  return m >= start && m <= end;
}

function periodRange(periodKey, asOfMonth) {
  if (periodKey === "MTD") return { label: "Month-to-Date", startMonth: asOfMonth, endMonth: asOfMonth };
  if (periodKey === "QTD") {
    const start = quarterStartMonth(asOfMonth);
    return { label: "Quarter-to-Date", startMonth: start, endMonth: asOfMonth };
  }
  if (periodKey === "YTD") {
    const y = asOfMonth.slice(0, 4);
    return { label: "Year-to-Date", startMonth: `${y}-01`, endMonth: asOfMonth };
  }
  if (periodKey === "LM") {
    const lm = addMonths(asOfMonth, -1);
    return { label: "Last Month", startMonth: lm, endMonth: lm };
  }
  if (periodKey === "LQ") {
    const r = prevQuarterRange(asOfMonth);
    return { label: "Last Quarter", startMonth: r.start, endMonth: r.end };
  }
  if (periodKey === "LTM") {
    const start = addMonths(asOfMonth, -11);
    return { label: "Last 12 Months", startMonth: start, endMonth: asOfMonth };
  }
  return { label: "Since Inception", startMonth: null, endMonth: asOfMonth };
}

// ---------------- IRR ----------------
function calcIRRMonthly(cashflows) {
  if (!cashflows || cashflows.length < 2) return null;

  let hasNeg = false, hasPos = false;
  for (const cf of cashflows) {
    if (cf.amount < 0) hasNeg = true;
    if (cf.amount > 0) hasPos = true;
  }
  if (!hasNeg || !hasPos) return null;

  const npv = (r) => cashflows.reduce((s, cf) => s + cf.amount / Math.pow(1 + r, cf.tMonths), 0);

  let lo = -0.95, hi = 10;
  let fLo = npv(lo), fHi = npv(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) return null;

  if (fLo * fHi > 0) {
    hi  = 50;
    fHi = npv(hi);
    if (!Number.isFinite(fHi) || fLo * fHi > 0) return null;
  }

  for (let i = 0; i < 120; i++) {
    const mid  = (lo + hi) / 2;
    const fMid = npv(mid);
    if (!Number.isFinite(fMid)) return null;
    if (Math.abs(fMid) < 1e-8) { lo = hi = mid; break; }
    if (fLo * fMid <= 0) { hi = mid; fHi = fMid; }
    else                 { lo = mid; fLo = fMid; }
  }

  return Math.pow(1 + (lo + hi) / 2, 12) - 1;
}

function buildCashflowsForPeriod(buyRows, sellRows, priceMap, asOfISO) {
  const asOfMonth = monthFromISODate(asOfISO);
  const allMonths = [...buyRows, ...sellRows].map(r => r.month).filter(Boolean).sort();
  if (!allMonths.length) return null;

  const startMonth = allMonths[0];
  const tIndex = (m) => {
    const [sy, sm] = startMonth.split("-").map(Number);
    const [y,  mo] = m.split("-").map(Number);
    return (y - sy) * 12 + (mo - sm);
  };

  const cashflows = [];

  // Buys = money out (negative)
  for (const r of buyRows) {
    const m        = String(r.month || "").trim();
    const invested = Number(r.total_cost);
    if (!m || !Number.isFinite(invested) || invested <= 0) continue;
    cashflows.push({ tMonths: tIndex(m), amount: -invested });
  }

  // Sell proceeds = money back in (positive)
  for (const r of sellRows) {
    const m        = String(r.month || "").trim();
    const proceeds = Number(r.total_cost);
    if (!m || !Number.isFinite(proceeds) || proceeds <= 0) continue;
    cashflows.push({ tMonths: tIndex(m), amount: proceeds });
  }

  // Ending value = current market value of shares from buy rows
  let endingValue = 0;
  for (const r of buyRows) {
    const t      = String(r.ticker || "").trim().toUpperCase();
    const price  = priceMap[t];
    const shares = Number(r.shares);
    if (typeof price !== "number" || Number.isNaN(price)) continue;
    if (!Number.isFinite(shares) || shares <= 0) continue;
    endingValue += shares * price;
  }

  if (endingValue <= 0 && sellRows.length === 0) return null;
  cashflows.push({ tMonths: tIndex(asOfMonth), amount: endingValue });
  return cashflows;
}

// ---------------- Sorting ----------------
let sortState      = { key: "value", dir: "desc" };
let currentAggRows = [];

function initTableSorting() {
  const table = document.getElementById("perfTable");
  if (!table || table.dataset.sortInit) return;

  table.querySelectorAll("thead th[data-sort]").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (sortState.key === key) sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      else { sortState.key = key; sortState.dir = "desc"; }

      const sorted = sortRows(currentAggRows, sortState.key, sortState.dir);
      updateSortIndicators(table, sortState.key, sortState.dir);
      renderTable(sorted);
    });
  });

  table.dataset.sortInit = "1";
}

function renderTable(aggRows) {
  const tbody = document.querySelector("#perfTable tbody");
  tbody.innerHTML = "";

  for (const r of aggRows) {
    const cls         = r.gainPct >= 0 ? "pos" : "neg";
    const contribCls  = r.contribPct >= 0 ? "pos" : "neg";
    const contribText = (r.contribPct * 100).toFixed(2) + "%";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.ticker}</td>
      <td>${money(r.invested)}</td>
      <td>${money(r.value)}</td>
      <td class="${cls}">${money(r.gain)}</td>
      <td class="${cls}">${pct(r.gainPct)}</td>
      <td class="${contribCls}">${contribText}</td>
      <td>${(r.weight * 100).toFixed(2)}%</td>
      <td>${r.txns}</td>
    `;
    tbody.appendChild(tr);
  }
}

function setActivePeriod(periodKey) {
  document.querySelectorAll(".periodBtn").forEach(b =>
    b.classList.toggle("active", b.dataset.period === periodKey)
  );
}

// ---------------- Main ----------------
let currentPeriod = "YTD";

async function main() {
  let allRows, pricesFile;
  try {
    [allRows, pricesFile] = await Promise.all([
      loadCSV("portfolio.csv"),
      loadJSON("prices.json")
    ]);
  } catch (err) {
    showError("Failed to load data. Check that portfolio.csv and prices.json are present.");
    console.error(err);
    return;
  }

  const priceMap  = pricesFile.prices || {};
  const asOfISO   = pricesFile.asOf   || "";
  const asOfMonth = monthFromISODate(asOfISO);

  document.getElementById("asOf").textContent = `As of: ${asOfISO || "—"}`;

  const bar = document.getElementById("periodBar");
  if (!bar.dataset.init) {
    bar.dataset.init = "1";
    setActivePeriod(currentPeriod);
    bar.addEventListener("click", (e) => {
      const btn = e.target.closest(".periodBtn");
      if (!btn) return;
      currentPeriod = btn.dataset.period;
      setActivePeriod(currentPeriod);
      renderForPeriod(filterByAccount(allRows, getActiveAccount()), priceMap, asOfISO, asOfMonth, currentPeriod);
    });
  }

  initTableSorting();

  initAccountTabs(account => {
    renderForPeriod(filterByAccount(allRows, account), priceMap, asOfISO, asOfMonth, currentPeriod);
  });
}

function renderForPeriod(portfolio, priceMap, asOfISO, asOfMonth, periodKey) {
  const { label, startMonth, endMonth } = periodRange(periodKey, asOfMonth);

  const rows = portfolio.filter(r => {
    const m = String(r.month || "").trim();
    if (!m) return false;
    if (periodKey === "SI") return m <= endMonth;
    return inMonthRange(m, startMonth, endMonth);
  });

  const pm = document.getElementById("periodMeta");
  pm.textContent = periodKey === "SI"
    ? `${label}: start → ${monthLabel(endMonth)} (monthly view)`
    : `${label}: ${monthLabel(startMonth)} → ${monthLabel(endMonth)} (monthly view)`;

  const buyRows  = rows.filter(r => (r.type || "buy") === "buy");
  const sellRows = rows.filter(r => (r.type || "buy") === "sell");

  let totalInvested = 0;
  let totalValue    = 0;
  const byTicker    = new Map();

  for (const r of buyRows) {
    const t        = String(r.ticker || "").trim().toUpperCase();
    if (!t) continue;
    const shares   = Number(r.shares);
    const invested = Number(r.total_cost);
    const price    = priceMap[t];
    if (!Number.isFinite(shares) || shares <= 0) continue;
    if (!Number.isFinite(invested)) continue;
    if (typeof price !== "number" || Number.isNaN(price)) continue;

    const value = shares * price;
    totalInvested += invested;
    totalValue    += value;

    if (!byTicker.has(t)) byTicker.set(t, { ticker: t, invested: 0, value: 0, txns: 0 });
    const agg = byTicker.get(t);
    agg.invested += invested;
    agg.value    += value;
    agg.txns     += 1;
  }

  const aggRows = [...byTicker.values()].map(r => {
    const gain    = r.value - r.invested;
    const gainPct = r.invested === 0 ? 0 : gain / r.invested;
    return { ...r, gain, gainPct, weight: 0 };
  });

  for (const r of aggRows) r.weight = totalValue === 0 ? 0 : r.value / totalValue;

  const totalGain = totalValue - totalInvested;
  const returnPct = totalInvested === 0 ? 0 : totalGain / totalInvested;

  for (const r of aggRows) {
    r.contribPct = r.gainPct * r.weight;
  }

  document.getElementById("kpiInvested").textContent = money(totalInvested);
  document.getElementById("kpiValue").textContent    = money(totalValue);
  document.getElementById("kpiGain").textContent     = money(totalGain);
  document.getElementById("kpiReturn").textContent   = pct(returnPct);

  const uniqueTickers = new Set(aggRows.map(r => r.ticker));
  document.getElementById("kpiTickers").textContent = String(uniqueTickers.size);
  document.getElementById("kpiTxns").textContent    = String(buyRows.length);

  const sorted = aggRows.slice().sort((a, b) => b.gainPct - a.gainPct);
  const best   = sorted[0];
  const worst  = sorted[sorted.length - 1];

  document.getElementById("bestTicker").textContent  = best  ? best.ticker  : "—";
  document.getElementById("bestPct").textContent     = best  ? pct(best.gainPct)  : "—";
  document.getElementById("worstTicker").textContent = worst ? worst.ticker : "—";
  document.getElementById("worstPct").textContent    = worst ? pct(worst.gainPct) : "—";

  const cashflows = buildCashflowsForPeriod(buyRows, sellRows, priceMap, asOfISO);
  const irr       = cashflows ? calcIRRMonthly(cashflows) : null;
  document.getElementById("kpiIRR").textContent = irr == null ? "—%" : `${(irr * 100).toFixed(2)}%`;

  currentAggRows = aggRows;
  const tableSorted = sortRows(currentAggRows, sortState.key, sortState.dir);
  updateSortIndicators(document.getElementById("perfTable"), sortState.key, sortState.dir);
  renderTable(tableSorted);
}

main().catch(err => {
  console.error(err);
  showError("Performance page error. Check console.");
});
