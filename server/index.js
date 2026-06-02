const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const RSSParser = require('rss-parser');
const webpush = require('web-push');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const rssParser = new RSSParser();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
  methods: ['GET', 'POST'],
}));

app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Хэт олон хүсэлт. 15 минутын дараа дахин оролдоно уу.' },
});

app.use('/api/', limiter);

// ── Web Push (VAPID) ─────────────────────────────────────────────
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_CONTACT     = process.env.VAPID_CONTACT || 'mailto:admin@ainews.app';

let pushEnabled = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  pushEnabled = true;
} else {
  console.warn('⚠ VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY тохируулаагүй — push notification идэвхгүй.');
}

// ── Persistent subscription storage ─────────────────────────────
// Each entry: { sub: PushSubscription, lastNotified: Set<articleKey> }
// Storage path can be overridden via DATA_DIR (Railway volume mount recommended)
const DATA_DIR = process.env.DATA_DIR || __dirname;
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const subscriptions = new Map();

function loadSubscriptions() {
  try {
    if (fs.existsSync(SUBS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
      for (const [endpoint, entry] of Object.entries(raw)) {
        subscriptions.set(endpoint, {
          sub: entry.sub,
          lastNotified: new Set(entry.lastNotified || []),
        });
      }
      console.log(`Loaded ${subscriptions.size} push subscriptions from disk`);
    }
  } catch (err) {
    console.error('Failed to load subscriptions:', err.message);
  }
}

let saveTimer = null;
function saveSubscriptions() {
  // Debounce writes — multiple changes within 2s collapse to one write
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const out = {};
      for (const [endpoint, entry] of subscriptions) {
        // Cap remembered article keys per subscription to avoid unbounded growth
        const recent = Array.from(entry.lastNotified).slice(-200);
        out[endpoint] = { sub: entry.sub, lastNotified: recent };
      }
      fs.writeFileSync(SUBS_FILE, JSON.stringify(out), 'utf8');
    } catch (err) {
      console.error('Failed to save subscriptions:', err.message);
    }
  }, 2000);
}

loadSubscriptions();

app.get('/api/vapid-public-key', (req, res) => {
  if (!pushEnabled) return res.status(503).json({ error: 'Push disabled (VAPID keys not configured)' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', (req, res) => {
  if (!pushEnabled) return res.status(503).json({ error: 'Push disabled' });
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  // Preserve lastNotified if subscription already exists (re-subscribe on page load)
  const existing = subscriptions.get(sub.endpoint);
  subscriptions.set(sub.endpoint, {
    sub,
    lastNotified: existing?.lastNotified || new Set(),
  });
  saveSubscriptions();
  res.json({ success: true });
});

function articleKey(article) {
  // Stable hash key from title + url for de-dup
  const base = (article.title || '') + '|' + (article.url || '');
  return base.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
}

async function sendPushIfNew(article) {
  if (!pushEnabled || subscriptions.size === 0) return;
  const key = articleKey(article);
  if (!key) return;

  const payload = JSON.stringify({
    title: 'AI PULSE — Шинэ мэдээ',
    body: article.title,
    url: article.url || '/',
  });

  const dead = [];
  let anyChanged = false;
  for (const [endpoint, entry] of subscriptions) {
    if (entry.lastNotified.has(key)) continue;
    try {
      await webpush.sendNotification(entry.sub, payload);
      entry.lastNotified.add(key);
      anyChanged = true;
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        dead.push(endpoint);
      } else {
        console.warn('Push failed for one endpoint:', err.message);
      }
    }
  }
  for (const e of dead) subscriptions.delete(e);
  if (anyChanged || dead.length) saveSubscriptions();
}

app.get('/health', (req, res) => {
  const sourceHealth = {};
  for (const src of ALL_SOURCES) {
    const c = newsCache[src];
    sourceHealth[src] = {
      hasData: !!c?.data,
      count: c?.data?.news?.length || 0,
      ageMin: c?.timestamp ? Math.floor((Date.now() - c.timestamp) / 60000) : null,
    };
  }
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    env: {
      gemini: !!process.env.GEMINI_API_KEY,
      newsapi: !!process.env.NEWSAPI_KEY,
      gnews: !!process.env.GNEWS_KEY,
      vapid: pushEnabled,
    },
    push: { enabled: pushEnabled, subscribers: subscriptions.size },
    sources: sourceHealth,
  });
});

// ── Server-side cache ───────────────────────────────────────────
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MIN || '600', 10) * 60 * 1000;
const newsCache = {
  google:  { data: null, timestamp: 0 },
  newsapi: { data: null, timestamp: 0 },
  gnews:   { data: null, timestamp: 0 },
  iot:     { data: null, timestamp: 0 },
  rfid:    { data: null, timestamp: 0 },
  dev:     { data: null, timestamp: 0 },
};

