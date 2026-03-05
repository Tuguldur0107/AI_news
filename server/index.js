const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const RSSParser = require('rss-parser');

const app = express();
const PORT = process.env.PORT || 3000;
const rssParser = new RSSParser();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
  methods: ['GET', 'POST'],
}));

app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Хэт олон хүсэлт. 15 минутын дараа дахин оролдоно уу.' },
});

app.use('/api/', limiter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Server-side cache ───────────────────────────────────────────
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MIN || '600', 10) * 60 * 1000;
const newsCache = {
  google:  { data: null, timestamp: 0 },
  newsapi: { data: null, timestamp: 0 },
  gnews:   { data: null, timestamp: 0 },
  iot:     { data: null, timestamp: 0 },
  rfid:    { data: null, timestamp: 0 },
};

function isCacheFresh(source) {
  const cache = newsCache[source];
  return cache.data && cache.data.news && cache.data.news.length > 0 && (Date.now() - cache.timestamp < CACHE_TTL);
}

// ── Shared: Gemini translate helper ──────────────────────────────
const TOPIC_CATEGORIES = {
  ai:   '"model", "research", "business", "safety", "tools"',
  iot:  '"hardware", "connectivity", "industry", "security", "platform"',
  rfid: '"hardware", "retail", "logistics", "healthcare", "standard"',
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
  };
  const topicMap = { google: 'ai', newsapi: 'ai', gnews: 'ai', iot: 'iot', rfid: 'rfid' };
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
    const results = await Promise.all([
      fetchAndCache('google'),
      fetchAndCache('newsapi'),
      fetchAndCache('gnews'),
      fetchAndCache('iot'),
      fetchAndCache('rfid'),
    ]);

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

// ── Return cached data only (no fetching) ──────────────────────
app.get('/api/news/cached', (req, res) => {
  const response_data = {
    timestamp: new Date().toISOString(),
    cacheTTL: CACHE_TTL / 60000,
  };

  for (const source of ['google', 'newsapi', 'gnews', 'iot', 'rfid']) {
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

app.listen(PORT, () => {
  console.log(`AI PULSE server → http://localhost:${PORT}`);
  console.log(`Cache TTL: ${CACHE_TTL / 60000} minutes`);
});
