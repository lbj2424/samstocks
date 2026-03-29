// ---------- Chart instances ----------
let allocChart = null;
let gainsChart = null;
let timelineChart = null;
let sortState = { key: "value", dir: "desc" };
let currentTableRows = [];

// ---------- Filter + sort helper ----------
function getFilteredSortedRows() {
  const input  = document.getElementById("holdingsSearch");
  const filter = input ? input.value.trim().toUpperCase() : "";
  const rows   = filter
    ? currentTableRows.filter(r => r.ticker.includes(filter))
    : currentTableRows;
  return sortRows(rows, sortState.key, sortState.dir);
}

// ---------- Cached data (loaded once) ----------
let _portfolio = null;
let _pricesFile = null;
let _divBreakdown = []; // [{ticker, count, total}] updated each render

// ---------- vLine plugin ----------
const vLinePlugin = {
  id: "vLinePlugin",
  afterDatasetsDraw(chart, _args, opts) {
    const selectedIndex = opts?.selectedIndex;
    if (selectedIndex == null || selectedIndex < 0) return;

    const { ctx, chartArea } = chart;
    const xScale = chart.scales.x;
    if (!xScale) return;

    const x = xScale.getPixelForValue(selectedIndex);
    if (!Number.isFinite(x)) return;
    if (x < chartArea.left || x > chartArea.right) return;

    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = "rgba(232,238,252,.35)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  }
};

// ---------- Table ----------
function buildTable(rows) {
  const tbody = document.querySelector("#holdingsTable tbody");
  tbody.innerHTML = "";

  for (const r of rows) {
    const tr = document.createElement("tr");
    const cls = r.gainPct >= 0 ? "pos" : "neg";
    tr.innerHTML = `
      <td><a class="tickerLink" href="ticker.html?ticker=${r.ticker}">${r.ticker}</a></td>
      <td>${r.shares.toFixed(6)}</td>
      <td>${money(r.avg_cost)}</td>
      <td>${money(r.price)}</td>
      <td>${money(r.invested)}</td>
      <td>${money(r.value)}</td>
      <td class="${cls}">${money(r.gain)}</td>
      <td class="${cls}">${pct(r.gainPct)}</td>
    `;
    tbody.appendChild(tr);
  }

  // Totals row
  const totalInvested = rows.reduce((s, r) => s + r.invested, 0);
  const totalValue    = rows.reduce((s, r) => s + r.value, 0);
  const totalGain     = totalValue - totalInvested;
  const totalGainPct  = totalInvested === 0 ? 0 : totalGain / totalInvested;
  const cls = totalGainPct >= 0 ? "pos" : "neg";

  let tfoot = document.querySelector("#holdingsTable tfoot");
  if (!tfoot) {
    tfoot = document.createElement("tfoot");
    document.getElementById("holdingsTable").appendChild(tfoot);
  }
  tfoot.innerHTML = `
    <tr class="totalsRow">
      <td><strong>Total</strong></td>
      <td>—</td>
      <td>—</td>
      <td>—</td>
      <td><strong>${money(totalInvested)}</strong></td>
      <td><strong>${money(totalValue)}</strong></td>
      <td class="${cls}"><strong>${money(totalGain)}</strong></td>
      <td class="${cls}"><strong>${pct(totalGainPct)}</strong></td>
    </tr>
  `;
}

function initMainTableSorting() {
  const table = document.getElementById("holdingsTable");
  if (!table || table.dataset.sortInit) return;

  table.querySelectorAll("thead th[data-sort]").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (sortState.key === key) {
        sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      } else {
        sortState.key = key;
        sortState.dir = "desc";
      }
      updateSortIndicators(table, sortState.key, sortState.dir);
      buildTable(getFilteredSortedRows());
    });
  });

  // Wire search input (once)
  const searchInput = document.getElementById("holdingsSearch");
  if (searchInput && !searchInput.dataset.wired) {
    searchInput.dataset.wired = "1";
    searchInput.addEventListener("input", () => buildTable(getFilteredSortedRows()));
  }

  table.dataset.sortInit = "1";
}

