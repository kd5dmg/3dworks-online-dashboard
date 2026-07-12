let db = null;

const api = {
  loadData: () => fetch('/api/data').then(r => r.json()),
  saveData: (data) => fetch('/api/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }).then(r => r.json()),
  getPrinterStatuses: (printers) => fetch('/api/printer-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(printers)
  }).then(r => r.json()),
  getHaStates: (entityIds, ha) => fetch('/api/ha-states', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entityIds, ha })
  }).then(r => r.json())
};

async function init() {
  db = await api.loadData();

  // Migrate: move wattage/maintenance from settings into a default printer profile
  if (!db.printers) {
    db.printers = [{
      id: 1,
      name: 'Default Printer',
      watts: db.settings.printerWatts || 250,
      maintenancePerHour: db.settings.maintenanceCostPerHour || 0.50
    }];
    delete db.settings.printerWatts;
    delete db.settings.maintenanceCostPerHour;
  }
  if (!db.laborRates) {
    db.laborRates = [
      { id: 1, name: 'Standard', ratePerHour: 15 },
      { id: 2, name: 'Design / CAD', ratePerHour: 25 },
      { id: 3, name: 'Finishing / Painting', ratePerHour: 20 }
    ];
  }
  if (!db.quotes) db.quotes = [];
  if (!db.inventory) db.inventory = [];

  await persist();

  renderPrinterSelect();
  renderPrinterTable();
  renderFilamentSelect();
  renderFilamentTable();
  renderLaborSelect();
  renderLaborTable();
  renderSettings();
  renderHistory();
  renderQuotes();
  renderInventoryTable();
  renderDashboard();
  renderPrinterStatuses();
  setInterval(renderPrinterStatuses, 5000);
  renderHaSensors();
  setInterval(renderHaSensors, 15000);
}

async function persist() {
  await api.saveData(db);
}

// ── Tab navigation ────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'dashboard') renderDashboard();
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt      = n => '$' + Number(n).toFixed(2);
const fmtPrice = n => '$' + Math.round(Number(n));
const fmtN = n => Number(n).toFixed(1) + '%';

function getById(arr, id) { return arr.find(x => x.id === Number(id)); }

// ── Live printer status ───────────────────────────────────────────────────────
function classifyState(s) {
  const t = (s || '').toLowerCase();
  if (t.includes('not configured')) return 'unconfigured';
  if (t.includes('offline') || t.includes('error') || t.includes('fail') || t.startsWith('http')) return 'offline';
  if (t.includes('print') || t === 'running') return 'printing';
  if (t.includes('pause')) return 'paused';
  if (t.includes('finish')) return 'finished';
  return 'idle';
}

