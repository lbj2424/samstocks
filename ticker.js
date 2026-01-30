function money(n){ return n.toLocaleString(undefined,{style:"currency",currency:"USD"}); }
function pct(n){ return (n*100).toFixed(2) + "%"; }

// ---------- CSV parsing ----------
function parseCSVLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur); cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map(v => v.trim());
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
  return String(k || "").trim().toLowerCase().replace(/\s+/g, "_");
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

// ---------- state ----------
let ALL_ROWS = [];
let PRICE_MAP = {};
let SORT_KEY = "month";
let SORT_DIR = "desc"; // "asc" | "desc"
let CURRENT_TICKER = "";

// ---------- helpers ----------
function compare(a, b, key, dir){
  const av = a[key];
  const bv = b[key];

  // numbers
  if (typeof av === "number" && typeof bv === "number") {
    const x = (Number.isFinite(av) ? av : -Infinity);
    const y = (Number.isFinite(bv) ? bv : -Infinity);
    return dir === "asc" ? x - y : y - x;
  }

  // strings (month, ticker)
  const as = String(av ?? "");
  const bs = String(bv ?? "");
  return dir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
}

function buildTxRowsForTicker(tickerRaw){
  const t = String(tickerRaw || "").trim().toUpperCase();
  if (!t) return [];

  const price = PRICE_MAP[t];

  const rows = ALL_ROWS
    .filter(r => String(r.ticker || "").trim().toUpperCase() === t)
    .map(r => {
      const shares = Number(r.shares);
      const invested = Number(r.total_cost);

      const avg_cost = (Number.isFinite(shares) && shares !== 0) ? invested / shares : NaN;
      const value = (typeof price === "number" && Number.isFinite(shares)) ? shares * price : NaN;
      const gain = (Number.isFinite(value) && Number.isFinite(invested)) ? value - invested : NaN;
      const gainPct = (Number.isFinite(invested) && invested !== 0 && Number.isFinite(gain)) ? gain / invested : NaN;

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

  return rows;
}

function renderTable(rows){
  const tbody = document.querySelector("#txTable tbody");
  tbody.innerHTML = "";

  for (const r of rows){
    const tr = document.createElement("tr");
    const cls = (r.gainPct ?? 0) >= 0 ? "pos" : "neg";

    tr.innerHTML = `
      <td>${r.month || "—"}</td>
      <td>${r.ticker}</td>
      <td>${Number.isFinite(r.shares) ? r.shares.toFixed(6) : "—"}</td>
      <td>${Number.isFinite(r.avg_cost) ? money(r.avg_cost) : "—"}</td>
      <td>${Number.isFinite(r.price) ? money(r.price) : "—"}</td>
      <td>${Number.isFinite(r.invested) ? money(r.invested) : "—"}</td>
      <td>${Number.isFinite(r.value) ? money(r.value) : "—"}</td>
      <td class="${cls}">${Number.isFinite(r.gain) ? money(r.gain) : "—"}</td>
      <td class="${cls}">${Number.isFinite(r.gainPct) ? pct(r.gainPct) : "—"}</td>
    `;
    tbody.appendChild(tr);
  }
}

function updateUIForTicker(tickerRaw){
  const t = String(tickerRaw || "").trim().toUpperCase();
  CURRENT_TICKER = t;

  const price = PRICE_MAP[t];
  document.getElementById("tickerPricePill").textContent =
    `Price: ${typeof price === "number" ? money(price) : "—"}`;

  const txRows = buildTxRowsForTicker(t);

  // default sort: newest month first, otherwise keep whatever user last clicked
  const sorted = [...txRows].sort((a,b) => compare(a,b,SORT_KEY,SORT_DIR));

  document.getElementById("rowCountPill").textContent = `Rows: ${sorted.length}`;
  document.getElementById("tableTitle").textContent = t ? `Transactions – ${t}` : "Transactions";

  renderTable(sorted);
}

// ---------- main ----------
async function main(){
  ALL_ROWS = await loadCSV("portfolio.csv");
  const pricesFile = await loadJSON("prices.json");
  PRICE_MAP = pricesFile.prices || {};

  document.getElementById("asOf").textContent = `As of: ${pricesFile.asOf || "—"}`;

  // build ticker list
  const tickers = [...new Set(ALL_ROWS.map(r => String(r.ticker || "").trim().toUpperCase()).filter(Boolean))].sort();
  const dl = document.getElementById("tickerList");
  dl.innerHTML = "";
  for (const t of tickers){
    const opt = document.createElement("option");
    opt.value = t;
    dl.appendChild(opt);
  }

  // wire input
  const input = document.getElementById("tickerInput");
  if (!input.dataset.wired){
    input.dataset.wired = "1";

    // choose a default ticker (first one) if blank
    if (!input.value && tickers.length) input.value = tickers[0];

    input.addEventListener("input", () => updateUIForTicker(input.value));
    input.addEventListener("change", () => updateUIForTicker(input.value));
  }

  // wire sorting headers
  const headers = document.querySelectorAll("#txTable thead th.sortable");
  headers.forEach(th => {
    if (th.dataset.wired) return;
    th.dataset.wired = "1";

    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (!key) return;

      if (SORT_KEY === key) {
        SORT_DIR = (SORT_DIR === "asc") ? "desc" : "asc";
      } else {
        SORT_KEY = key;
        SORT_DIR = (key === "month") ? "desc" : "desc"; // good default
      }

      updateUIForTicker(document.getElementById("tickerInput").value);
    });
  });

  updateUIForTicker(document.getElementById("tickerInput").value);
}

main().catch(err => {
  console.error(err);
  alert("Ticker page error. Check console.");
});