// ---------- Charts ----------
function makeCharts(rows) {
  const byTicker = new Map();
  for (const r of rows) {
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, { ticker: r.ticker, value: 0, invested: 0 });
    const agg = byTicker.get(r.ticker);
    agg.value   += r.value;
    agg.invested += r.invested;
  }

  const aggRows = [...byTicker.values()].sort((a, b) => b.value - a.value);
  const labels  = aggRows.map(r => r.ticker);
  const values  = aggRows.map(r => r.value);
  const gains   = aggRows.map(r => r.invested === 0 ? 0 : ((r.value - r.invested) / r.invested) * 100);

  // Color bars green/red based on gain sign
  const barColors = gains.map(g => g >= 0 ? "rgba(124,255,178,0.75)" : "rgba(255,124,124,0.75)");

  if (allocChart) allocChart.destroy();
  if (gainsChart) gainsChart.destroy();

  allocChart = new Chart(document.getElementById("chartAlloc"), {
    type: "doughnut",
    data: { labels, datasets: [{ data: values }] },
    options: { plugins: { legend: { position: "bottom", labels: { color: "#e8eefc" } } } }
  });

  gainsChart = new Chart(document.getElementById("chartGains"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Gain %",
        data: gains,
        backgroundColor: barColors,
        borderColor: barColors.map(c => c.replace("0.75", "1")),
        borderWidth: 1
      }]
    },
    options: {
      scales: {
        x: { ticks: { color: "#e8eefc" } },
        y: { ticks: { color: "#e8eefc" } }
      },
      plugins: { legend: { labels: { color: "#e8eefc" } } }
    }
  });
}

function makeTimelineChart(portfolioAllRows, priceMap, selectedMonth) {
  const monthAgg = new Map();

  for (const p of portfolioAllRows) {
    const m = String(p.month || "").trim();
    if (!m) continue;
    const t = String(p.ticker || "").trim().toUpperCase();
    if (!t) continue;
    const price = priceMap[t];
    if (typeof price !== "number" || Number.isNaN(price)) continue;
    const shares   = Number(p.shares);
    const invested = Number(p.total_cost);
    if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(invested)) continue;

    if (!monthAgg.has(m)) monthAgg.set(m, { invested: 0, value: 0 });
    const agg = monthAgg.get(m);
    agg.invested += invested;
    agg.value    += shares * price;
  }

  let months = [...monthAgg.keys()].sort();
  if (selectedMonth && selectedMonth !== "ALL") {
    months = months.filter(m => m <= selectedMonth);
  }

  const investedSeries = months.map(m => monthAgg.get(m).invested);
  const valueSeries    = months.map(m => monthAgg.get(m).value);
  const gainPctSeries  = months.map((_m, i) => {
    const inv = investedSeries[i];
    const val = valueSeries[i];
    return inv === 0 ? 0 : ((val - inv) / inv) * 100;
  });

  const labels        = months.map(monthLabel);
  const selectedIndex = months.length ? months.length - 1 : -1;
  const pointRadius   = months.map((_m, i) => i === selectedIndex ? 5 : 2);

  if (timelineChart) timelineChart.destroy();
  const ctx = document.getElementById("chartTimeline");
  if (!ctx) return;

  timelineChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Value",    data: valueSeries,    tension: 0.25, pointRadius,  yAxisID: "y" },
        { label: "Invested", data: investedSeries, tension: 0.25, pointRadius: 0, borderDash: [6, 4], yAxisID: "y" },
        { label: "Gain %",   data: gainPctSeries,  tension: 0.25, pointRadius,  yAxisID: "y1" }
      ]
    },
    options: {
      plugins: {
        legend: { labels: { color: "#e8eefc" } },
        tooltip: {
          callbacks: {
            label: (c) => {
              const i   = c.dataIndex;
              const inv = investedSeries[i];
              const val = valueSeries[i];
              const gain = val - inv;
              const gp   = inv === 0 ? 0 : (gain / inv) * 100;
              if (c.dataset.label === "Gain %")    return ` Gain %: ${gp.toFixed(2)}%`;
              if (c.dataset.label === "Invested")  return ` Invested: ${money(inv)}`;
              return ` Value: ${money(val)} (Gain: ${money(gain)})`;
            }
          }
        },
        vLinePlugin: { selectedIndex }
      },
      scales: {
        x:  { ticks: { color: "#e8eefc" }, grid: { color: "rgba(255,255,255,.06)" } },
        y:  { ticks: { color: "#e8eefc", callback: v => money(v) }, grid: { color: "rgba(255,255,255,.06)" } },
        y1: { position: "right", ticks: { color: "#e8eefc", callback: v => `${v}%` }, grid: { drawOnChartArea: false } }
      }
    },
    plugins: [vLinePlugin]
  });
}