function fmtDuration(min) {
  if (min == null) return '—';
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

const PRINTER_LINKS = {
  'Bambu P2S': 'http://192.168.0.149:8000',
  'H2C': 'http://192.168.0.149:8000',
  'Snapmaker U1': 'http://192.168.0.80'
};

async function renderPrinterStatuses() {
  const grid = document.getElementById('printerStatusGrid');
  if (!grid || !db) return;

  if (!db.printers.length) {
    grid.innerHTML = '<div class="result-empty">No printers yet — add one in the Printers tab.</div>';
    return;
  }

  let statuses = {};
  try {
    statuses = await api.getPrinterStatuses(db.printers.map(p => ({
      id: p.id, platform: p.platform, octoprint: p.octoprint, bambu: p.bambu, moonraker: p.moonraker
    })));
  } catch (e) {}

  grid.innerHTML = db.printers.map(p => {
    const s = statuses[p.id] || { state: 'Not configured' };
    const cls = classifyState(s.state);
    const hasProgress = s.progress != null;
    const link = PRINTER_LINKS[p.name];
    return `
      <div class="printer-status-card">
        <div class="ps-name">
          <span>${p.name}</span>
          <span class="ps-badge ${cls}">${s.state || 'Unknown'}</span>
        </div>
        ${link ? `<a class="ps-open-link" href="${link}" target="_blank" rel="noopener noreferrer">Open printer interface ↗</a>` : ''}
        ${hasProgress ? `<div class="ps-progress-track"><div class="ps-progress-fill" style="width:${s.progress}%"></div></div>` : ''}
        <div class="ps-detail"><span>Job</span><span>${s.fileName || '—'}</span></div>
        ${hasProgress ? `<div class="ps-detail"><span>Progress</span><span>${s.progress}%</span></div>` : ''}
        <div class="ps-detail"><span>Time left</span><span>${fmtDuration(s.timeRemainingMin)}</span></div>
        ${s.nozzleTemp ? `<div class="ps-detail"><span>Nozzle</span><span>${Math.round(s.nozzleTemp.actual)}° / ${Math.round(s.nozzleTemp.target)}°</span></div>` : ''}
        ${s.bedTemp ? `<div class="ps-detail"><span>Bed</span><span>${Math.round(s.bedTemp.actual)}° / ${Math.round(s.bedTemp.target)}°</span></div>` : ''}
      </div>
    `;
  }).join('');
}

// ── Home Assistant / Filament Storage ─────────────────────────────────────────
const HA_SECTIONS = [
  {
    title: 'Large Boxes',
    alertLabel: 'DryBox High Humidity',
    alertIf: [
      'sensor.h5100_226d_humidity', 'sensor.h5100_6748_humidity', 'sensor.h5100_0a3c_humidity',
      'sensor.h5100_445b_humidity', 'sensor.h5100_4738_humidity'
    ],
    items: [
      { id: 'sensor.h5100_226d_humidity', label: 'Large Dry Box 1' },
      { id: 'sensor.h5100_6748_humidity', label: 'Large Dry Box 2' },
      { id: 'sensor.h5100_2967_humidity', label: 'Large Dry Box 3' }
    ]
  },
  {
    title: 'Small Boxes',
    items: [
      { id: 'sensor.h5100_0a3c_humidity', label: 'Small Dry Box 1' },
      { id: 'sensor.h5100_445b_humidity', label: 'Small Dry Box 2' },
      { id: 'sensor.h5100_4738_humidity', label: 'Small Dry Box 3' },
      { id: 'sensor.h5074_3586_humidity', label: 'Small Dry Box 4' }
    ]
  },
  {
    title: 'AMS Units',
    items: [
      { id: 'sensor.h2c_31b8ap5c1101184_ams_1_humidity_2', label: 'AMS 2 Pro 1' },
      { id: 'sensor.h2c_31b8ap5c1101184_ams_1_humidity', label: 'AMS 2 Pro 2' },
      { id: 'sensor.h2c_31b8ap5c1101184_ams_128_humidity', label: 'H2C AMS-HT' },
      { id: 'sensor.p2s_22e8aj5a0500535_ams_128_humidity', label: 'P2S AMS-HT B' },
      { id: 'sensor.p2s_22e8aj5a0500535_ams_128_humidity_2', label: 'P2S AMS-HT A' }
    ]
  },
  {
    title: 'Creality Dry Boxes',
    items: [
      { id: 'sensor.large_dry_box_humidity', label: 'Creality L (Humidity)' },
      { id: 'sensor.large_dry_box_temperature', label: 'Creality L (Temp)' },
      { id: 'sensor.temperature_and_humidity_sensors_4_humidity', label: 'Creality R (Humidity)' },
      { id: 'sensor.temperature_and_humidity_sensors_4_temperature', label: 'Creality R (Temp)' }
    ]
  },
  {
    title: 'Room Stats',
    items: [
      { id: 'sensor.h5074_3302_humidity', label: 'Room Humidity' },
      { id: 'sensor.h5074_3302_temperature', label: 'Room Temp' },
      { id: 'sensor.temperature_and_humidity_sensors_5_temperature', label: 'Sensor 5 Temp' }
    ]
  }
];

async function renderHaSensors() {
  const grid = document.getElementById('haSensorsGrid');
  const empty = document.getElementById('haSensorsEmpty');
  if (!grid || !db) return;

  const cfg = db.settings.homeAssistant;
  if (!cfg || !cfg.baseUrl || !cfg.token) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  const allIds = HA_SECTIONS.flatMap(s => [...(s.alertIf || []), ...s.items.map(i => i.id)]);
  const uniqueIds = [...new Set(allIds)];

  let resp;
  try {
    resp = await api.getHaStates(uniqueIds, cfg);
  } catch (e) {
    resp = { error: 'Offline' };
  }

  if (resp.error) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = 'Home Assistant: ' + resp.error;
    return;
  }
  empty.style.display = 'none';

  const data = resp.data || {};
  grid.innerHTML = HA_SECTIONS.map(section => {
    const alertActive = (section.alertIf || []).some(id => {
      const v = data[id];
      return v && !isNaN(parseFloat(v.state)) && parseFloat(v.state) > 25;
    });

    const cardsHtml = section.items.map(item => {
      const v = data[item.id];
      const numeric = v ? parseFloat(v.state) : NaN;
      const val = v && v.state != null && v.state !== 'unavailable' ? v.state : '—';
      const unit = v ? v.unit : '';
      const isHumidity = /_humidity(_\d+)?$/.test(item.id);
      const warn = isHumidity && !isNaN(numeric) && numeric > 25;
      return `
        <div class="ha-card${warn ? ' ha-warn' : ''}">
          <div class="ha-label">${item.label}</div>
          <div class="ha-value">${val}${unit ? ' ' + unit : ''}</div>
        </div>`;
    }).join('');

    return `
      <div class="ha-section">
        <h3>${section.title}</h3>
        ${alertActive ? `<div class="ha-alert">⚠ ${section.alertLabel}</div>` : ''}
        <div class="ha-grid">${cardsHtml}</div>
      </div>`;
  }).join('');
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function renderDashboard() {
  const h = db.history;
  document.getElementById('d-jobs').textContent    = h.length || '0';
  document.getElementById('d-quotes').textContent  = db.quotes.length || '0';

  if (!h.length) {
    document.getElementById('d-revenue').textContent = '$0.00';
    document.getElementById('d-profit').textContent  = '$0.00';
    document.getElementById('d-margin').textContent  = '—';
    document.getElementById('d-topFilament').textContent = '—';
    document.getElementById('d-monthlyEmpty').style.display = 'block';
    document.getElementById('d-monthlyTable').style.display = 'none';
    document.getElementById('d-recentEmpty').style.display  = 'block';
    document.getElementById('d-recentTable').style.display  = 'none';
    return;
  }

  const totalRevenue = h.reduce((s, e) => s + e.price, 0);
  const totalProfit  = h.reduce((s, e) => s + e.profit, 0);
  const avgMarkup = h.reduce((s, e) => s + (e.markup || (e.price / (e.totalItemCost ?? e.itemCost))), 0) / h.length;

  document.getElementById('d-revenue').textContent = fmt(totalRevenue);
  document.getElementById('d-profit').textContent  = fmt(totalProfit);
  document.getElementById('d-margin').textContent  = avgMarkup.toFixed(2) + '×';
  document.getElementById('d-margin').style.color  = avgMarkup < 1.5 ? 'var(--yellow)' : 'var(--green)';

  // Top filament by usage count
  const filCount = {};
  h.forEach(e => { filCount[e.filamentName] = (filCount[e.filamentName] || 0) + 1; });
  const topFil = Object.entries(filCount).sort((a, b) => b[1] - a[1])[0];
  document.getElementById('d-topFilament').textContent = topFil ? topFil[0] : '—';

  // Monthly summary
  const monthly = {};
  h.forEach(e => {
    const key = new Date(e.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short' }) || e.date;
    if (!monthly[key]) monthly[key] = { jobs: 0, revenue: 0, profit: 0 };
    monthly[key].jobs++;
    monthly[key].revenue += e.price;
    monthly[key].profit  += e.profit;
  });

  const monthKeys = Object.keys(monthly);
  document.getElementById('d-monthlyEmpty').style.display = monthKeys.length ? 'none' : 'block';
  document.getElementById('d-monthlyTable').style.display = monthKeys.length ? 'table' : 'none';
  document.getElementById('d-monthlyBody').innerHTML = monthKeys.map(k => {
    const m = monthly[k];
    const mkup = m.revenue / (m.revenue - m.profit);
    return `<tr>
      <td>${k}</td><td>${m.jobs}</td>
      <td>${fmt(m.revenue)}</td>
      <td class="badge-profit">${fmt(m.profit)}</td>
      <td>${mkup.toFixed(2)}×</td>
    </tr>`;
  }).join('');

  // Recent jobs (last 8)
  document.getElementById('d-recentEmpty').style.display = 'none';
  document.getElementById('d-recentTable').style.display = 'table';
  document.getElementById('d-recentBody').innerHTML = h.slice(0, 8).map(e => `
    <tr>
      <td>${e.date}</td>
      <td>${e.job}</td>
      <td>${fmt(e.price)}</td>
      <td class="badge-profit">${fmt(e.profit)}</td>
    </tr>
  `).join('');
}

// ── Calculator ────────────────────────────────────────────────────────────────
function renderPrinterSelect() {
  const sel = document.getElementById('printerSelect');
  const cur = sel.value;
  sel.innerHTML = db.printers.map(p =>
    `<option value="${p.id}">${p.name} — ${p.watts}W</option>`
  ).join('');
  if (cur) sel.value = cur;
}

function renderFilamentSelect() {
  const sel = document.getElementById('filamentSelect');
  const cur = sel.value;
  sel.innerHTML = db.filaments.map(f =>
    `<option value="${f.id}">${f.name} — $${f.costPerKg}/kg</option>`
  ).join('');
  if (cur) sel.value = cur;
}

function renderLaborSelect() {
  const sel = document.getElementById('laborSelect');
  const cur = sel.value;
  sel.innerHTML = db.laborRates.map(l =>
    `<option value="${l.id}">${l.name} — $${l.ratePerHour}/hr</option>`
  ).join('');
  if (cur) sel.value = cur;
}

document.getElementById('calcBtn').addEventListener('click', calculate);

const FILAMENT_WASTE_FACTOR = 1.2; // pads actual usage 20% for purge/failed prints/waste

function computePricing({ printer, filament, labor, grams, hours, laborHours, extra, items, markup, discount }) {
  const { electricityRate, commissionPercent } = db.settings;

  const filamentCost    = (grams / 1000) * filament.costPerKg * FILAMENT_WASTE_FACTOR;
  const electricityCost = hours * (printer.watts / 1000) * electricityRate;
  const maintenanceCost = hours * printer.maintenancePerHour;
  const totalPlateCost  = filamentCost + electricityCost + maintenanceCost + extra;
  const printCostPerItem = totalPlateCost / items;
  const laborCost       = laborHours * labor.ratePerHour;
  const totalItemCost   = printCostPerItem + laborCost;

  const commRate   = commissionPercent / 100;
  const price      = totalItemCost * markup / (1 - commRate);
  const commission = price * commRate;
  const net        = price - commission;
  const profit     = net - totalItemCost;

  const discountAmt     = price * (discount / 100);
  const discountedPrice = price - discountAmt;

  return {
    printerId: printer.id, printerName: printer.name,
    filamentId: filament.id, filamentName: filament.name,
    grams, hours,
    laborId: labor.id, laborName: labor.name, laborRate: labor.ratePerHour, laborHours,
    extra, items,
    filamentCost, electricityCost, maintenanceCost, totalPlateCost,
    printCostPerItem, laborCost, totalItemCost,
    markup, price, commission, profit, net, commissionPercent,
    discount, discountAmt, discountedPrice
  };
}

function calculate() {
  const printer    = getById(db.printers,   document.getElementById('printerSelect').value);
  const filament   = getById(db.filaments,  document.getElementById('filamentSelect').value);
  const labor      = getById(db.laborRates, document.getElementById('laborSelect').value);
  const grams      = parseFloat(document.getElementById('filamentGrams').value) || 0;
  const hours      = parseFloat(document.getElementById('printHours').value)    || 0;
  const laborHours = parseFloat(document.getElementById('laborHours').value)    || 0;
  const discount   = parseFloat(document.getElementById('discount').value)      || 0;
  const extra      = parseFloat(document.getElementById('extraMaterial').value) || 0;
  const items      = parseInt(document.getElementById('itemsPerPlate').value)   || 1;
  const markup     = parseFloat(document.getElementById('profitMargin').value)  || 3;

  const r = computePricing({ printer, filament, labor, grams, hours, laborHours, extra, items, markup, discount });

  function priceAt(m) {
    const commRate = r.commissionPercent / 100;
    const p = r.totalItemCost * m / (1 - commRate);
    return { price: p, commission: p * commRate, profit: p * (1 - commRate) - r.totalItemCost };
  }

  // Reset custom price
  document.getElementById('customPrice').value = '';
  document.getElementById('customPriceResult').style.display = 'none';

  document.getElementById('resultEmpty').style.display   = 'none';
  document.getElementById('resultContent').style.display = 'block';

  document.getElementById('r-filament').textContent     = fmt(r.filamentCost);
  document.getElementById('r-electricity').textContent  = fmt(r.electricityCost);
  document.getElementById('r-maintenance').textContent  = fmt(r.maintenanceCost);
  document.getElementById('r-extra').textContent        = fmt(r.extra);
  document.getElementById('r-plateCost').textContent    = fmt(r.totalPlateCost);
  document.getElementById('r-items').textContent        = r.items;
  document.getElementById('r-itemCost').textContent     = fmt(r.printCostPerItem);
  document.getElementById('r-laborName').textContent    = r.laborName;
  document.getElementById('r-laborHrs').textContent     = r.laborHours;
  document.getElementById('r-labor').textContent        = fmt(r.laborCost);
  document.getElementById('r-totalItemCost').textContent = fmt(r.totalItemCost);

  [[2, '2x'], [3, '3x'], [3.5, '35x']].forEach(([m, id]) => {
    const t = priceAt(m);
    document.getElementById(`r-price${id}`).textContent  = fmtPrice(t.price);
    document.getElementById(`r-comm${id}`).textContent   = fmt(t.commission);
    document.getElementById(`r-profit${id}`).textContent = fmt(t.profit);
  });

  document.getElementById('r-price').textContent      = fmtPrice(r.price);
  document.getElementById('r-commPct').textContent    = r.commissionPercent;
  document.getElementById('r-commission').textContent = fmt(r.commission);
  document.getElementById('r-marginPct').textContent  = r.markup;
  document.getElementById('r-profit').textContent     = fmt(r.profit);
  document.getElementById('r-net').textContent        = fmt(r.net);

  document.getElementById('discountRow').style.display        = r.discount > 0 ? 'flex' : 'none';
  document.getElementById('discountedPriceRow').style.display = r.discount > 0 ? 'flex' : 'none';
  document.getElementById('r-discountPct').textContent        = r.discount;
  document.getElementById('r-discountAmt').textContent        = '−' + fmt(r.discountAmt);
  document.getElementById('r-discountedPrice').textContent    = fmtPrice(r.discountedPrice);

  document.getElementById('calcBtn')._lastResult = r;
}

window.selectMarkup = (m) => {
  document.getElementById('profitMargin').value = m;
  calculate();
  applyRoundedPrice();
};

// Quick-pick markup tiers should save/display the rounded whole-dollar price
// (matching what's shown) rather than the exact floating-point value.
function applyRoundedPrice() {
  const r = document.getElementById('calcBtn')._lastResult;
  if (!r) return;

  const roundedPrice    = Math.round(r.price);
  const commRate        = (r.commissionPercent || 0) / 100;
  const commission      = roundedPrice * commRate;
  const net             = roundedPrice - commission;
  const profit          = net - r.totalItemCost;
  const discountAmt     = roundedPrice * ((r.discount || 0) / 100);
  const discountedPrice = roundedPrice - discountAmt;

  Object.assign(r, { price: roundedPrice, commission, net, profit, discountAmt, discountedPrice });

  document.getElementById('r-price').textContent           = fmtPrice(roundedPrice);
  document.getElementById('r-commission').textContent      = fmt(commission);
  document.getElementById('r-profit').textContent          = fmt(profit);
  document.getElementById('r-net').textContent             = fmt(net);
  document.getElementById('r-discountAmt').textContent     = '−' + fmt(discountAmt);
  document.getElementById('r-discountedPrice').textContent = fmtPrice(discountedPrice);
}

document.getElementById('resetCalcBtn').addEventListener('click', () => {
  document.getElementById('printerSelect').selectedIndex  = 0;
  document.getElementById('filamentSelect').selectedIndex = 0;
  document.getElementById('laborSelect').selectedIndex    = 0;
  document.getElementById('filamentGrams').value  = 50;
  document.getElementById('printHours').value     = 2;
  document.getElementById('extraMaterial').value  = 0;
  document.getElementById('laborHours').value     = 0;
  document.getElementById('itemsPerPlate').value  = 1;
  document.getElementById('profitMargin').value   = 3;
  document.getElementById('discount').value       = 0;
  document.getElementById('jobName').value        = '';
  document.getElementById('customPrice').value    = '';
  document.getElementById('customPriceResult').style.display = 'none';

  document.getElementById('calcBtn')._lastResult = null;
  document.getElementById('resultEmpty').style.display   = 'block';
  document.getElementById('resultContent').style.display = 'none';
});

// ── Custom price ──────────────────────────────────────────────────────────────
document.getElementById('customPrice').addEventListener('input', () => {
  const r = document.getElementById('calcBtn')._lastResult;
  const customPrice = parseFloat(document.getElementById('customPrice').value);
  const result = document.getElementById('customPriceResult');
  if (!r || isNaN(customPrice) || customPrice <= 0) { result.style.display = 'none'; return; }

  result.style.display = 'block';
  const commRate   = r.commissionPercent / 100;
  const commission = customPrice * commRate;
  const net        = customPrice - commission;
  const profit     = net - r.totalItemCost;
  const effectiveMarkup = customPrice / r.totalItemCost;
  const belowCost       = net < r.totalItemCost;

  document.getElementById('cp-commPct').textContent    = r.commissionPercent;
  document.getElementById('cp-commission').textContent = fmt(commission);
  document.getElementById('cp-net').textContent        = fmt(net);
  document.getElementById('cp-profit').textContent     = fmt(profit);
  document.getElementById('cp-margin').textContent     = effectiveMarkup.toFixed(2) + '×';
  document.getElementById('cp-margin').style.color     = belowCost ? 'var(--red)' : effectiveMarkup < 1.5 ? 'var(--yellow)' : 'var(--green)';
  document.getElementById('cp-warning').style.display  = belowCost ? 'block' : 'none';
});

// Returns overrides from the custom price field if one has been entered.
function resolvedPricing(r) {
  const customPrice = parseFloat(document.getElementById('customPrice').value);
  if (!r || isNaN(customPrice) || customPrice <= 0) return {};
  const commRate   = (r.commissionPercent || 0) / 100;
  const commission = customPrice * commRate;
  const net        = customPrice - commission;
  const profit     = net - r.totalItemCost;
  return { price: customPrice, commission, net, profit, discount: 0, discountAmt: 0, discountedPrice: customPrice };
}

// ── Save to History ───────────────────────────────────────────────────────────
document.getElementById('saveBtn').addEventListener('click', () => {
  const r = document.getElementById('calcBtn')._lastResult;
  if (!r) return;
  const job = document.getElementById('jobName').value.trim() || '—';
  db.history.unshift({ id: Date.now(), date: new Date().toLocaleDateString(), job, ...r, ...resolvedPricing(r) });
  if (job !== '—') addToInventory(job, r.items, r.discount ? r.discountedPrice : r.price);
  persist();
  renderHistory();
  renderInventoryTable();
  renderDashboard();
  const btn = document.getElementById('saveBtn');
  btn.textContent = 'Saved ✓';
  setTimeout(() => btn.textContent = 'Save to History', 1500);
});

// ── Save as Quote ─────────────────────────────────────────────────────────────
document.getElementById('saveQuoteBtn').addEventListener('click', () => {
  if (!document.getElementById('calcBtn')._lastResult) return;
  // Default valid-until to 30 days from now
  const d = new Date(); d.setDate(d.getDate() + 30);
  document.getElementById('qValidUntil').value = d.toISOString().slice(0, 10);
  document.getElementById('qCustomer').value   = '';
  document.getElementById('qNotes').value      = '';
  document.getElementById('quoteModal').style.display = 'flex';
});

document.getElementById('qCancelBtn').addEventListener('click', () => {
  document.getElementById('quoteModal').style.display = 'none';
});

document.getElementById('qConfirmBtn').addEventListener('click', () => {
  const r        = { ...document.getElementById('calcBtn')._lastResult, ...resolvedPricing(document.getElementById('calcBtn')._lastResult) };
  const customer = document.getElementById('qCustomer').value.trim() || 'Customer';
  const validUntil = document.getElementById('qValidUntil').value;
  const notes    = document.getElementById('qNotes').value.trim();
  const quoteNum = 'Q-' + Date.now().toString().slice(-6);

  db.quotes.unshift({
    id: Date.now(), quoteNum,
    date: new Date().toLocaleDateString(),
    validUntil: validUntil ? new Date(validUntil).toLocaleDateString() : '—',
    customer, notes,
    job: document.getElementById('jobName').value.trim() || '—',
    ...r
  });
  persist();
  renderQuotes();
  renderDashboard();
  document.getElementById('quoteModal').style.display = 'none';

  // Switch to quotes tab
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="quotes"]').classList.add('active');
  document.getElementById('tab-quotes').classList.add('active');
});

// ── Quotes ────────────────────────────────────────────────────────────────────
function renderQuotes() {
  const empty = document.getElementById('quotesEmpty');
  const table = document.getElementById('quotesTable');
  if (!db.quotes.length) {
    empty.style.display = 'block'; table.style.display = 'none'; return;
  }
  empty.style.display = 'none'; table.style.display = 'table';
  document.getElementById('quotesBody').innerHTML = db.quotes.map(q => `
    <tr>
      <td>${q.date}</td>
      <td>${q.customer}</td>
      <td>${q.job}</td>
      <td>${fmt(q.discount ? q.discountedPrice : q.price)}</td>
      <td>${q.validUntil}</td>
      <td>
        <button class="icon-btn" onclick="viewQuote(${q.id})" title="View/Print">🖨</button>
        <button class="icon-btn del" onclick="deleteQuote(${q.id})" title="Delete">🗑</button>
      </td>
    </tr>
  `).join('');
}

window.viewQuote = (id) => {
  const q = db.quotes.find(x => x.id === id);
  if (!q) return;

  document.getElementById('qp-date').textContent        = q.date;
  document.getElementById('qp-validUntil').textContent  = q.validUntil;
  document.getElementById('qp-id').textContent          = q.quoteNum;
  document.getElementById('qp-customer').textContent    = q.customer;
  document.getElementById('qp-job').textContent         = q.job;
  document.getElementById('qp-filament').textContent    = q.filamentName;
  document.getElementById('qp-filamentGrams').textContent = q.grams + 'g';
  document.getElementById('qp-printHours').textContent  = q.hours + 'h';
  document.getElementById('qp-extra').textContent       = fmt(q.extra);
  document.getElementById('qp-extraRow').style.display  = q.extra > 0 ? '' : 'none';
  document.getElementById('qp-laborName').textContent   = q.laborName || '—';
  document.getElementById('qp-laborHrs').textContent    = q.laborHours || 0;
  document.getElementById('qp-labor').textContent       = fmt(q.laborCost || 0);
  document.getElementById('qp-laborRow').style.display  = (q.laborHours > 0) ? '' : 'none';
  document.getElementById('qp-items').textContent       = q.items;
  document.getElementById('qp-price').textContent       = fmt(q.price);

  const hasDiscount = q.discount > 0;
  document.getElementById('qp-discountRow').style.display = hasDiscount ? 'flex' : 'none';
  document.getElementById('qp-discountPct').textContent   = q.discount || 0;
  document.getElementById('qp-discountAmt').textContent   = hasDiscount ? '−' + fmt(q.discountAmt) : '';
  document.getElementById('qp-finalPrice').textContent    = fmt(hasDiscount ? q.discountedPrice : q.price);

  const hasNotes = q.notes && q.notes.trim();
  document.getElementById('qp-notesRow').style.display = hasNotes ? 'block' : 'none';
  document.getElementById('qp-notes').textContent = q.notes || '';

  document.getElementById('quoteListView').style.display  = 'none';
  document.getElementById('quotePrintView').style.display = 'block';
};

document.getElementById('backToQuotesBtn').addEventListener('click', () => {
  document.getElementById('quoteListView').style.display  = 'block';
  document.getElementById('quotePrintView').style.display = 'none';
});

document.getElementById('printQuoteBtn').addEventListener('click', () => window.print());

window.deleteQuote = (id) => {
  if (!confirm('Delete this quote?')) return;
  db.quotes = db.quotes.filter(q => q.id !== id);
  persist();
  renderQuotes();
};

document.getElementById('clearQuotesBtn').addEventListener('click', () => {
  if (!db.quotes.length || !confirm('Clear all quotes?')) return;
  db.quotes = [];
  persist();
  renderQuotes();
});

// ── Inventory ─────────────────────────────────────────────────────────────────
function addToInventory(name, qty, price) {
  qty = parseInt(qty) || 0;
  if (qty <= 0) return;
  const existing = db.inventory.find(i => i.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.qtyOnHand += qty;
    if (price != null) existing.sellingPrice = price;
  } else {
    db.inventory.push({ id: Date.now(), name, qtyOnHand: qty, sellingPrice: price || 0 });
  }
}

let inventorySortDir = 'asc';

document.querySelectorAll('#inventoryTable th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    inventorySortDir = inventorySortDir === 'asc' ? 'desc' : 'asc';
    renderInventoryTable();
  });
});

