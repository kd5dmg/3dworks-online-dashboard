const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const mqtt = require('mqtt');

const PORT = process.env.PORT || 3141;
const dataDir = path.join(__dirname, 'data');
const dataPath = path.join(dataDir, 'pricer-data.json');

function loadData() {
  try {
    if (fs.existsSync(dataPath)) {
      return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    }
  } catch (e) {}
  return {
    settings: {
      electricityRate: 0.12,
      commissionPercent: 10
    },
    printers: [
      { id: 1, name: 'Printer 1 (default)', watts: 250, maintenancePerHour: 0.50 }
    ],
    filaments: [
      { id: 1, name: 'PLA (generic)', costPerKg: 20 },
      { id: 2, name: 'PETG (generic)', costPerKg: 25 },
      { id: 3, name: 'ABS (generic)', costPerKg: 22 }
    ],
    laborRates: [
      { id: 1, name: 'Standard', ratePerHour: 15 },
      { id: 2, name: 'Design / CAD', ratePerHour: 25 },
      { id: 3, name: 'Finishing / Painting', ratePerHour: 20 }
    ],
    quotes: [],
    history: []
  };
}

function saveData(data) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
}

// Automatic backup: one snapshot per day (overwritten with the latest state
// each time data is saved that day), written outside the project folder so
// it survives even if the project itself is moved or deleted.
const BACKUP_DIR = '/Users/glennfrasier/Downloads/private_sync/Pricing App Backups';

function writeBackup(data) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const filename = `pricer-backup-${new Date().toISOString().slice(0, 10)}.json`;
    fs.writeFileSync(path.join(BACKUP_DIR, filename), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Automatic backup failed:', e.message);
  }
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'renderer')));

app.get('/api/data', (_req, res) => res.json(loadData()));
app.post('/api/data', (req, res) => { saveData(req.body); writeBackup(req.body); res.json({ ok: true }); });

// ── Live printer status (OctoPrint REST + Bambu Lab LAN-mode MQTT + Moonraker) ─
const bambuClients = new Map(); // printerId -> { key, client, connected, lastReport, lastUpdated }

const BAMBU_STATE_LABELS = {
  IDLE: 'Idle', RUNNING: 'Printing', PAUSE: 'Paused',
  FINISH: 'Finished', FAILED: 'Failed', PREPARE: 'Preparing'
};

function bambuKey(cfg) { return `${cfg.host}|${cfg.serial}|${cfg.accessCode}`; }

