const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const FREE_DAILY_LIMIT = 5;
const CHAT_DAILY_LIMIT = 10;
// رمز پنل مدیریت — حتماً قبل از دیپلوی روی Render، این مقدار رو به عنوان
// Environment Variable با نام ADMIN_PASSWORD ست کن (توضیح کامل در README.md هست)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
// کلید API آنتروپیک برای بخش چت — از console.anthropic.com بگیر و به عنوان
// Environment Variable با نام ANTHROPIC_API_KEY توی Render ست کن
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CHAT_MODEL = process.env.ANTHROPIC_CHAT_MODEL || 'claude-haiku-4-5-20251001';

function loadDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ devices: {}, codes: {} }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function getDevice(db, id) {
  if (!db.devices[id]) {
    db.devices[id] = { date: todayStr(), count: 0, chatDate: todayStr(), chatCount: 0, subExpiry: null };
  }
  const d = db.devices[id];
  if (d.date !== todayStr()) {
    d.date = todayStr();
    d.count = 0;
  }
  if (d.chatDate !== todayStr()) {
    d.chatDate = todayStr();
    d.chatCount = 0;
  }
  if (typeof d.chatCount !== 'number') d.chatCount = 0;
  return d;
}
function isSubscribed(d) {
  return !!d.subExpiry && new Date(d.subExpiry).getTime() > Date.now();
}
function requireDevice(req, res, next) {
  const id = req.headers['x-device-id'];
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'missing_device_id' });
  req.deviceId = id;
  next();
}
function requireAdmin(req, res, next) {
  const pass = req.headers['x-admin-password'];
  if (pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ---- Quota status ----
app.get('/api/quota', requireDevice, (req, res) => {
  const db = loadDB();
  const d = getDevice(db, req.deviceId);
  saveDB(db);
  res.json({ used: d.count, limit: FREE_DAILY_LIMIT, subscribed: isSubscribed(d), subExpiry: d.subExpiry });
});

// ---- Consume one generation (image mode only) ----
app.post('/api/generate', requireDevice, (req, res) => {
  const db = loadDB();
  const d = getDevice(db, req.deviceId);
  const sub = isSubscribed(d);
  if (!sub && d.count >= FREE_DAILY_LIMIT) {
    saveDB(db);
    return res.status(403).json({ error: 'quota_exceeded' });
  }
  if (!sub) d.count += 1;
  saveDB(db);
  res.json({ ok: true, used: d.count, subscribed: sub });
});

// ---- Redeem a subscription code ----
app.post('/api/redeem', requireDevice, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'missing_code' });
  const db = loadDB();
  const c = db.codes[code];
  if (!c || c.used) return res.status(400).json({ error: 'invalid_code' });
  const d = getDevice(db, req.deviceId);
  const base = isSubscribed(d) ? new Date(d.subExpiry) : new Date();
  base.setDate(base.getDate() + c.days);
  d.subExpiry = base.toISOString();
  c.used = true;
  c.usedBy = req.deviceId;
  c.usedAt = new Date().toISOString();
  saveDB(db);
  res.json({ ok: true, subExpiry: d.subExpiry });
});

// ---- Chat quota status ----
app.get('/api/chat-quota', requireDevice, (req, res) => {
  const db = loadDB();
  const d = getDevice(db, req.deviceId);
  saveDB(db);
  res.json({ used: d.chatCount, limit: CHAT_DAILY_LIMIT, subscribed: isSubscribed(d) });
});

// ---- Chat with AI (proxied to Anthropic API, key stays server-side) ----
app.post('/api/chat', requireDevice, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'server_not_configured' });
  }
  const db = loadDB();
  const d = getDevice(db, req.deviceId);
  const sub = isSubscribed(d);
  if (!sub && d.chatCount >= CHAT_DAILY_LIMIT) {
    saveDB(db);
    return res.status(403).json({ error: 'chat_quota_exceeded' });
  }

  const incoming = Array.isArray(req.body.messages) ? req.body.messages : [];
  const messages = incoming
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20);
  if (messages.length === 0) return res.status(400).json({ error: 'missing_messages' });

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        max_tokens: 800,
        system:
          'You are the AI assistant inside Artemis, a rocket-themed Persian-language creative app. ' +
          'Reply in the same language the user writes in (Persian or English). Keep answers clear, friendly, and reasonably concise.',
        messages,
      }),
    });
    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('Anthropic API error:', apiRes.status, errText);
      saveDB(db);
      return res.status(502).json({ error: 'ai_error' });
    }
    const data = await apiRes.json();
    const reply = (data.content || []).map(b => b.text || '').join('');
    if (!sub) d.chatCount += 1;
    saveDB(db);
    res.json({ reply, used: d.chatCount, subscribed: sub });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---- Admin: generate a new code ----
app.post('/api/admin/codes', requireAdmin, (req, res) => {
  const plan = req.body.plan === '3m' ? '3m' : '1m';
  const days = plan === '3m' ? 90 : 30;
  const code = 'ARTEMIS-' + plan.toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const db = loadDB();
  db.codes[code] = { plan, days, used: false, createdAt: new Date().toISOString() };
  saveDB(db);
  res.json({ code, days });
});

// ---- Admin: list all codes ----
app.get('/api/admin/codes', requireAdmin, (req, res) => {
  const db = loadDB();
  res.json(db.codes);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Artemis server running on port ' + PORT));