function renderInventoryTable() {
  const empty = document.getElementById('inventoryEmpty');
  const table = document.getElementById('inventoryTable');
  if (!db.inventory.length) { empty.style.display = 'block'; table.style.display = 'none'; return; }
  empty.style.display = 'none'; table.style.display = 'table';

  document.getElementById('sortArrow-invName').textContent = inventorySortDir === 'asc' ? '▲' : '▼';

  const mult = inventorySortDir === 'asc' ? 1 : -1;
  const sorted = [...db.inventory].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * mult);

  document.querySelector('#inventoryTable tbody').innerHTML = sorted.map(i => {
    const lowStock = i.qtyOnHand <= 1;
    return `
    <tr class="${lowStock ? 'low-stock' : ''}">
      <td>${i.name}</td>
      <td>${i.qtyOnHand}${lowStock ? ' <span class="low-stock-badge">Low Stock</span>' : ''}</td>
      <td>${fmt(i.sellingPrice || 0)}</td>
      <td>
        <input type="number" id="invAdjust-${i.id}" min="1" step="1" value="1" style="width:64px" />
        <button class="btn-secondary" onclick="addToInventoryRow(${i.id})">+ Add More</button>
        <button class="btn-secondary" onclick="takeFromInventory(${i.id})">Take to Store / Sold</button>
      </td>
      <td>
        <button class="icon-btn" onclick="editInventory(${i.id})">✏️</button>
        <button class="icon-btn del" onclick="deleteInventory(${i.id})">🗑</button>
      </td>
    </tr>
  `;
  }).join('');
}