function ensureBambuClient(printerId, cfg) {
  if (!cfg || !cfg.host || !cfg.serial || !cfg.accessCode) return null;
  const key = bambuKey(cfg);
  const existing = bambuClients.get(printerId);
  if (existing && existing.key === key) return existing;
  if (existing) { try { existing.client.end(true); } catch (e) {} bambuClients.delete(printerId); }

  const entry = { key, client: null, connected: false, lastReport: null, lastUpdated: null };
  const client = mqtt.connect(`mqtts://${cfg.host}:8883`, {
    username: 'bblp',
    password: cfg.accessCode,
    rejectUnauthorized: false,
    reconnectPeriod: 5000,
    connectTimeout: 8000
  });
  client.on('connect', () => {
    entry.connected = true;
    client.subscribe(`device/${cfg.serial}/report`);
    client.publish(`device/${cfg.serial}/request`, JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall' } }));
  });
  client.on('message', (_topic, payload) => {
    try {
      const msg = JSON.parse(payload.toString());
      if (msg.print) {
        entry.lastReport = { ...(entry.lastReport || {}), ...msg.print };
        entry.lastUpdated = Date.now();
      }
    } catch (e) {}
  });
  client.on('close', () => { entry.connected = false; });
  client.on('error', () => { entry.connected = false; });

  entry.client = client;
  bambuClients.set(printerId, entry);
  return entry;
}

function bambuStatus(printerId, cfg) {
  const entry = ensureBambuClient(printerId, cfg);
  if (!entry) return { platform: 'bambu', connected: false, state: 'Not configured' };
  if (!entry.connected) return { platform: 'bambu', connected: false, state: 'Offline' };
  if (!entry.lastReport) return { platform: 'bambu', connected: true, state: 'Waiting for data…' };

  const r = entry.lastReport;
  return {
    platform: 'bambu',
    connected: true,
    state: BAMBU_STATE_LABELS[r.gcode_state] || r.gcode_state || 'Unknown',
    fileName: r.subtask_name || null,
    progress: typeof r.mc_percent === 'number' ? r.mc_percent : null,
    timeRemainingMin: typeof r.mc_remaining_time === 'number' ? r.mc_remaining_time : null,
    bedTemp: r.bed_temper != null ? { actual: r.bed_temper, target: r.bed_target_temper } : null,
    nozzleTemp: r.nozzle_temper != null ? { actual: r.nozzle_temper, target: r.nozzle_target_temper } : null,
    lastUpdated: entry.lastUpdated
  };
}

async function octoprintStatus(cfg) {
  if (!cfg || !cfg.host || !cfg.apiKey) return { platform: 'octoprint', connected: false, state: 'Not configured' };
  const proto = cfg.https ? 'https' : 'http';
  const base = `${proto}://${cfg.host}:${cfg.port || 80}`;
  const headers = { 'X-Api-Key': cfg.apiKey };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const [printerRes, jobRes] = await Promise.all([
      fetch(`${base}/api/printer`, { headers, signal: controller.signal }),
      fetch(`${base}/api/job`, { headers, signal: controller.signal })
    ]);
    clearTimeout(timeout);

    if (printerRes.status === 409) {
      return { platform: 'octoprint', connected: true, state: 'Printer not connected', fileName: null, progress: null, timeRemainingMin: null, bedTemp: null, nozzleTemp: null, lastUpdated: Date.now() };
    }
    if (!printerRes.ok || !jobRes.ok) {
      return { platform: 'octoprint', connected: false, state: `HTTP ${printerRes.status || jobRes.status}` };
    }

    const printerData = await printerRes.json();
    const jobData = await jobRes.json();
    return {
      platform: 'octoprint',
      connected: true,
      state: (printerData.state && printerData.state.text) || 'Unknown',
      fileName: jobData.job && jobData.job.file ? jobData.job.file.name : null,
      progress: jobData.progress && jobData.progress.completion != null ? Math.round(jobData.progress.completion) : null,
      timeRemainingMin: jobData.progress && jobData.progress.printTimeLeft != null ? Math.round(jobData.progress.printTimeLeft / 60) : null,
      bedTemp: printerData.temperature && printerData.temperature.bed ? printerData.temperature.bed : null,
      nozzleTemp: printerData.temperature && printerData.temperature.tool0 ? printerData.temperature.tool0 : null,
      lastUpdated: Date.now()
    };
  } catch (e) {
    clearTimeout(timeout);
    return { platform: 'octoprint', connected: false, state: 'Offline' };
  }
}

const MOONRAKER_STATE_LABELS = {
  standby: 'Idle', printing: 'Printing', paused: 'Paused',
  complete: 'Finished', error: 'Error', cancelled: 'Cancelled'
};

