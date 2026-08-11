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
// کلید API هاگینگ‌فیس برای ساخت واقعی عکس — از hf.co/settings/tokens بگیر و به
// عنوان Environment Variable با نام HF_API_KEY توی Render ست کن
const HF_API_KEY = process.env.HF_API_KEY || '';
const HF_IMAGE_MODEL = process.env.HF_IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell';
// چون یه مدل واقعی داریم ولی توی اپ ۴ تا "مدل" برای انتخاب گذاشتیم، هرکدوم
// یه سبک متفاوت رو به پرامپت اضافه می‌کنن (به‌جای اینکه هرکدوم مدل جدا باشن)
const MODEL_STYLE_SUFFIX = {
  nova: '',
  pulsar: ', highly detailed, sharp focus, intricate details, 8k',
  quasar: ', vibrant colorful digital art style, bold colors',
  nebula: ', photorealistic, cinematic lighting, dramatic atmosphere',
};

/* ============================================================
   لایه‌ی ساخت عکس — چند سرویس رو پشتیبانی می‌کنه، خودش تشخیص میده
   کدوم کلید API رو گذاشتی و از همون استفاده می‌کنه. کافیه فقط
   یکی از این کلیدها رو توی Environment Variables بذاری:

     HF_API_KEY          → Hugging Face  (hf.co/settings/tokens)
     FAL_KEY              → fal.ai        (fal.ai/dashboard/keys)
     STABILITY_API_KEY    → Stability AI  (platform.stability.ai)
     OPENAI_API_KEY        → OpenAI        (platform.openai.com)

   اگه چندتاشون رو باهم گذاشتی، با IMAGE_PROVIDER می‌تونی مشخص کنی
   کدومو ترجیح میدی (مقادیر: huggingface | fal | stability | openai)
   ============================================================ */
class ProviderError extends Error {
  constructor(status, detail) {
    super(typeof detail === 'string' ? detail : JSON.stringify(detail));
    this.status = status;
    this.detail = detail;
  }
}
async function safeErrorInfo(res) {
  try {
    const j = await res.json();
    return j.error?.message || j.error || j.message || JSON.stringify(j);
  } catch (e) {
    try {
      return await res.text();
    } catch (e2) {
      return 'unknown_error';
    }
  }
}

async function generateWithHuggingFace(prompt) {
  const res = await fetch(`https://api-inference.huggingface.co/models/${HF_IMAGE_MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HF_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: prompt }),
  });
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok || !contentType.startsWith('image/')) {
    throw new ProviderError(res.status, await safeErrorInfo(res));
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

async function generateWithFal(prompt) {
  const model = process.env.FAL_IMAGE_MODEL || 'fal-ai/flux/schnell';
  const res = await fetch(`https://fal.run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) throw new ProviderError(res.status, await safeErrorInfo(res));
  const data = await res.json();
  const url = data?.images?.[0]?.url;
  if (!url) throw new ProviderError(502, 'no_image_in_response');
  return url;
}

async function generateWithStability(prompt) {
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('output_format', 'jpeg');
  const res = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.STABILITY_API_KEY}`, Accept: 'image/*' },
    body: form,
  });
  if (!res.ok) throw new ProviderError(res.status, await safeErrorInfo(res));
  const buffer = Buffer.from(await res.arrayBuffer());
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

async function generateWithOpenAI(prompt) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
      prompt,
      size: '1024x1024',
    }),
  });
  if (!res.ok) throw new ProviderError(res.status, await safeErrorInfo(res));
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  const url = data?.data?.[0]?.url;
  if (b64) return `data:image/png;base64,${b64}`;
  if (url) return url;
  throw new ProviderError(502, 'no_image_in_response');
}

async function generateWithGemini(prompt) {
  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  const apiKey = process.env.GEMINI_API_KEY;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'] },
      }),
    }
  );
  if (!res.ok) throw new ProviderError(res.status, await safeErrorInfo(res));
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData);
  if (!imgPart) throw new ProviderError(502, 'no_image_in_response');
  const mime = imgPart.inlineData.mimeType || 'image/png';
  return `data:${mime};base64,${imgPart.inlineData.data}`;
}

const IMAGE_PROVIDERS = {
  huggingface: generateWithHuggingFace,
  gemini: generateWithGemini,
  fal: generateWithFal,
  stability: generateWithStability,
  openai: generateWithOpenAI,
};

function detectImageProvider() {
  const forced = (process.env.IMAGE_PROVIDER || '').toLowerCase();
  if (forced && IMAGE_PROVIDERS[forced]) return forced;
  if (HF_API_KEY) return 'huggingface';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.FAL_KEY) return 'fal';
  if (process.env.STABILITY_API_KEY) return 'stability';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return null;
}

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

// ---- Generate an image (real generation — auto-detects whichever provider key is set) ----
app.post('/api/generate', requireDevice, async (req, res) => {
  const db = loadDB();
  const d = getDevice(db, req.deviceId);
  const sub = isSubscribed(d);
  if (!sub && d.count >= FREE_DAILY_LIMIT) {
    saveDB(db);
    return res.status(403).json({ error: 'quota_exceeded' });
  }
  const providerName = detectImageProvider();
  if (!providerName) {
    saveDB(db);
    return res.status(500).json({ error: 'server_not_configured' });
  }
  const promptRaw = String(req.body.prompt || '').slice(0, 500).trim();
  if (!promptRaw) return res.status(400).json({ error: 'missing_prompt' });
  const model = typeof req.body.model === 'string' ? req.body.model : 'nova';
  const prompt = promptRaw + (MODEL_STYLE_SUFFIX[model] || '');

  try {
    const image = await IMAGE_PROVIDERS[providerName](prompt);
    if (!sub) d.count += 1;
    saveDB(db);
    res.json({ ok: true, image, used: d.count, subscribed: sub, provider: providerName });
  } catch (e) {
    console.error(`[${providerName}] image generation error:`, e.status, e.detail || e.message);
    saveDB(db);
    if (e.status === 503) return res.status(503).json({ error: 'model_loading', detail: e.detail });
    return res.status(502).json({ error: 'ai_error', detail: e.detail || e.message });
  }
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

// ---- Debug: which image provider (and chat) did the server detect? ----
app.get('/api/status', (req, res) => {
  res.json({
    imageProvider: detectImageProvider(),
    chatConfigured: !!ANTHROPIC_API_KEY,
    keysDetected: {
      HF_API_KEY: !!HF_API_KEY,
      GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
      FAL_KEY: !!process.env.FAL_KEY,
      STABILITY_API_KEY: !!process.env.STABILITY_API_KEY,
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: !!ANTHROPIC_API_KEY,
    },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Artemis server running on port ' + PORT));