const ALL_SOURCES = ['google', 'newsapi', 'gnews', 'iot', 'rfid', 'dev'];

function isCacheFresh(source) {
  const cache = newsCache[source];
  return cache.data && cache.data.news && cache.data.news.length > 0 && (Date.now() - cache.timestamp < CACHE_TTL);
}

// ── Shared: Gemini translate helper ──────────────────────────────
const TOPIC_CATEGORIES = {
  ai:   '"model", "research", "business", "safety", "tools"',
  iot:  '"hardware", "connectivity", "industry", "security", "platform"',
  rfid: '"hardware", "retail", "logistics", "healthcare", "standard"',
  dev:  '"agent", "rag", "llm", "vlm", "tooling", "skill"',
};

async function translateWithGemini(articles, topic = 'ai') {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY тохируулаагүй');

  const categories = TOPIC_CATEGORIES[topic] || TOPIC_CATEGORIES.ai;

  const articleList = articles.map((a, i) =>
    `${i + 1}. ${a.title} [${a.source || ''}] URL:${a.url || ''}`
  ).join('\n');

  const prompt = `Англи ${topic.toUpperCase()} мэдээг монголоор орчуул. JSON хариулна уу.

${articleList}

{"news":[{"id":1,"title":"Монгол гарчиг","summary":"2-3 өгүүлбэр","detail":"3-4 өгүүлбэр","category":"...","source":"Source Name","url":"URL хэвээр","importance":8,"featured":false,"timeAgo":"2 цагийн өмнө"}]}

ЗААВАЛ: category нь ЗӨВХӨН нэг утга авна: ${categories}. Хэзээ ч "|" тэмдэг бүү ашигла.
featured=true зөвхөн 2-т. url хэвээр хадгал.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 16384,
          responseMimeType: 'application/json',
        },
      }),
    }
  );

  clearTimeout(timeout);

  if (!response.ok) {
    const errText = await response.text();
    let errMsg;
    try { errMsg = JSON.parse(errText).error?.message; } catch(e) { errMsg = errText; }
    throw new Error(errMsg || `Gemini API алдаа: ${response.status}`);
  }

  const rawText = await response.text();
  let data;
  try { data = JSON.parse(rawText); } catch(e) {
    console.error('Gemini raw:', rawText.slice(0, 300));
    throw new Error('Gemini хариуг parse хийж чадсангүй');
  }

  const candidate = data.candidates?.[0];
  if (!candidate?.content?.parts?.[0]?.text) {
    console.error('Gemini response:', JSON.stringify(data).slice(0, 300));
    throw new Error('Gemini хариу хоосон');
  }

  const text = candidate.content.parts[0].text;
  const clean = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch(e) {
    console.error('Gemini JSON parse fail:', clean.slice(0, 500));
    throw new Error('Gemini JSON формат буруу: ' + clean.slice(0, 100));
  }
}

// ── Source fetchers (return raw English articles) ────────────────
async function fetchGoogleArticles() {
  const feed = await rssParser.parseURL(
    'https://news.google.com/rss/search?q=artificial+intelligence&hl=en-US&gl=US&ceid=US:en'
  );
  return feed.items.slice(0, 6).map(item => {
    const parts = (item.title || '').split(' - ');
    const source = parts.length > 1 ? parts.pop().trim() : 'Google News';
    const title = parts.join(' - ').trim();
    return { title, summary: item.contentSnippet || item.content || title, source, url: item.link || '', published: item.pubDate || '' };
  });
}

async function fetchNewsapiArticles() {
  const apiKey = process.env.NEWSAPI_KEY;
  if (!apiKey) throw new Error('NEWSAPI_KEY тохируулаагүй');
  const response = await fetch(
    `https://newsapi.org/v2/everything?q=%22artificial+intelligence%22+OR+%22AI+model%22+OR+%22machine+learning%22+OR+%22GPT%22+OR+%22LLM%22&sortBy=publishedAt&language=en&pageSize=10`,
    { headers: { 'X-Api-Key': apiKey } }
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || `NewsAPI алдаа: ${response.status}`);
  }
  const data = await response.json();
  return (data.articles || []).slice(0, 6).map(a => ({
    title: a.title || '', summary: a.description || '', source: a.source?.name || '', url: a.url || '', published: a.publishedAt || '',
  }));
}

async function fetchIoTArticles() {
  const feed = await rssParser.parseURL(
    'https://news.google.com/rss/search?q=IoT+Internet+of+Things+smart+device&hl=en-US&gl=US&ceid=US:en'
  );
  return feed.items.slice(0, 8).map(item => {
    const parts = (item.title || '').split(' - ');
    const source = parts.length > 1 ? parts.pop().trim() : 'Google News';
    const title = parts.join(' - ').trim();
    return { title, summary: item.contentSnippet || item.content || title, source, url: item.link || '', published: item.pubDate || '' };
  });
}