// ---------- IRR ----------
function xnpv(rate, cashflows) {
  const t0 = cashflows[0].date;
  return cashflows.reduce((sum, cf) => {
    const days = (cf.date - t0) / (1000 * 60 * 60 * 24);
    return sum + cf.amount / Math.pow(1 + rate, days / 365);
  }, 0);
}

function xirr(cashflows) {
  const hasNeg = cashflows.some(c => c.amount < 0);
  const hasPos = cashflows.some(c => c.amount > 0);
  if (!hasNeg || !hasPos) return null;

  cashflows = [...cashflows].sort((a, b) => a.date - b.date);
  let low = -0.9999, high = 10;
  let fLow = xnpv(low, cashflows);
  let fHigh = xnpv(high, cashflows);

  if (fLow * fHigh > 0) return null;

  for (let i = 0; i < 100; i++) {
    const mid  = (low + high) / 2;
    const fMid = xnpv(mid, cashflows);
    if (Math.abs(fMid) < 1e-8) return mid;
    if (fLow * fMid < 0) { high = mid; fHigh = fMid; }
    else                  { low  = mid; fLow  = fMid; }
  }
  return (low + high) / 2;
}

function calcPortfolioIRR(buyRows, sellRows, priced, asOfStr) {
  // Build per-month net cashflows: buys are outflows (-), sell proceeds are inflows (+)
  const byMonth = new Map();

  for (const p of buyRows) {
    const m    = String(p.month || "").trim();
    if (!m) continue;
    const cost = Number(p.total_cost);
    if (!Number.isFinite(cost) || cost <= 0) continue;
    if (!byMonth.has(m)) byMonth.set(m, { out: 0, in: 0 });
    byMonth.get(m).out += cost;
  }

  for (const p of sellRows) {
    const m        = String(p.month || "").trim();
    if (!m) continue;
    const proceeds = Number(p.total_cost);
    if (!Number.isFinite(proceeds) || proceeds <= 0) continue;
    if (!byMonth.has(m)) byMonth.set(m, { out: 0, in: 0 });
    byMonth.get(m).in += proceeds;
  }

  const months = [...byMonth.keys()].sort();
  if (!months.length) return null;

  const cashflows = [];
  for (const m of months) {
    const [y, mo] = m.split("-");
    const date = new Date(Number(y), Number(mo) - 1, 1);
    const { out, in: inflow } = byMonth.get(m);
    if (out > 0)    cashflows.push({ date, amount: -out });
    if (inflow > 0) cashflows.push({ date, amount: inflow });
  }

  const asOf       = asOfStr ? new Date(asOfStr) : new Date();
  const totalValue = priced.reduce((s, r) => s + r.value, 0);
  if (!Number.isFinite(totalValue) || totalValue <= 0) return null;

  cashflows.push({ date: asOf, amount: totalValue });
  return xirr(cashflows);
}