async function moonrakerStatus(cfg) {
  if (!cfg || !cfg.host) return { platform: 'moonraker', connected: false, state: 'Not configured' };
  const proto = cfg.https ? 'https' : 'http';
  const base = `${proto}://${cfg.host}:${cfg.port || 80}`;
  const headers = cfg.apiKey ? { 'X-Api-Key': cfg.apiKey } : {};
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${base}/printer/objects/query?print_stats&virtual_sdcard&extruder&heater_bed`, { headers, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return { platform: 'moonraker', connected: false, state: `HTTP ${res.status}` };

    const data = await res.json();
    const status = data.result.status;
    const ps = status.print_stats || {};
    const vsd = status.virtual_sdcard || {};
    const progress = vsd.progress != null ? Math.round(vsd.progress * 100) : null;

    let timeRemainingMin = null;
    if (ps.state === 'printing' && ps.filename) {
      let estimatedTotal = null;
      try {
        const metaController = new AbortController();
        const metaTimeout = setTimeout(() => metaController.abort(), 4000);
        const metaRes = await fetch(`${base}/server/files/metadata?filename=${encodeURIComponent(ps.filename)}`, { headers, signal: metaController.signal });
        clearTimeout(metaTimeout);
        if (metaRes.ok) {
          const meta = await metaRes.json();
          estimatedTotal = meta.result && meta.result.estimated_time;
        }
      } catch (e) {}
      if (estimatedTotal) {
        timeRemainingMin = Math.max(0, Math.round((estimatedTotal - ps.print_duration) / 60));
      } else if (progress > 0) {
        timeRemainingMin = Math.max(0, Math.round((ps.print_duration / (progress / 100) - ps.print_duration) / 60));
      }
    }

    return {
      platform: 'moonraker',
      connected: true,
      state: MOONRAKER_STATE_LABELS[ps.state] || ps.state || 'Unknown',
      fileName: ps.filename || null,
      progress,
      timeRemainingMin,
      bedTemp: status.heater_bed ? { actual: status.heater_bed.temperature, target: status.heater_bed.target } : null,
      nozzleTemp: status.extruder ? { actual: status.extruder.temperature, target: status.extruder.target } : null,
      lastUpdated: Date.now()
    };
  } catch (e) {
    clearTimeout(timeout);
    return { platform: 'moonraker', connected: false, state: 'Offline' };
  }
}

app.post('/api/printer-status', async (req, res) => {
  const list = req.body || [];

  const activeBambuIds = new Set(list.filter(p => p.platform === 'bambu').map(p => p.id));
  for (const [id, entry] of bambuClients) {
    if (!activeBambuIds.has(id)) { try { entry.client.end(true); } catch (e) {} bambuClients.delete(id); }
  }

  const results = {};
  await Promise.all(list.map(async (p) => {
    if (p.platform === 'bambu') results[p.id] = bambuStatus(p.id, p.bambu);
    else if (p.platform === 'octoprint') results[p.id] = await octoprintStatus(p.octoprint);
    else if (p.platform === 'moonraker') results[p.id] = await moonrakerStatus(p.moonraker);
    else results[p.id] = { platform: null, connected: false, state: 'Not configured' };
  }));
  res.json(results);
});

app.post('/api/ha-states', async (req, res) => {
  const { entityIds, ha } = req.body || {};
  if (!ha || !ha.baseUrl || !ha.token) return res.json({ error: 'Not configured' });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const base = ha.baseUrl.replace(/\/$/, '');
    const r = await fetch(`${base}/api/states`, {
      headers: { Authorization: `Bearer ${ha.token}` },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!r.ok) return res.json({ error: `HTTP ${r.status}` });

    const all = await r.json();
    const byId = {};
    for (const e of all) byId[e.entity_id] = e;

    const data = {};
    for (const id of (entityIds || [])) {
      const e = byId[id];
      data[id] = e ? {
        state: e.state,
        unit: (e.attributes && e.attributes.unit_of_measurement) || '',
        friendlyName: (e.attributes && e.attributes.friendly_name) || id
      } : null;
    }
    res.json({ data });
  } catch (e) {
    clearTimeout(timeout);
    res.json({ error: 'Offline' });
  }
});

// Fetches consignment_data.json from a self-signed-HTTPS local server (same
// pattern as Bambu LAN mode: rejectUnauthorized:false to accept the cert).
function fetchJsonInsecure(jsonUrl) {
  return new Promise((resolve, reject) => {
    const req = https.get(jsonUrl, { rejectUnauthorized: false, timeout: 6000 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });
}

app.post('/api/consignment', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.json({ error: 'Not configured' });
  try {
    const jsonUrl = new URL('consignment_data.json', url).toString();
    const data = await fetchJsonInsecure(jsonUrl);
    res.json({ data });
  } catch (e) {
    res.json({ error: e.message || 'Offline' });
  }
});

function shutdown() {
  for (const [, entry] of bambuClients) {
    try { entry.client.end(true); } catch (e) {}
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

writeBackup(loadData());

app.listen(PORT, '0.0.0.0', () => {
  const addrs = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  console.log('\n3dWorks Online Dashboard server running!');
  console.log(`On this Mac:      http://localhost:${PORT}`);
  addrs.forEach(a => console.log(`On your network:  http://${a}:${PORT}`));
  console.log('\nOpen the network URL on your iPhone/iPad (same WiFi), then Share -> Add to Home Screen.\n');
});