async function fetchRFIDArticles() {
  const feed = await rssParser.parseURL(
    'https://news.google.com/rss/search?q=RFID+technology+tracking+tag&hl=en-US&gl=US&ceid=US:en'
  );
  return feed.items.slice(0, 8).map(item => {
    const parts = (item.title || '').split(' - ');
    const source = parts.length > 1 ? parts.pop().trim() : 'Google News';
    const title = parts.join(' - ').trim();
    return { title, summary: item.contentSnippet || item.content || title, source, url: item.link || '', published: item.pubDate || '' };
  });
}

// DEV: combine multiple developer-focused sources
const DEV_FEEDS = [
  {
    name: 'HackerNews',
    url: 'https://hnrss.org/newest?q=Claude+OR+LLM+OR+RAG+OR+%22AI+agent%22+OR+VLM+OR+MCP&count=20',
  },
  {
    name: 'HuggingFace',
    url: 'https://huggingface.co/blog/feed.xml',
  },
  {
    name: 'Dev.to',
    url: 'https://dev.to/feed/tag/ai',
  },
  {
    name: 'GoogleNews-AI-Dev',
    url: 'https://news.google.com/rss/search?q=%22Claude+AI%22+OR+%22Anthropic%22+OR+%22LangChain%22+OR+%22Retrieval+Augmented%22+OR+%22AI+agent%22+OR+%22large+language+model%22+OR+%22vision+language+model%22&hl=en-US&gl=US&ceid=US:en',
  },
];

async function fetchDevArticles() {
  const results = await Promise.allSettled(
    DEV_FEEDS.map(async (feed) => {
      const parsed = await rssParser.parseURL(feed.url);
      return parsed.items.slice(0, 5).map((item) => {
        // Google News titles have " - Source" suffix; strip it
        let title = item.title || '';
        let source = feed.name;
        if (feed.name === 'GoogleNews-AI-Dev') {
          const parts = title.split(' - ');
          if (parts.length > 1) {
            source = parts.pop().trim();
            title = parts.join(' - ').trim();
          }
        }
        return {
          title,
          summary: item.contentSnippet || item.content || title,
          source,
          url: item.link || '',
          published: item.pubDate || '',
        };
      });
    })
  );

  // Flatten + dedupe by normalized title prefix
  const seen = new Set();
  const merged = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      const key = (item.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
      if (key && !seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }
  }

  // Return top 10 (limit to keep Gemini token budget reasonable)
  return merged.slice(0, 10);
}

async function fetchGnewsArticles() {
  const apiKey = process.env.GNEWS_KEY;
  if (!apiKey) throw new Error('GNEWS_KEY тохируулаагүй');
  const response = await fetch(
    `https://gnews.io/api/v4/search?q=%22artificial+intelligence%22+OR+%22AI+model%22+OR+%22machine+learning%22&lang=en&max=8&apikey=${apiKey}`
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.errors?.[0] || `GNews алдаа: ${response.status}`);
  }
  const data = await response.json();
  return (data.articles || []).slice(0, 6).map(a => ({
    title: a.title || '', summary: a.description || '', source: a.source?.name || '', url: a.url || '', published: a.publishedAt || '',
  }));
}

// ── Fetch + translate one source (with cache) ───────────────────
async function fetchAndCache(source) {
  if (isCacheFresh(source)) {
    return { source, data: newsCache[source].data, cached: true };
  }

  const fetchers = {
    google: fetchGoogleArticles,
    newsapi: fetchNewsapiArticles,
    gnews: fetchGnewsArticles,
    iot: fetchIoTArticles,
    rfid: fetchRFIDArticles,
    dev: fetchDevArticles,
  };
  const topicMap = { google: 'ai', newsapi: 'ai', gnews: 'ai', iot: 'iot', rfid: 'rfid', dev: 'dev' };
  try {
    const articles = await fetchers[source]();
    const translated = await translateWithGemini(articles, topicMap[source]);
    // Only cache if we got actual results
    if (translated?.news?.length > 0) {
      newsCache[source] = { data: translated, timestamp: Date.now() };
    }
    return { source, data: translated, cached: false };
  } catch (err) {
    // If fetch fails but old cache exists, return stale cache
    if (newsCache[source].data) {
      return { source, data: newsCache[source].data, cached: true, error: err.message };
    }
    return { source, data: null, error: err.message };
  }
}