// ---------- Render (called each time filter changes) ----------
function render(portfolio, priceMap, asOf, selectedMonth, activeAccount) {
  const portfolioForAccount = filterByAccount(portfolio, activeAccount);

  // Timeline only uses buy rows so "invested" stays clean
  makeTimelineChart(portfolioForAccount.filter(p => (p.type || "buy") === "buy"), priceMap, selectedMonth);

  const portfolioFiltered = selectedMonth === "ALL"
    ? portfolioForAccount
    : portfolioForAccount.filter(r => String(r.month || "").trim() <= selectedMonth);

  // Remove stale missing pill
  const meta       = document.querySelector(".meta");
  const oldMissing = meta?.querySelector(".pill.missingPill");
  if (oldMissing) oldMissing.remove();

  // ── Aggregate buys and sells per ticker ──────────────────────────────────
  const byTicker = new Map();

  for (const p of portfolioFiltered) {
    const t    = String(p.ticker || "").trim().toUpperCase();
    if (!t) continue;
    const type = (p.type || "buy").toLowerCase();

    if (!byTicker.has(t)) {
      byTicker.set(t, { ticker: t, buyShares: 0, buyInvested: 0, sellShares: 0, sellCostBasis: 0, realizedGain: 0 });
    }
    const agg = byTicker.get(t);

    const shares = Number(p.shares);
    const cost   = Number(p.total_cost);

    if (type === "buy") {
      if (Number.isFinite(shares) && shares > 0 && Number.isFinite(cost)) {
        agg.buyShares   += shares;
        agg.buyInvested += cost;
      }
    } else if (type === "sell") {
      const rg        = Number(p.realized_gain) || 0;
      const costBasis = cost - rg; // proceeds - realized_gain = what those shares cost
      if (Number.isFinite(shares) && shares > 0) {
        agg.sellShares    += shares;
        agg.sellCostBasis += costBasis;
        agg.realizedGain  += rg;
      }
    }
    // dividend rows are tallied separately below
  }

  // ── Build priced rows for current holdings ───────────────────────────────
  const priced  = [];
  const missing = [];

  for (const [t, agg] of byTicker) {
    const netShares = agg.buyShares - agg.sellShares;
    if (netShares < 1e-9) continue; // fully sold

    const price = priceMap[t];
    if (typeof price !== "number" || Number.isNaN(price)) { missing.push(t); continue; }

    const invested = agg.buyInvested - agg.sellCostBasis;
    const value    = netShares * price;
    const gain     = value - invested;
    const gainPct  = invested === 0 ? 0 : gain / invested;
    const avg_cost = netShares === 0 ? 0 : invested / netShares;

    priced.push({ ticker: t, shares: netShares, avg_cost, price, invested, value, gain, gainPct, realizedGain: agg.realizedGain });
  }

  // ── Realized gains & dividends totals ────────────────────────────────────
  const totalRealizedGain = portfolioFiltered
    .filter(p => (p.type || "buy") === "sell")
    .reduce((s, p) => s + (Number(p.realized_gain) || 0), 0);

  const divRows = portfolioFiltered.filter(p => (p.type || "buy") === "dividend");
  const totalDividends = divRows.reduce((s, p) => s + (Number(p.total_cost) || 0), 0);

  // Build per-ticker dividend breakdown for the modal
  const divByTicker = new Map();
  for (const p of divRows) {
    const t = String(p.ticker || "").trim().toUpperCase();
    if (!t) continue;
    if (!divByTicker.has(t)) divByTicker.set(t, { ticker: t, count: 0, total: 0 });
    const d = divByTicker.get(t);
    d.count++;
    d.total += Number(p.total_cost) || 0;
  }
  _divBreakdown = [...divByTicker.values()].sort((a, b) => b.total - a.total);

  // ── KPI cards ─────────────────────────────────────────────────────────────
  const totalInvested = priced.reduce((s, r) => s + r.invested, 0);
  const totalValue    = priced.reduce((s, r) => s + r.value, 0);
  const totalGain     = totalValue - totalInvested;
  const totalGainPct  = totalInvested === 0 ? 0 : totalGain / totalInvested;

  const winner = [...priced].sort((a, b) => b.gainPct - a.gainPct)[0];
  const loser  = [...priced].sort((a, b) => a.gainPct - b.gainPct)[0];

  document.getElementById("kpiInvested").textContent  = money(totalInvested);
  document.getElementById("kpiValue").textContent     = money(totalValue);
  document.getElementById("kpiGain").textContent      = money(totalGain);
  document.getElementById("kpiGainPct").textContent   = pct(totalGainPct);
  document.getElementById("kpiWinner").textContent    = winner ? winner.ticker : "—";
  document.getElementById("kpiWinnerPct").textContent = winner ? pct(winner.gainPct) : "—";
  document.getElementById("kpiLoser").textContent     = loser ? loser.ticker : "—";
  document.getElementById("kpiLoserPct").textContent  = loser ? pct(loser.gainPct) : "—";

  const uniqueTickers = new Set(priced.map(r => r.ticker));
  document.getElementById("kpiCount").textContent = String(uniqueTickers.size);

  const irr = calcPortfolioIRR(
    portfolioFiltered.filter(p => (p.type || "buy") === "buy"),
    portfolioFiltered.filter(p => (p.type || "buy") === "sell"),
    priced,
    asOf
  );
  document.getElementById("kpiIRR").textContent = irr == null ? "—" : `${(irr * 100).toFixed(2)}%`;

  const rgEl = document.getElementById("kpiRealizedGain");
  if (rgEl) {
    rgEl.textContent = money(totalRealizedGain);
    rgEl.className   = "kpiValue " + (totalRealizedGain >= 0 ? "pos" : "neg");
  }
  const divEl = document.getElementById("kpiDividends");
  if (divEl) divEl.textContent = money(totalDividends);

  currentTableRows = priced;
  initMainTableSorting();

  updateSortIndicators(document.getElementById("holdingsTable"), sortState.key, sortState.dir);
  buildTable(getFilteredSortedRows());
  makeCharts(getFilteredSortedRows());

  if (missing.length) {
    const pill = document.createElement("span");
    pill.className = "pill missingPill";
    pill.textContent = `⚠ Missing: ${missing.length}`;
    meta?.appendChild(pill);
    console.warn("Missing/invalid rows:", missing);
  }
}

