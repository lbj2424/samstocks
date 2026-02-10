function money(n){ return n.toLocaleString(undefined,{style:"currency",currency:"USD"}); }
function pct(n){ return (n*100).toFixed(2) + "%"; }

// ---------- Chart instances (so we can update them) ----------
let allocChart = null;
let gainsChart = null;
let timelineChart = null;
let sortState = { key: "value", dir: "desc" };
let heatmapChart = null;
let currentTableRows = [];

// ---------- CSV + parsing helpers (robust) ----------
function parseCSVLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }

  out.push(cur);
  return out.map(v => v.trim());
}

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

function toNumber(v){
  if (v == null) return NaN;
  const s = String(v).trim();
  if (!s) return NaN;

  const neg = s.startsWith("(") && s.endsWith(")");
  const cleaned = s.replace(/[,$%()]/g, "").replace(/\s+/g, "");
  const n = Number(cleaned);
  return neg ? -n : n;
}

function normKey(k){
  return String(k || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

async function loadCSV(path){
  const txt = await fetch(path, { cache: "no-store" }).then(r => r.text());
  const clean = txt.replace(/^\uFEFF/, ""); 

  const [headerLine, ...lines] = clean.trim().split(/\r?\n/);
  const headers = parseCSVLine(headerLine).map(normKey);

  return lines
    .filter(l => l.trim().length)
    .map(line => {
      const parts = parseCSVLine(line);
      const row = {};
      headers.forEach((h,i) => row[h] = parts[i]);

      return {
        ticker: String(row.ticker || "").trim(),
        shares: toNumber(row.shares),
        total_cost: toNumber(row.total_cost),
        month: String(row.month || "").trim()
      };
    });
}

async function loadJSON(path){
  return fetch(path, { cache: "no-store" }).then(r => r.json());
}

function buildTable(rows){
  const tbody = document.querySelector("#holdingsTable tbody");
  tbody.innerHTML = "";

  for(const r of rows){
    const tr = document.createElement("tr");
    const cls = r.gainPct >= 0 ? "pos" : "neg";

    tr.innerHTML = `
      <td>${r.ticker}</td>
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
}

function sortRows(rows, key, dir){
  const mult = dir === "asc" ? 1 : -1;

  return [...rows].sort((a,b) => {
    const av = a[key];
    const bv = b[key];

    if (typeof av === "string" || typeof bv === "string") {
      return String(av).localeCompare(String(bv)) * mult;
    }

    const an = Number(av);
    const bn = Number(bv);
    if (Number.isNaN(an) && Number.isNaN(bn)) return 0;
    if (Number.isNaN(an)) return 1;
    if (Number.isNaN(bn)) return -1;
    return (an - bn) * mult;
  });
}

function initMainTableSorting(getCurrentRows){
  const table = document.getElementById("holdingsTable");
  if (!table || table.dataset.sortInit) return;

  const headers = table.querySelectorAll("thead th[data-sort]");
  headers.forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (sortState.key === key) {
        sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      } else {
        sortState.key = key;
        sortState.dir = "desc";
      }

      const rows = getCurrentRows();
      const sorted = sortRows(rows, sortState.key, sortState.dir);
      buildTable(sorted);
    });
  });
  table.dataset.sortInit = "1";
}

function makeCharts(rows){
  // 1. Aggregate by ticker
  const byTicker = new Map();
  
  for (const r of rows) {
    const key = r.ticker;
    if (!byTicker.has(key)) {
      byTicker.set(key, { ticker: key, value: 0, invested: 0 });
    }
    const agg = byTicker.get(key);
    
    const val = Number(r.value) || 0;
    const inv = Number(r.invested) || 0;
    
    agg.value += val;
    agg.invested += inv;
  }

  // 2. Convert to array
  const aggRows = [...byTicker.values()]
    .map(r => {
      let gainPct = 0;
      if (r.invested > 0) {
        gainPct = (r.value - r.invested) / r.invested;
      }
      return { ...r, gainPct };
    })
    .sort((a,b) => b.value - a.value);

  // -------------------- Alloc & Gains Charts --------------------
  
  const labels = aggRows.map(r => r.ticker);
  const values = aggRows.map(r => r.value);
  const gains  = aggRows.map(r => r.gainPct * 100);

  if (allocChart) allocChart.destroy();
  if (gainsChart) gainsChart.destroy();

  const ctxA = document.getElementById("chartAlloc");
  allocChart = new Chart(ctxA, {
    type: "doughnut",
    data: { labels, datasets: [{ data: values }] },
    options: { plugins: { legend: { position: "bottom", labels: { color: "#e8eefc" } } } }
  });

  const ctxG = document.getElementById("chartGains");
  gainsChart = new Chart(ctxG, {
    type: "bar",
    data: { labels, datasets: [{ label: "Gain %", data: gains }] },
    options: {
      scales: {
        x: { ticks: { color: "#e8eefc" } },
        y: { ticks: { color: "#e8eefc" } }
      },
      plugins: { legend: { labels: { color: "#e8eefc" } } }
    }
  });

  // -------------------- HEATMAP CHART (FIXED) --------------------

  if (heatmapChart) heatmapChart.destroy();

  const ctxH = document.getElementById("chartHeatmap");
  if (ctxH) {
    heatmapChart = new Chart(ctxH, {
      type: 'treemap',
      data: {
        datasets: [{
          tree: aggRows,
          key: 'value',
          groups: ['ticker'],
          spacing: 1,
          borderWidth: 0,
          
          labels: {
            display: true,
            color: "white",
            font: { weight: 'bold' },
            formatter: (ctx) => {
              if (ctx.type !== 'data') return;
              const d = ctx.raw._data; 
              if (!d) return "";
              
              const gp = Number.isFinite(d.gainPct) ? (d.gainPct * 100).toFixed(1) + "%" : "0.0%";
              return [d.ticker, gp];
            }
          },
          
          backgroundColor: (ctx) => {
            if (ctx.type !== 'data') return 'transparent';
            
            const d = ctx.raw._data;
            if (!d) return '#333'; 

            const gp = d.gainPct;
            if (!Number.isFinite(gp)) return '#333';

            // Green for positive, Red for negative
            if (gp >= 0) {
              const alpha = 0.4 + Math.min(gp * 2, 0.5); 
              return `rgba(16, 185, 129, ${alpha})`; 
            } else {
              const alpha = 0.4 + Math.min(Math.abs(gp) * 2, 0.5);
              return `rgba(239, 68, 68, ${alpha})`; 
            }
          }
        }]
      },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => {
                const d = items[0].raw._data;
                return d ? d.ticker : "Unknown";
              },
              label: (item) => {
                const d = item.raw._data;
                if (!d) return "";
                const gpText = Number.isFinite(d.gainPct) ? pct(d.gainPct) : "—";
                return `Value: ${money(d.value)} | Gain: ${gpText}`;
              }
            }
          }
        }
      }
    });
  }
}

function monthLabel(m){
  const s = String(m || "").trim();
  const [y, mo] = s.split("-");
  const n = Number(mo);
  const names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  if (!y || !n || n < 1 || n > 12) return s;
  return `${names[n-1]} ${y}`;
}

const vLinePlugin = {
  id: "vLinePlugin",
  afterDatasetsDraw(chart, args, opts) {
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
    ctx.setLineDash([4,4]);
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  }
};

function makeTimelineChart(portfolioAllRows, priceMap, selectedMonth){
  const monthAgg = new Map(); 

  for (const p of portfolioAllRows) {
    const m = String(p.month || "").trim();
    if (!m) continue;

    const t = String(p.ticker || "").trim().toUpperCase();
    if (!t) continue;

    const price = priceMap[t];
    if (typeof price !== "number" || Number.isNaN(price)) continue;

    const shares = Number(p.shares);
    const invested = Number(p.total_cost);
    if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(invested)) continue;

    const value = shares * price;

    if (!monthAgg.has(m)) monthAgg.set(m, { invested: 0, value: 0 });
    const agg = monthAgg.get(m);
    agg.invested += invested;
    agg.value += value;
  }

  let months = [...monthAgg.keys()].sort();

  if (selectedMonth && selectedMonth !== "ALL") {
    months = months.filter(m => m <= selectedMonth);
  }

  const investedSeries = months.map(m => monthAgg.get(m).invested);
  const valueSeries    = months.map(m => monthAgg.get(m).value);
  const gainPctSeries  = months.map((m, i) => {
    const inv = investedSeries[i];
    const val = valueSeries[i];
    return inv === 0 ? 0 : ((val - inv) / inv) * 100;
  });

  const labels = months.map(monthLabel);
  const selectedIndex = months.length ? months.length - 1 : -1;
  const pointRadius = months.map((m, i) => (i === selectedIndex ? 5 : 2));

  if (timelineChart) timelineChart.destroy();

  const ctx = document.getElementById("chartTimeline");
  if (!ctx) return;

  timelineChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Value", data: valueSeries, tension: 0.25, pointRadius, yAxisID: "y" },
        { label: "Invested", data: investedSeries, tension: 0.25, pointRadius: 0, borderDash: [6,4], yAxisID: "y" },
        { label: "Gain %", data: gainPctSeries, tension: 0.25, pointRadius, yAxisID: "y1" }
      ]
    },
    options: {
      plugins: {
        legend: { labels: { color: "#e8eefc" } },
        tooltip: {
          callbacks: {
            label: (c) => {
              const i = c.dataIndex;
              const inv = investedSeries[i];
              const val = valueSeries[i];
              const gain = val - inv;
              const gp = inv === 0 ? 0 : (gain / inv) * 100;

              if (c.dataset.label === "Gain %") return ` Gain %: ${gp.toFixed(2)}%`;
              if (c.dataset.label === "Invested") return ` Invested: ${money(inv)}`;
              return ` Value: ${money(val)} (Gain: ${money(gain)})`;
            }
          }
        },
        vLinePlugin: { selectedIndex }
      },
      scales: {
        x: { ticks: { color: "#e8eefc" }, grid: { color: "rgba(255,255,255,.06)" } },
        y: { ticks: { color: "#e8eefc", callback: (v) => money(v) }, grid: { color: "rgba(255,255,255,.06)" } },
        y1:{ position:"right", ticks:{ color:"#e8eefc", callback:(v)=>`${v}%` }, grid:{ drawOnChartArea:false } }
      }
    },
    plugins: [vLinePlugin]
  });
}

function xnpv(rate, cashflows){
  const t0 = cashflows[0].date;
  return cashflows.reduce((sum, cf) => {
    const days = (cf.date - t0) / (1000 * 60 * 60 * 24);
    return sum + cf.amount / Math.pow(1 + rate, days / 365);
  }, 0);
}

function xirr(cashflows){
  const hasNeg = cashflows.some(c => c.amount < 0);
  const hasPos = cashflows.some(c => c.amount > 0);
  if (!hasNeg || !hasPos) return null;

  cashflows = [...cashflows].sort((a,b) => a.date - b.date);

  let low = -0.9999;
  let high = 10;
  let fLow = xnpv(low, cashflows);
  let fHigh = xnpv(high, cashflows);

  if (fLow * fHigh > 0) return null;

  for (let i = 0; i < 100; i++){
    const mid = (low + high) / 2;
    const fMid = xnpv(mid, cashflows);
    if (Math.abs(fMid) < 1e-8) return mid;
    if (fLow * fMid < 0){ high = mid; fHigh = fMid; } else { low = mid; fLow = fMid; }
  }
  return (low + high) / 2;
}

function calcPortfolioIRR(portfolioFiltered, priced, asOfStr){
  const byMonth = new Map();
  for (const p of portfolioFiltered){
    const m = String(p.month || "").trim();
    if (!m) continue;
    const cost = Number(p.total_cost);
    if (!Number.isFinite(cost) || cost <= 0) continue;
    byMonth.set(m, (byMonth.get(m) || 0) + cost);
  }

  const months = [...byMonth.keys()].sort();
  if (!months.length) return null;

  const cashflows = months.map(m => {
    const [y, mo] = m.split("-");
    const d = new Date(Number(y), Number(mo) - 1, 1);
    return { date: d, amount: -byMonth.get(m) };
  });

  const asOf = asOfStr ? new Date(asOfStr) : new Date();
  const totalValue = priced.reduce((s,r) => s + r.value, 0);
  if (!Number.isFinite(totalValue) || totalValue <= 0) return null;

  cashflows.push({ date: asOf, amount: totalValue });
  return xirr(cashflows);
}

// ---------- main ----------
async function main(){
  const portfolio  = await loadCSV("portfolio.csv");
  const pricesFile = await loadJSON("prices.json");
  const priceMap   = pricesFile.prices || {};

  document.getElementById("asOf").textContent = `As of: ${pricesFile.asOf || "—"}`;

  const sel = document.getElementById("monthSelect");
  const months = [...new Set(
    portfolio.map(r => String(r.month || "").trim()).filter(Boolean)
  )].sort();

  if (sel && !sel.dataset.populated) {
    sel.innerHTML = `<option value="ALL">All</option>`;
    for (const m of months) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = monthLabel(m);
      sel.appendChild(opt);
    }
    sel.dataset.populated = "1";
    sel.addEventListener("change", () => main());
  }

  const selectedMonth = sel ? sel.value : "ALL";
  makeTimelineChart(portfolio, priceMap, selectedMonth);

  const portfolioFiltered =
    selectedMonth === "ALL"
      ? portfolio
      : portfolio.filter(r => String(r.month || "").trim() === selectedMonth);

  const meta = document.querySelector(".meta");
  const oldMissing = meta?.querySelector(".pill.missingPill");
  if (oldMissing) oldMissing.remove();

  const priced = [];
  const missing = [];

  for (const p of portfolioFiltered) {
    const t = String(p.ticker || "").trim().toUpperCase();
    if (!t) continue;

    const price = priceMap[t];
    if (typeof price !== "number" || Number.isNaN(price)) {
      missing.push(t);
      continue;
    }

    const shares = Number(p.shares);
    const invested = Number(p.total_cost);

    if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(invested)) {
      missing.push(t);
      continue;
    }

    const avg_cost = invested / shares;
    const value = shares * price;
    const gain = value - invested;
    const gainPct = invested === 0 ? 0 : gain / invested;

    priced.push({ ticker: t, shares, avg_cost, price, invested, value, gain, gainPct });
  }

  const totalInvested = priced.reduce((s,r) => s + r.invested, 0);
  const totalValue    = priced.reduce((s,r) => s + r.value, 0);
  const totalGain     = totalValue - totalInvested;
  const totalGainPct  = totalInvested === 0 ? 0 : totalGain / totalInvested;

  const winner = [...priced].sort((a,b) => b.gainPct - a.gainPct)[0];
  const loser  = [...priced].sort((a,b) => a.gainPct - b.gainPct)[0];

  document.getElementById("kpiInvested").textContent = money(totalInvested);
  document.getElementById("kpiValue").textContent    = money(totalValue);
  document.getElementById("kpiGain").textContent     = money(totalGain);
  document.getElementById("kpiGainPct").textContent  = pct(totalGainPct);

  document.getElementById("kpiWinner").textContent    = winner ? winner.ticker : "—";
  document.getElementById("kpiWinnerPct").textContent = winner ? pct(winner.gainPct) : "—";

  document.getElementById("kpiLoser").textContent    = loser ? loser.ticker : "—";
  document.getElementById("kpiLoserPct").textContent = loser ? pct(loser.gainPct) : "—";

  const uniqueTickers = new Set(priced.map(r => r.ticker));
  document.getElementById("kpiCount").textContent = String(uniqueTickers.size);

  const irr = calcPortfolioIRR(portfolioFiltered, priced, pricesFile.asOf);
  const irrText = irr == null ? "—" : `${(irr * 100).toFixed(2)}%`;
  document.getElementById("kpiIRR").textContent = irrText;

  currentTableRows = priced;
  initMainTableSorting(() => currentTableRows);
  const pricedSorted = sortRows(currentTableRows, sortState.key, sortState.dir);

  buildTable(pricedSorted);
  makeCharts(pricedSorted);

  if (missing.length) {
    const pill = document.createElement("span");
    pill.className = "pill missingPill";
    pill.textContent = `⚠ Missing: ${missing.length}`;
    meta?.appendChild(pill);
    console.warn("Missing/invalid rows:", missing);
  }
}

main().catch(err => {
  console.error(err);
  alert("Dashboard error. Check console.");
});