window.addToInventoryRow = (id) => {
  const item = getById(db.inventory, id);
  if (!item) return;
  const qty = parseInt(document.getElementById(`invAdjust-${id}`).value) || 0;
  if (qty <= 0) return;
  item.qtyOnHand += qty;
  persist();
  renderInventoryTable();
};

window.takeFromInventory = (id) => {
  const item = getById(db.inventory, id);
  if (!item) return;
  const qty = parseInt(document.getElementById(`invAdjust-${id}`).value) || 0;
  if (qty <= 0) return;
  item.qtyOnHand = Math.max(0, item.qtyOnHand - qty);
  persist();
  renderInventoryTable();
};

document.getElementById('invSaveBtn').addEventListener('click', () => {
  const id    = document.getElementById('invEditId').value;
  const name  = document.getElementById('invName').value.trim();
  const qty   = parseInt(document.getElementById('invQty').value);
  const price = parseFloat(document.getElementById('invPrice').value) || 0;
  if (!name || isNaN(qty) || qty < 0) return;
  if (id) {
    const i = getById(db.inventory, id);
    i.name = name; i.qtyOnHand = qty; i.sellingPrice = price;
  } else {
    db.inventory.push({ id: Date.now(), name, qtyOnHand: qty, sellingPrice: price });
  }
  persist(); renderInventoryTable(); resetInventoryForm();
});

