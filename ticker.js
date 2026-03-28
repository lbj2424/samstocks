// ---------- State ----------
let ALL_ROWS       = [];
let PRICE_MAP      = {};
let SORT_KEY       = "month";
let SORT_DIR       = "desc";
let CURRENT_TICKER = "";

// ---------- Build rows for a ticker ----------
function buildTxRowsForTicker(tickerRaw) {
  const t     = String(tickerRaw || "").trim().toUpperCase();
  if (!t) return [];

  const price = PRICE_MAP[t];

  return ALL_ROWS
    .filter(r => String(r.ticker || "").trim().toUpperCase() === t)
    .map(r => {
      const shares   = Number(r.shares);
      const invested = Number(r.total_cost);
      const avg_cost = (Number.isFinite(shares) && shares !== 0) ? invested / shares : NaN;
      const value    = (typeof price === "number" && Number.isFinite(shares)) ? shares * price : NaN;
      const gain     = (Number.isFinite(value) && Number.isFinite(invested)) ? value - invested : NaN;
      const gainPct  = (Number.isFinite(invested) && invested !== 0 && Number.isFinite(gain)) ? gain / invested : NaN;

      return {
        month: r.month || "",
        ticker: t,
        shares,
        avg_cost,
        price: typeof price === "number" ? price : NaN,
        invested,
        value,
        gain,
        gainPct
      };
    });
}

// ---------- Render ----------
function renderTable(rows) {
  const tbody = document.querySelector("#txTable tbody");
  tbody.innerHTML = "";

  for (const r of rows) {
    const tr  = document.createElement("tr");
    const cls = (r.gainPct ?? 0) >= 0 ? "pos" : "neg";

    tr.innerHTML = `
      <td>${r.month || "—"}</td>
      <td>${r.ticker}</td>
      <td>${Number.isFinite(r.shares)   ? r.shares.toFixed(6) : "—"}</td>
      <td>${Number.isFinite(r.avg_cost) ? money(r.avg_cost)   : "—"}</td>
      <td>${Number.isFinite(r.price)    ? money(r.price)      : "—"}</td>
      <td>${Number.isFinite(r.invested) ? money(r.invested)   : "—"}</td>
      <td>${Number.isFinite(r.value)    ? money(r.value)      : "—"}</td>
      <td class="${cls}">${Number.isFinite(r.gain)    ? money(r.gain)    : "—"}</td>
      <td class="${cls}">${Number.isFinite(r.gainPct) ? pct(r.gainPct)  : "—"}</td>
    `;
    tbody.appendChild(tr);
  }
}

function updateUIForTicker(tickerRaw) {
  const t        = String(tickerRaw || "").trim().toUpperCase();
  CURRENT_TICKER = t;

  const price = PRICE_MAP[t];
  document.getElementById("tickerPricePill").textContent =
    `Price: ${typeof price === "number" ? money(price) : "—"}`;

  const txRows = buildTxRowsForTicker(t);
  const sorted = sortRows(txRows, SORT_KEY, SORT_DIR);

  document.getElementById("rowCountPill").textContent = `Rows: ${sorted.length}`;
  document.getElementById("tableTitle").textContent   = t ? `Transactions – ${t}` : "Transactions";

  updateSortIndicators(document.getElementById("txTable"), SORT_KEY, SORT_DIR);
  renderTable(sorted);
}

// ---------- Main ----------
async function main() {
  try {
    ALL_ROWS = await loadCSV("portfolio.csv");
    const pricesFile = await loadJSON("prices.json");
    PRICE_MAP = pricesFile.prices || {};
    document.getElementById("asOf").textContent = `As of: ${pricesFile.asOf || "—"}`;
  } catch (err) {
    showError("Failed to load data. Check that portfolio.csv and prices.json are present.");
    console.error(err);
    return;
  }

  // Build ticker datalist
  const tickers = [...new Set(
    ALL_ROWS.map(r => String(r.ticker || "").trim().toUpperCase()).filter(Boolean)
  )].sort();

  const dl = document.getElementById("tickerList");
  dl.innerHTML = "";
  for (const t of tickers) {
    const opt = document.createElement("option");
    opt.value = t;
    dl.appendChild(opt);
  }

  // Wire input (once)
  const input = document.getElementById("tickerInput");
  if (!input.dataset.wired) {
    input.dataset.wired = "1";

    // Pre-select ticker from URL param (?ticker=NVDA) or default to first
    const urlTicker = new URLSearchParams(window.location.search).get("ticker");
    if (urlTicker && tickers.includes(urlTicker.toUpperCase())) {
      input.value = urlTicker.toUpperCase();
    } else if (!input.value && tickers.length) {
      input.value = tickers[0];
    }

    input.addEventListener("input",  () => updateUIForTicker(input.value));
    input.addEventListener("change", () => updateUIForTicker(input.value));
  }

  // Wire sort headers (once)
  document.querySelectorAll("#txTable thead th.sortable").forEach(th => {
    if (th.dataset.wired) return;
    th.dataset.wired = "1";

    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (!key) return;
      if (SORT_KEY === key) {
        SORT_DIR = SORT_DIR === "asc" ? "desc" : "asc";
      } else {
        SORT_KEY = key;
        SORT_DIR = "desc";
      }
      updateUIForTicker(document.getElementById("tickerInput").value);
    });
  });

  updateUIForTicker(input.value);
}

main().catch(err => {
  console.error(err);
  showError("Ticker page error. Check console.");
});
