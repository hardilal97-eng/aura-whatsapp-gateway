import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';

const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.API_KEY || '';
const DATA_DIR = process.env.SESSION_PATH || '/app/data/auth';
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

fs.mkdirSync(DATA_DIR, { recursive: true });

let sock = null;
let connectionState = 'starting';
let latestQr = null;
let qrDataUrl = null;
let connectedUser = null;
let reconnectTimer = null;

function normalizePhone(value = '') {
  let digits = String(value).replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '62' + digits.slice(1);
  return digits;
}

function authorized(req) {
  if (!API_KEY) return true;
  const header = req.get('x-api-key');
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return header === API_KEY || bearer === API_KEY || req.query.key === API_KEY;
}

async function startWhatsApp() {
  try {
    connectionState = 'connecting';
    const { state, saveCreds } = await useMultiFileAuthState(DATA_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['AURA Supply Chain', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQr = qr;
        qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 420 });
        connectionState = 'qr_required';
      }

      if (connection === 'open') {
        connectionState = 'connected';
        latestQr = null;
        qrDataUrl = null;
        connectedUser = sock?.user || null;
        console.log('WhatsApp connected:', connectedUser?.id || 'unknown');
      }

      if (connection === 'close') {
        connectedUser = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        connectionState = loggedOut ? 'logged_out' : 'disconnected';
        console.log('WhatsApp disconnected. code=', statusCode, 'loggedOut=', loggedOut);

        if (!loggedOut) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(startWhatsApp, 5000);
        }
      }
    });
  } catch (err) {
    connectionState = 'error';
    console.error('WhatsApp start error:', err?.message || err);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(startWhatsApp, 10000);
  }
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => {
  const qrBlock = qrDataUrl
    ? `<img src="${qrDataUrl}" style="width:min(420px,90vw);border-radius:16px;background:#fff;padding:12px" alt="WhatsApp QR">`
    : '<div class="empty">QR belum tersedia. Refresh beberapa detik lagi.</div>';
  const connected = connectionState === 'connected';
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AURA WhatsApp Gateway</title>
<style>
body{margin:0;background:#111713;color:#edf3ee;font-family:Georgia,serif;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}
.card{width:min(760px,100%);background:#1b241e;border:1px solid #344338;border-radius:22px;padding:28px;box-sizing:border-box;box-shadow:0 20px 60px #0006}
h1{margin:0 0 8px;font-size:30px}.muted{color:#9fb0a3}.status{display:inline-block;padding:8px 12px;border-radius:999px;background:${connected?'#174d2b':'#4c3717'};margin:14px 0 22px;font-family:system-ui,sans-serif;font-weight:700}.qr{text-align:center;padding:22px;background:#141a16;border-radius:18px}.empty{padding:42px 10px;color:#9fb0a3}.note{font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;margin-top:18px;color:#b9c7bc}code{background:#111713;padding:2px 6px;border-radius:6px}
</style></head><body><main class="card"><h1>AURA WhatsApp Gateway</h1><div class="muted">Agrinesia Utility Reporting Alert</div><div class="status">${connectionState.toUpperCase()}</div><div class="qr">${qrBlock}</div><div class="note">Jika QR tampil: WhatsApp → Perangkat tertaut → Tautkan perangkat → scan QR. API health: <code>/health</code>.</div></main></body></html>`);
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'aura-whatsapp-gateway', whatsapp: connectionState }));

app.get('/status', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  res.json({ ok: true, state: connectionState, connected: connectionState === 'connected', user: connectedUser });
});

app.get('/qr', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  res.json({ ok: true, state: connectionState, qr: qrDataUrl });
});

app.post('/api/send', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!sock || connectionState !== 'connected') return res.status(503).json({ ok: false, error: 'whatsapp_not_connected' });
  const phone = normalizePhone(req.body?.phone || req.body?.to);
  const message = String(req.body?.message || '').trim();
  if (!phone || !message) return res.status(400).json({ ok: false, error: 'phone_and_message_required' });
  try {
    const jid = `${phone}@s.whatsapp.net`;
    const result = await sock.sendMessage(jid, { text: message });
    res.json({ ok: true, jid, id: result?.key?.id || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'send_failed' });
  }
});

app.get('/api/groups', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!sock || connectionState !== 'connected') return res.status(503).json({ ok: false, error: 'whatsapp_not_connected' });
  try {
    const groups = await sock.groupFetchAllParticipating();
    const list = Object.values(groups).map(g => ({ id: g.id, subject: g.subject, participants: g.participants?.length || 0 }));
    res.json({ ok: true, groups: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'group_fetch_failed' });
  }
});

app.post('/api/send-group', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!sock || connectionState !== 'connected') return res.status(503).json({ ok: false, error: 'whatsapp_not_connected' });
  const groupId = String(req.body?.groupId || req.body?.to || '').trim();
  const message = String(req.body?.message || '').trim();
  if (!groupId || !message) return res.status(400).json({ ok: false, error: 'groupId_and_message_required' });
  try {
    const jid = groupId.endsWith('@g.us') ? groupId : `${groupId}@g.us`;
    const result = await sock.sendMessage(jid, { text: message });
    res.json({ ok: true, jid, id: result?.key?.id || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'send_group_failed' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AURA WhatsApp Gateway listening on port ${PORT}`);
  startWhatsApp();
});