window.editInventory = (id) => {
  const i = getById(db.inventory, id);
  document.getElementById('invEditId').value = i.id;
  document.getElementById('invName').value   = i.name;
  document.getElementById('invQty').value    = i.qtyOnHand;
  document.getElementById('invPrice').value  = i.sellingPrice || 0;
  document.getElementById('invSaveBtn').textContent     = 'Update Item';
  document.getElementById('invCancelBtn').style.display = 'inline-block';
};

window.deleteInventory = (id) => {
  if (!confirm('Delete this inventory item?')) return;
  db.inventory = db.inventory.filter(i => i.id !== Number(id));
  persist(); renderInventoryTable();
};

document.getElementById('invCancelBtn').addEventListener('click', resetInventoryForm);

function resetInventoryForm() {
  document.getElementById('invEditId').value = '';
  document.getElementById('invName').value   = '';
  document.getElementById('invQty').value    = '';
  document.getElementById('invPrice').value  = '';
  document.getElementById('invSaveBtn').textContent     = 'Add Item';
  document.getElementById('invCancelBtn').style.display = 'none';
}

document.getElementById('exportInventoryCsvBtn').addEventListener('click', () => {
  if (!db.inventory.length) return;
  const headers = ['Item', 'Qty on Shelf', 'Selling Price'];
  const rows = db.inventory.map(i => [i.name, i.qtyOnHand, (i.sellingPrice || 0).toFixed(2)]
    .map(v => `"${String(v).replace(/"/g, '""')}"`));
  const csv  = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `inventory-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
});

// ── Printers ──────────────────────────────────────────────────────────────────
const PLATFORM_LABELS = { octoprint: 'OctoPrint', bambu: 'Bambu Lab', moonraker: 'Moonraker' };

function renderPrinterTable() {
  document.querySelector('#printerTable tbody').innerHTML = db.printers.map(p => `
    <tr>
      <td>${p.name}</td>
      <td>${p.watts}W</td>
      <td>${fmt(p.maintenancePerHour)}/hr</td>
      <td>${PLATFORM_LABELS[p.platform] || '—'}</td>
      <td>
        <button class="icon-btn" onclick="editPrinter(${p.id})">✏️</button>
        <button class="icon-btn del" onclick="deletePrinter(${p.id})">🗑</button>
      </td>
    </tr>
  `).join('');
}

function togglePlatformFields() {
  const platform = document.getElementById('prnPlatform').value;
  document.getElementById('prnOctoprintFields').style.display = platform === 'octoprint' ? 'block' : 'none';
  document.getElementById('prnBambuFields').style.display     = platform === 'bambu' ? 'block' : 'none';
  document.getElementById('prnMoonrakerFields').style.display = platform === 'moonraker' ? 'block' : 'none';
}
document.getElementById('prnPlatform').addEventListener('change', togglePlatformFields);

document.getElementById('prnSaveBtn').addEventListener('click', () => {
  const id       = document.getElementById('prnEditId').value;
  const name     = document.getElementById('prnName').value.trim();
  const watts    = parseFloat(document.getElementById('prnWatts').value);
  const maint    = parseFloat(document.getElementById('prnMaint').value);
  const platform = document.getElementById('prnPlatform').value;
  if (!name || isNaN(watts) || isNaN(maint)) return;

  const octoprint = {
    host: document.getElementById('prnOctoHost').value.trim(),
    port: parseInt(document.getElementById('prnOctoPort').value) || 80,
    apiKey: document.getElementById('prnOctoKey').value.trim(),
    https: document.getElementById('prnOctoHttps').checked
  };
  const bambu = {
    host: document.getElementById('prnBambuHost').value.trim(),
    serial: document.getElementById('prnBambuSerial').value.trim(),
    accessCode: document.getElementById('prnBambuCode').value.trim()
  };
  const moonraker = {
    host: document.getElementById('prnMoonHost').value.trim(),
    port: parseInt(document.getElementById('prnMoonPort').value) || 80,
    apiKey: document.getElementById('prnMoonKey').value.trim(),
    https: document.getElementById('prnMoonHttps').checked
  };

  if (id) {
    const p = getById(db.printers, id);
    p.name = name; p.watts = watts; p.maintenancePerHour = maint;
    p.platform = platform; p.octoprint = octoprint; p.bambu = bambu; p.moonraker = moonraker;
  } else {
    db.printers.push({ id: Date.now(), name, watts, maintenancePerHour: maint, platform, octoprint, bambu, moonraker });
  }
  persist(); renderPrinterTable(); renderPrinterSelect(); resetPrinterForm(); renderPrinterStatuses();
});

window.editPrinter = (id) => {
  const p = getById(db.printers, id);
  document.getElementById('prnEditId').value = p.id;
  document.getElementById('prnName').value   = p.name;
  document.getElementById('prnWatts').value  = p.watts;
  document.getElementById('prnMaint').value  = p.maintenancePerHour;
  document.getElementById('prnPlatform').value = p.platform || '';
  document.getElementById('prnOctoHost').value  = (p.octoprint && p.octoprint.host) || '';
  document.getElementById('prnOctoPort').value  = (p.octoprint && p.octoprint.port) || '';
  document.getElementById('prnOctoKey').value   = (p.octoprint && p.octoprint.apiKey) || '';
  document.getElementById('prnOctoHttps').checked = !!(p.octoprint && p.octoprint.https);
  document.getElementById('prnBambuHost').value   = (p.bambu && p.bambu.host) || '';
  document.getElementById('prnBambuSerial').value = (p.bambu && p.bambu.serial) || '';
  document.getElementById('prnBambuCode').value   = (p.bambu && p.bambu.accessCode) || '';
  document.getElementById('prnMoonHost').value    = (p.moonraker && p.moonraker.host) || '';
  document.getElementById('prnMoonPort').value    = (p.moonraker && p.moonraker.port) || '';
  document.getElementById('prnMoonKey').value     = (p.moonraker && p.moonraker.apiKey) || '';
  document.getElementById('prnMoonHttps').checked = !!(p.moonraker && p.moonraker.https);
  togglePlatformFields();
  document.getElementById('prnSaveBtn').textContent      = 'Update Printer';
  document.getElementById('prnCancelBtn').style.display  = 'inline-block';
};

window.deletePrinter = (id) => {
  if (db.printers.length <= 1) { alert('You must keep at least one printer.'); return; }
  if (!confirm('Delete this printer?')) return;
  db.printers = db.printers.filter(p => p.id !== Number(id));
  persist(); renderPrinterTable(); renderPrinterSelect(); renderPrinterStatuses();
};

document.getElementById('prnCancelBtn').addEventListener('click', resetPrinterForm);

function resetPrinterForm() {
  document.getElementById('prnEditId').value = '';
  document.getElementById('prnName').value   = '';
  document.getElementById('prnWatts').value  = '';
  document.getElementById('prnMaint').value  = '';
  document.getElementById('prnPlatform').value = '';
  document.getElementById('prnOctoHost').value = '';
  document.getElementById('prnOctoPort').value = '';
  document.getElementById('prnOctoKey').value  = '';
  document.getElementById('prnOctoHttps').checked = false;
  document.getElementById('prnBambuHost').value   = '';
  document.getElementById('prnBambuSerial').value = '';
  document.getElementById('prnBambuCode').value   = '';
  document.getElementById('prnMoonHost').value    = '';
  document.getElementById('prnMoonPort').value    = '';
  document.getElementById('prnMoonKey').value     = '';
  document.getElementById('prnMoonHttps').checked = false;
  togglePlatformFields();
  document.getElementById('prnSaveBtn').textContent     = 'Add Printer';
  document.getElementById('prnCancelBtn').style.display = 'none';
}

// ── Filaments ─────────────────────────────────────────────────────────────────
function renderFilamentTable() {
  document.querySelector('#filamentTable tbody').innerHTML = db.filaments.map(f => `
    <tr>
      <td>${f.name}</td>
      <td>${fmt(f.costPerKg)}</td>
      <td>$${(f.costPerKg / 1000).toFixed(4)}</td>
      <td>
        <button class="icon-btn" onclick="editFilament(${f.id})">✏️</button>
        <button class="icon-btn del" onclick="deleteFilament(${f.id})">🗑</button>
      </td>
    </tr>
  `).join('');
}

document.getElementById('filSaveBtn').addEventListener('click', () => {
  const id   = document.getElementById('filEditId').value;
  const name = document.getElementById('filName').value.trim();
  const cost = parseFloat(document.getElementById('filCostKg').value);
  if (!name || isNaN(cost) || cost < 0) return;
  if (id) { const f = getById(db.filaments, id); f.name = name; f.costPerKg = cost; }
  else db.filaments.push({ id: Date.now(), name, costPerKg: cost });
  persist(); renderFilamentTable(); renderFilamentSelect(); resetFilamentForm();
});

window.editFilament = (id) => {
  const f = getById(db.filaments, id);
  document.getElementById('filEditId').value = f.id;
  document.getElementById('filName').value   = f.name;
  document.getElementById('filCostKg').value = f.costPerKg;
  document.getElementById('filSaveBtn').textContent     = 'Update Filament';
  document.getElementById('filCancelBtn').style.display = 'inline-block';
};

window.deleteFilament = (id) => {
  if (db.filaments.length <= 1) { alert('You must keep at least one filament.'); return; }
  if (!confirm('Delete this filament?')) return;
  db.filaments = db.filaments.filter(f => f.id !== Number(id));
  persist(); renderFilamentTable(); renderFilamentSelect();
};

document.getElementById('filCancelBtn').addEventListener('click', resetFilamentForm);

function resetFilamentForm() {
  document.getElementById('filEditId').value = '';
  document.getElementById('filName').value   = '';
  document.getElementById('filCostKg').value = '';
  document.getElementById('filSaveBtn').textContent     = 'Add Filament';
  document.getElementById('filCancelBtn').style.display = 'none';
}

// ── Labor Rates ───────────────────────────────────────────────────────────────
function renderLaborTable() {
  document.querySelector('#laborTable tbody').innerHTML = db.laborRates.map(l => `
    <tr>
      <td>${l.name}</td>
      <td>${fmt(l.ratePerHour)}/hr</td>
      <td>
        <button class="icon-btn" onclick="editLabor(${l.id})">✏️</button>
        <button class="icon-btn del" onclick="deleteLabor(${l.id})">🗑</button>
      </td>
    </tr>
  `).join('');
}

document.getElementById('labSaveBtn').addEventListener('click', () => {
  const id   = document.getElementById('labEditId').value;
  const name = document.getElementById('labName').value.trim();
  const rate = parseFloat(document.getElementById('labRate').value);
  if (!name || isNaN(rate) || rate < 0) return;
  if (id) { const l = getById(db.laborRates, id); l.name = name; l.ratePerHour = rate; }
  else db.laborRates.push({ id: Date.now(), name, ratePerHour: rate });
  persist(); renderLaborTable(); renderLaborSelect(); resetLaborForm();
});

window.editLabor = (id) => {
  const l = getById(db.laborRates, id);
  document.getElementById('labEditId').value = l.id;
  document.getElementById('labName').value   = l.name;
  document.getElementById('labRate').value   = l.ratePerHour;
  document.getElementById('labSaveBtn').textContent     = 'Update Rate';
  document.getElementById('labCancelBtn').style.display = 'inline-block';
};

window.deleteLabor = (id) => {
  if (db.laborRates.length <= 1) { alert('You must keep at least one labor rate.'); return; }
  if (!confirm('Delete this labor rate?')) return;
  db.laborRates = db.laborRates.filter(l => l.id !== Number(id));
  persist(); renderLaborTable(); renderLaborSelect();
};

document.getElementById('labCancelBtn').addEventListener('click', resetLaborForm);

function resetLaborForm() {
  document.getElementById('labEditId').value = '';
  document.getElementById('labName').value   = '';
  document.getElementById('labRate').value   = '';
  document.getElementById('labSaveBtn').textContent     = 'Add Rate';
  document.getElementById('labCancelBtn').style.display = 'none';
}

// ── Settings ──────────────────────────────────────────────────────────────────
function renderSettings() {
  document.getElementById('sElecRate').value   = db.settings.electricityRate;
  document.getElementById('sCommission').value = db.settings.commissionPercent;
  const ha = db.settings.homeAssistant || {};
  document.getElementById('sHaUrl').value   = ha.baseUrl || '';
  document.getElementById('sHaToken').value = ha.token || '';
}

document.getElementById('settingsSaveBtn').addEventListener('click', () => {
  db.settings.electricityRate   = parseFloat(document.getElementById('sElecRate').value)   || 0;
  db.settings.commissionPercent = parseFloat(document.getElementById('sCommission').value) || 0;
  persist();
  const toast = document.getElementById('settingsToast');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
});

document.getElementById('haSaveBtn').addEventListener('click', () => {
  db.settings.homeAssistant = {
    baseUrl: document.getElementById('sHaUrl').value.trim(),
    token: document.getElementById('sHaToken').value.trim()
  };
  persist();
  renderHaSensors();
  const toast = document.getElementById('haToast');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
});

document.getElementById('backupBtn').addEventListener('click', async () => {
  const filename = `pricer-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const json = JSON.stringify(db, null, 2);
  const showToast = () => {
    const toast = document.getElementById('backupToast');
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  };

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'JSON Backup', accept: { 'application/json': ['.json'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      showToast();
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // user cancelled the save dialog
      // fall through to the plain download below on any other error
    }
  }

  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  showToast();
});