// ── Main endpoint: fetch ALL sources at once ────────────────────
app.post('/api/news/all', async (req, res) => {
  try {
    const results = await Promise.all(ALL_SOURCES.map(s => fetchAndCache(s)));

    const response_data = {
      timestamp: new Date().toISOString(),
      cacheTTL: CACHE_TTL / 60000,
    };

    for (const r of results) {
      response_data[r.source] = {
        news: r.data?.news || [],
        cached: r.cached || false,
        error: r.error || null,
      };
    }

    // Send push notification for the most important fresh article (per-subscriber de-dup)
    if (subscriptions.size > 0) {
      const freshItem = results
        .filter(r => !r.cached && r.data?.news?.length > 0)
        .flatMap(r => r.data.news)
        .sort((a, b) => (b.importance || 0) - (a.importance || 0))[0];

      if (freshItem) {
        // Fire-and-forget; don't block the response
        sendPushIfNew(freshItem).catch(err => console.error('Push error:', err.message));
      }
    }

    res.json(response_data);
  } catch (err) {
    console.error('All news error:', err.message);
    res.status(500).json({ error: `Серверийн алдаа: ${err.message}` });
  }
});

// ── Individual endpoints (kept for backwards compat) ────────────
app.post('/api/news/google', async (req, res) => {
  try {
    const result = await fetchAndCache('google');
    if (result.data) return res.json(result.data);
    throw new Error(result.error);
  } catch (err) {
    console.error('Google News error:', err.message);
    res.status(500).json({ error: `Google News алдаа: ${err.message}` });
  }
});

app.post('/api/news/newsapi', async (req, res) => {
  try {
    const result = await fetchAndCache('newsapi');
    if (result.data) return res.json(result.data);
    throw new Error(result.error);
  } catch (err) {
    console.error('NewsAPI error:', err.message);
    res.status(500).json({ error: `NewsAPI алдаа: ${err.message}` });
  }
});

app.post('/api/news/gnews', async (req, res) => {
  try {
    const result = await fetchAndCache('gnews');
    if (result.data) return res.json(result.data);
    throw new Error(result.error);
  } catch (err) {
    console.error('GNews error:', err.message);
    res.status(500).json({ error: `GNews алдаа: ${err.message}` });
  }
});

app.post('/api/news/dev', async (req, res) => {
  try {
    const result = await fetchAndCache('dev');
    if (result.data) return res.json(result.data);
    throw new Error(result.error);
  } catch (err) {
    console.error('DEV error:', err.message);
    res.status(500).json({ error: `DEV алдаа: ${err.message}` });
  }
});

// ── Return cached data only (no fetching) ──────────────────────
app.get('/api/news/cached', (req, res) => {
  const response_data = {
    timestamp: new Date().toISOString(),
    cacheTTL: CACHE_TTL / 60000,
  };

  for (const source of ALL_SOURCES) {
    response_data[source] = {
      news: newsCache[source].data?.news || [],
      cached: true,
      age: newsCache[source].timestamp ? Math.floor((Date.now() - newsCache[source].timestamp) / 60000) : null,
    };
  }

  res.json(response_data);
});

// ── Cache status endpoint ───────────────────────────────────────
app.get('/api/cache-status', (req, res) => {
  const status = {};
  for (const [source, cache] of Object.entries(newsCache) ) {
    status[source] = {
      hasData: !!cache.data,
      fresh: isCacheFresh(source),
      age: cache.timestamp ? Math.floor((Date.now() - cache.timestamp) / 60000) : null,
      count: cache.data?.news?.length || 0,
    };
  }
  res.json({ cacheTTL: CACHE_TTL / 60000, sources: status });
});

// ── Background warm-up + auto-refresh ──────────────────────────
// Sequential fetch so we don't burst Gemini quota in parallel
async function warmCacheSequential(reason) {
  console.log(`[warm-up] start (${reason})`);
  for (const src of ALL_SOURCES) {
    if (isCacheFresh(src)) {
      console.log(`[warm-up] ${src}: skipped (fresh)`);
      continue;
    }
    try {
      const r = await fetchAndCache(src);
      const n = r.data?.news?.length || 0;
      console.log(`[warm-up] ${src}: ${n} items${r.error ? ' (err: ' + r.error + ')' : ''}`);
    } catch (err) {
      console.error(`[warm-up] ${src} failed:`, err.message);
    }
  }
  console.log('[warm-up] done');
}

app.listen(PORT, () => {
  console.log(`AI PULSE server → http://localhost:${PORT}`);
  console.log(`Cache TTL: ${CACHE_TTL / 60000} minutes`);

  // Warm up cache 10s after boot (let the platform stabilize first)
  setTimeout(() => warmCacheSequential('startup').catch(e => console.error('Warm-up error:', e.message)), 10_000);

  // Auto-refresh: re-warm every CACHE_TTL so cache never goes empty
  setInterval(() => warmCacheSequential('scheduled').catch(e => console.error('Auto-refresh error:', e.message)), CACHE_TTL);
});
