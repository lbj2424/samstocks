// ---- Formatting ----
function money(n) {
  return Number(n).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function pct(n) {
  return (n * 100).toFixed(2) + "%";
}

// ---- CSV parsing ----
function parseCSVLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === "," && !inQuotes) {
      out.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(v => v.trim());
}

function toNumber(v) {
  if (v == null) return NaN;
  const s = String(v).trim();
  if (!s) return NaN;
  const neg = s.startsWith("(") && s.endsWith(")");
  const cleaned = s.replace(/[,$%()]/g, "").replace(/\s+/g, "");
  const n = Number(cleaned);
  return neg ? -n : n;
}

function normKey(k) {
  return String(k || "").trim().toLowerCase().replace(/\s+/g, "_");
}

async function loadCSV(path) {
  const txt = await fetch(path, { cache: "no-store" }).then(r => r.text());
  const clean = txt.replace(/^\uFEFF/, "");
  const [headerLine, ...lines] = clean.trim().split(/\r?\n/);
  const headers = parseCSVLine(headerLine).map(normKey);

  return lines
    .filter(l => l.trim().length)
    .map(line => {
      const parts = parseCSVLine(line);
      const row = {};
      headers.forEach((h, i) => row[h] = parts[i]);
      const type = String(row.type || "buy").trim().toLowerCase() || "buy";
      return {
        ticker:        String(row.ticker || "").trim(),
        shares:        toNumber(row.shares),
        total_cost:    toNumber(row.total_cost),
        month:         String(row.month || "").trim(),
        type,
        realized_gain: toNumber(row.realized_gain)
      };
    });
}

async function loadJSON(path) {
  return fetch(path, { cache: "no-store" }).then(r => r.json());
}

function monthLabel(m) {
  const s = String(m || "").trim();
  const [y, mo] = s.split("-");
  const n = Number(mo);
  const names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  if (!y || !n || n < 1 || n > 12) return s;
  return `${names[n-1]} ${y}`;
}

function sortRows(rows, key, dir) {
  const mult = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
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

// ---- Sort indicator ----
function updateSortIndicators(tableEl, key, dir) {
  if (!tableEl) return;
  tableEl.querySelectorAll("thead th[data-sort], thead th[data-key]").forEach(th => {
    const k = th.dataset.sort || th.dataset.key;
    th.classList.remove("sorted-asc", "sorted-desc");
    if (k === key) th.classList.add(dir === "asc" ? "sorted-asc" : "sorted-desc");
  });
}

// ---- Error banner ----
function showError(msg) {
  let banner = document.getElementById("errorBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "errorBanner";
    banner.className = "errorBanner";
    const main = document.querySelector("main");
    if (main) document.body.insertBefore(banner, main);
    else document.body.appendChild(banner);
  }
  banner.textContent = "⚠ " + msg;
  banner.style.display = "block";
}

// ---- Schwab holdings import ----
// Reads one or more Schwab "Positions" CSVs and extracts
// shares + cost basis per ticker. Prices are intentionally
// ignored — prices.json (updated by the GitHub Action) is
// the source of truth for prices.

// Detect account type from the first line of a Schwab CSV
function detectSchwabAccountType(firstLine) {
  const l = firstLine.toLowerCase();
  if (l.includes("roth")) return "roth";
  return "individual";
}

function parseSchwabHoldings(text) {
  const rawLines = text.split("\n");

  const accountType = detectSchwabAccountType(rawLines[0] || "");

  // Find the column-header row (contains "Symbol")
  let colIdx = -1;
  for (let i = 0; i < rawLines.length; i++) {
    if (rawLines[i].includes('"Symbol"')) { colIdx = i; break; }
  }
  if (colIdx === -1) return { accountType, holdings: {} };

  const cols    = parseCSVLine(rawLines[colIdx]);
  const symCol  = cols.findIndex(h => h === "Symbol");
  const qtyCol  = cols.findIndex(h => h === "Qty (Quantity)");
  const costCol = cols.findIndex(h => h === "Cost Basis");

  if (symCol === -1 || qtyCol === -1) return { accountType, holdings: {} };

  const holdings = {};
  for (let i = colIdx + 1; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (!line) continue;
    const vals   = parseCSVLine(line);
    const symbol = (vals[symCol] || "").trim();
    if (!symbol || symbol === "Cash & Cash Investments" || symbol === "Positions Total") continue;

    const shares    = toNumber(vals[qtyCol]);
    const costBasis = costCol !== -1 ? toNumber(vals[costCol]) : NaN;

    if (!Number.isFinite(shares) || shares <= 0) continue;
    if (!holdings[symbol]) holdings[symbol] = { shares: 0, costBasis: 0 };
    holdings[symbol].shares    += shares;
    if (Number.isFinite(costBasis)) holdings[symbol].costBasis += costBasis;
  }

  return { accountType, holdings };
}

// Reads FileList, stores each account separately, saves to localStorage
async function importSchwabHoldings(files, onSuccess) {
  const byAccount = { individual: {}, roth: {} };

  for (const file of Array.from(files)) {
    const text   = await file.text();
    const result = parseSchwabHoldings(text);
    const target = byAccount[result.accountType];
    for (const [symbol, h] of Object.entries(result.holdings)) {
      if (!target[symbol]) target[symbol] = { shares: 0, costBasis: 0 };
      target[symbol].shares    += h.shares;
      target[symbol].costBasis += h.costBasis;
    }
  }

  const hasIndividual = Object.keys(byAccount.individual).length > 0;
  const hasRoth       = Object.keys(byAccount.roth).length > 0;

  if (!hasIndividual && !hasRoth) {
    showError("No valid holdings found. Make sure you're uploading Schwab Positions CSVs.");
    return;
  }

  if (hasIndividual) localStorage.setItem("schwab_holdings_individual", JSON.stringify(byAccount.individual));
  if (hasRoth)       localStorage.setItem("schwab_holdings_roth",       JSON.stringify(byAccount.roth));

  if (typeof onSuccess === "function") onSuccess(byAccount);
}

// Returns holdings for the given account view: "all", "individual", or "roth"
function getSchwabHoldings(account) {
  const rawInd  = localStorage.getItem("schwab_holdings_individual");
  const rawRoth = localStorage.getItem("schwab_holdings_roth");

  let individual = {};
  let roth       = {};
  try { if (rawInd)  individual = JSON.parse(rawInd);  } catch {}
  try { if (rawRoth) roth       = JSON.parse(rawRoth); } catch {}

  if (account === "individual") return Object.keys(individual).length ? individual : null;
  if (account === "roth")       return Object.keys(roth).length       ? roth       : null;

  // "all" — merge both
  const merged = {};
  for (const [s, h] of Object.entries(individual)) {
    if (!merged[s]) merged[s] = { shares: 0, costBasis: 0 };
    merged[s].shares    += h.shares;
    merged[s].costBasis += h.costBasis;
  }
  for (const [s, h] of Object.entries(roth)) {
    if (!merged[s]) merged[s] = { shares: 0, costBasis: 0 };
    merged[s].shares    += h.shares;
    merged[s].costBasis += h.costBasis;
  }
  return Object.keys(merged).length ? merged : null;
}

function clearSchwabHoldings() {
  localStorage.removeItem("schwab_holdings_individual");
  localStorage.removeItem("schwab_holdings_roth");
  // also clear old combined key if present from previous version
  localStorage.removeItem("schwab_holdings");
}

function hasSchwabHoldings() {
  return !!(localStorage.getItem("schwab_holdings_individual") ||
            localStorage.getItem("schwab_holdings_roth") ||
            localStorage.getItem("schwab_holdings"));
}