// ── History ───────────────────────────────────────────────────────────────────
let historySort = { key: 'date', dir: 'desc' };

function getSortedHistory() {
  const { key, dir } = historySort;
  const mult = dir === 'asc' ? 1 : -1;
  return [...db.history].sort((a, b) => {
    if (key === 'job') return a.job.localeCompare(b.job, undefined, { sensitivity: 'base' }) * mult;
    return (a.id - b.id) * mult; // "date" sort uses the save-time timestamp for true chronological order
  });
}

document.querySelectorAll('#historyTable th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (historySort.key === key) {
      historySort.dir = historySort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      historySort = { key, dir: key === 'job' ? 'asc' : 'desc' };
    }
    renderHistory();
  });
});

function renderHistory() {
  const empty = document.getElementById('historyEmpty');
  const table = document.getElementById('historyTable');
  if (!db.history.length) { empty.style.display = 'block'; table.style.display = 'none'; return; }
  empty.style.display = 'none'; table.style.display = 'table';

  document.getElementById('sortArrow-date').textContent = historySort.key === 'date' ? (historySort.dir === 'asc' ? '▲' : '▼') : '';
  document.getElementById('sortArrow-job').textContent  = historySort.key === 'job'  ? (historySort.dir === 'asc' ? '▲' : '▼') : '';

  document.getElementById('historyBody').innerHTML = getSortedHistory().map(h => `
    <tr>
      <td>${h.date}</td>
      <td>${h.job}</td>
      <td>${h.printerName || '—'}</td>
      <td>${h.filamentName}</td>
      <td>${h.grams}g</td>
      <td>${h.hours}h</td>
      <td>${h.laborName || '—'}</td>
      <td>${h.laborHours || 0}h</td>
      <td>${h.items}</td>
      <td>${fmt(h.totalItemCost ?? h.itemCost)}</td>
      <td>${fmt(h.price)}</td>
      <td>${h.discount ? h.discount + '%' : '—'}</td>
      <td>${h.discount ? fmt(h.discountedPrice) : '—'}</td>
      <td class="badge-profit">${fmt(h.profit)}</td>
      <td>
        <button class="icon-btn" onclick="pushToInventory(${h.id}, this)" title="Add ${h.items} to inventory, as if printed again">📦</button>
        <button class="icon-btn" onclick="editHistory(${h.id})">✏️</button>
        <button class="icon-btn del" onclick="deleteHistory(${h.id})">🗑</button>
      </td>
    </tr>
  `).join('');
}