// ---------- Main ----------
async function main() {
  try {
    if (!_portfolio)  _portfolio  = await loadCSV("portfolio.csv");
    if (!_pricesFile) _pricesFile = await loadJSON("prices.json");
  } catch (err) {
    showError("Failed to load data. Check that portfolio.csv and prices.json are present.");
    console.error(err);
    return;
  }

  const priceMap = _pricesFile.prices || {};
  const asOf     = _pricesFile.asOf   || "";

  document.getElementById("asOf").textContent = `As of: ${asOf || "—"}`;

  // Populate month dropdown once
  const sel    = document.getElementById("monthSelect");
  const months = [...new Set(
    _portfolio.map(r => String(r.month || "").trim()).filter(Boolean)
  )].sort();

  if (sel && !sel.dataset.populated) {
    sel.innerHTML = `<option value="ALL">All</option>`;
    for (const m of months) {
      const opt = document.createElement("option");
      opt.value       = m;
      opt.textContent = monthLabel(m);
      sel.appendChild(opt);
    }
    sel.dataset.populated = "1";
  }

  initAccountTabs(account => {
    if (sel) sel.addEventListener("change", () => render(_portfolio, priceMap, asOf, sel.value, account));
    render(_portfolio, priceMap, asOf, sel ? sel.value : "ALL", account);
  });

  // ── Dividend modal ────────────────────────────────────────────────────────
  const divModal = document.getElementById("divModal");
  const divCard  = document.getElementById("divCard");

  function openDivModal() {
    const tbody = document.querySelector("#divTable tbody");
    tbody.innerHTML = "";
    if (!_divBreakdown.length) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--muted)">No dividends yet</td></tr>`;
    } else {
      for (const d of _divBreakdown) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${d.ticker}</td><td style="text-align:right">${d.count}</td><td style="text-align:right">${money(d.total)}</td>`;
        tbody.appendChild(tr);
      }
    }
    divModal.style.display = "flex";
  }

  divCard?.addEventListener("click", openDivModal);
  document.getElementById("divModalClose")?.addEventListener("click", () => divModal.style.display = "none");
  divModal?.addEventListener("click", e => { if (e.target === divModal) divModal.style.display = "none"; });
}

main().catch(err => { console.error(err); showError("Dashboard error. Check console."); });