window.pushToInventory = (id, btn) => {
  const h = getById(db.history, id);
  if (!h || h.job === '—') return;
  addToInventory(h.job, h.items, h.discount ? h.discountedPrice : h.price);
  persist();
  renderInventoryTable();
  if (btn) {
    const original = btn.textContent;
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = original; }, 1200);
  }
};

window.deleteHistory = (id) => {
  db.history = db.history.filter(h => h.id !== id);
  persist(); renderHistory(); renderDashboard();
};

function renderHeSelects() {
  document.getElementById('hePrinterSelect').innerHTML = db.printers.map(p =>
    `<option value="${p.id}">${p.name} — ${p.watts}W</option>`
  ).join('');
  document.getElementById('heFilamentSelect').innerHTML = db.filaments.map(f =>
    `<option value="${f.id}">${f.name} — $${f.costPerKg}/kg</option>`
  ).join('');
  document.getElementById('heLaborSelect').innerHTML = db.laborRates.map(l =>
    `<option value="${l.id}">${l.name} — $${l.ratePerHour}/hr</option>`
  ).join('');
}

window.editHistory = (id) => {
  const h = getById(db.history, id);
  if (!h) return;

  renderHeSelects();
  document.getElementById('heEditId').value       = h.id;
  document.getElementById('heJobName').value      = h.job === '—' ? '' : h.job;
  document.getElementById('hePrinterSelect').value  = h.printerId;
  document.getElementById('heFilamentSelect').value = h.filamentId;
  document.getElementById('heLaborSelect').value    = h.laborId;
  document.getElementById('heGrams').value        = h.grams;
  document.getElementById('heHours').value        = h.hours;
  document.getElementById('heExtra').value        = h.extra || 0;
  document.getElementById('heLaborHours').value   = h.laborHours || 0;
  document.getElementById('heItems').value        = h.items;
  document.getElementById('heMarkup').value       = h.markup || 3;
  document.getElementById('heDiscount').value     = h.discount || 0;
  document.getElementById('heCustomPrice').value  = '';

  document.getElementById('historyEditModal').style.display = 'flex';
};

document.getElementById('heCancelBtn').addEventListener('click', () => {
  document.getElementById('historyEditModal').style.display = 'none';
});

document.getElementById('heSaveBtn').addEventListener('click', () => {
  const id = Number(document.getElementById('heEditId').value);
  const h  = getById(db.history, id);
  if (!h) return;

  const printer    = getById(db.printers,   document.getElementById('hePrinterSelect').value);
  const filament   = getById(db.filaments,  document.getElementById('heFilamentSelect').value);
  const labor      = getById(db.laborRates, document.getElementById('heLaborSelect').value);
  const grams      = parseFloat(document.getElementById('heGrams').value)      || 0;
  const hours      = parseFloat(document.getElementById('heHours').value)      || 0;
  const laborHours = parseFloat(document.getElementById('heLaborHours').value) || 0;
  const extra      = parseFloat(document.getElementById('heExtra').value)      || 0;
  const items      = parseInt(document.getElementById('heItems').value)        || 1;
  const markup     = parseFloat(document.getElementById('heMarkup').value)     || 3;
  const discount   = parseFloat(document.getElementById('heDiscount').value)   || 0;
  const job        = document.getElementById('heJobName').value.trim() || '—';

  const r = computePricing({ printer, filament, labor, grams, hours, laborHours, extra, items, markup, discount });

  const customPrice = parseFloat(document.getElementById('heCustomPrice').value);
  if (!isNaN(customPrice) && customPrice > 0) {
    const commRate   = r.commissionPercent / 100;
    const commission = customPrice * commRate;
    const net        = customPrice - commission;
    const profit     = net - r.totalItemCost;
    Object.assign(r, { price: customPrice, commission, net, profit, discount: 0, discountAmt: 0, discountedPrice: customPrice });
  }

  Object.assign(h, { job, ...r });

  persist();
  renderHistory();
  renderDashboard();
  document.getElementById('historyEditModal').style.display = 'none';
});

document.getElementById('exportCsvBtn').addEventListener('click', () => {
  if (!db.history.length) return;
  const headers = [
    'Date','Job','Printer','Filament','Grams','Print Hours',
    'Labor Rate','Labor Hours','Labor Cost','Items per Plate',
    'Filament Cost','Electricity Cost','Maintenance Cost','Extra Materials',
    'Total Plate Cost','Print Cost per Item','Total Cost per Item',
    'Markup','Sell Price','Discount %','Discounted Price','Commission','Profit','Net After Commission'
  ];
  const rows = db.history.map(h => [
    h.date, h.job, h.printerName || '—', h.filamentName, h.grams, h.hours,
    h.laborName || '—', h.laborHours || 0, (h.laborCost || 0).toFixed(2), h.items,
    h.filamentCost.toFixed(2), h.electricityCost.toFixed(2), h.maintenanceCost.toFixed(2),
    h.extra.toFixed(2), h.totalPlateCost.toFixed(2),
    (h.printCostPerItem ?? h.itemCost).toFixed(2),
    (h.totalItemCost ?? h.itemCost).toFixed(2),
    (h.markup || '—'), h.price.toFixed(2), h.discount || 0, (h.discountedPrice ?? h.price).toFixed(2),
    h.commission.toFixed(2), h.profit.toFixed(2), h.net.toFixed(2)
  ].map(v => `"${String(v).replace(/"/g, '""')}"`));
  const csv  = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `print-history-${new Date().toISOString().slice(0,10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
});

document.getElementById('printBtn').addEventListener('click', () => window.print());

document.getElementById('clearHistoryBtn').addEventListener('click', () => {
  if (!db.history.length || !confirm('Clear all saved calculations?')) return;
  db.history = []; persist(); renderHistory(); renderDashboard();
});

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
