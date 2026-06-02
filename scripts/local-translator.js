// AI PULSE — local translator
// Runs on a personal machine, fetches RSS, translates with a local Ollama
// model, and pushes each batch to the Railway server's /api/news/ingest
// endpoint. Designed to be triggered by Windows Task Scheduler / cron.
//
// Quickstart:
//   1. cp .env.example .env  &&  edit .env
//   2. npm install
//   3. npm start           # all sources
//      npm test            # only the DEV source (fast smoke test)

const fs = require('fs');
const path = require('path');
const RSSParser = require('rss-parser');

// Load .env from script directory if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const RAILWAY_URL = process.env.RAILWAY_URL || 'https://ainews-production-9c46.up.railway.app';
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:14b';
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '180000', 10);

if (!INGEST_TOKEN) {
  console.error('FATAL: INGEST_TOKEN missing (set it in .env)');
  process.exit(1);
}

// Parse CLI override e.g. --source=dev
const cliSource = (process.argv.find(a => a.startsWith('--source=')) || '').split('=')[1];
const SOURCES_FILTER = cliSource
  ? [cliSource]
  : (process.env.SOURCES === 'all' || !process.env.SOURCES
      ? ['google', 'newsapi', 'gnews', 'iot', 'rfid', 'dev']
      : process.env.SOURCES.split(',').map(s => s.trim()).filter(Boolean));

const rssParser = new RSSParser();

// ── Categories per topic (kept in sync with server/index.js) ─────
const TOPIC_CATEGORIES = {
  ai:   '"model", "research", "business", "safety", "tools"',
  iot:  '"hardware", "connectivity", "industry", "security", "platform"',
  rfid: '"hardware", "retail", "logistics", "healthcare", "standard"',
  dev:  '"agent", "rag", "llm", "vlm", "tooling", "skill"',
};
const SOURCE_TOPIC = { google: 'ai', newsapi: 'ai', gnews: 'ai', iot: 'iot', rfid: 'rfid', dev: 'dev' };

// ── RSS fetchers (mirrors of server/index.js) ────────────────────
async function fetchGoogle() {
  const feed = await rssParser.parseURL(
    'https://news.google.com/rss/search?q=artificial+intelligence&hl=en-US&gl=US&ceid=US:en'
  );
  return feed.items.slice(0, 6).map(stripGoogleSuffix);
}
async function fetchIoT() {
  const feed = await rssParser.parseURL(
    'https://news.google.com/rss/search?q=IoT+Internet+of+Things+smart+device&hl=en-US&gl=US&ceid=US:en'
  );
  return feed.items.slice(0, 8).map(stripGoogleSuffix);
}
async function fetchRFID() {
  const feed = await rssParser.parseURL(
    'https://news.google.com/rss/search?q=RFID+technology+tracking+tag&hl=en-US&gl=US&ceid=US:en'
  );
  return feed.items.slice(0, 8).map(stripGoogleSuffix);
}
async function fetchNewsapi() {
  const apiKey = process.env.NEWSAPI_KEY;
  if (!apiKey) throw new Error('NEWSAPI_KEY not set — skip');
  const r = await fetch(
    `https://newsapi.org/v2/everything?q=%22artificial+intelligence%22+OR+%22AI+model%22+OR+%22machine+learning%22+OR+%22GPT%22+OR+%22LLM%22&sortBy=publishedAt&language=en&pageSize=10`,
    { headers: { 'X-Api-Key': apiKey } }
  );
  if (!r.ok) throw new Error(`NewsAPI ${r.status}`);
  const data = await r.json();
  return (data.articles || []).slice(0, 6).map(a => ({
    title: a.title || '', summary: a.description || '', source: a.source?.name || '', url: a.url || '', published: a.publishedAt || '',
  }));
}
async function fetchGnews() {
  const apiKey = process.env.GNEWS_KEY;
  if (!apiKey) throw new Error('GNEWS_KEY not set — skip');
  const r = await fetch(
    `https://gnews.io/api/v4/search?q=%22artificial+intelligence%22+OR+%22AI+model%22+OR+%22machine+learning%22&lang=en&max=8&apikey=${apiKey}`
  );
  if (!r.ok) throw new Error(`GNews ${r.status}`);
  const data = await r.json();
  return (data.articles || []).slice(0, 6).map(a => ({
    title: a.title || '', summary: a.description || '', source: a.source?.name || '', url: a.url || '', published: a.publishedAt || '',
  }));
}

const DEV_FEEDS = [
  { name: 'HackerNews', url: 'https://hnrss.org/newest?q=Claude+OR+LLM+OR+RAG+OR+%22AI+agent%22+OR+VLM+OR+MCP&count=20' },
  { name: 'HuggingFace', url: 'https://huggingface.co/blog/feed.xml' },
  { name: 'Dev.to', url: 'https://dev.to/feed/tag/ai' },
  { name: 'GoogleNews-AI-Dev', url: 'https://news.google.com/rss/search?q=%22Claude+AI%22+OR+%22Anthropic%22+OR+%22LangChain%22+OR+%22Retrieval+Augmented%22+OR+%22AI+agent%22+OR+%22large+language+model%22+OR+%22vision+language+model%22&hl=en-US&gl=US&ceid=US:en' },
];

async function fetchDev() {
  const results = await Promise.allSettled(
    DEV_FEEDS.map(async (f) => {
      const p = await rssParser.parseURL(f.url);
      return p.items.slice(0, 5).map((item) => {
        let title = item.title || '';
        let source = f.name;
        if (f.name === 'GoogleNews-AI-Dev') {
          const parts = title.split(' - ');
          if (parts.length > 1) { source = parts.pop().trim(); title = parts.join(' - ').trim(); }
        }
        return { title, summary: item.contentSnippet || item.content || title, source, url: item.link || '', published: item.pubDate || '' };
      });
    })
  );
  const seen = new Set(); const merged = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      const key = (item.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
      if (key && !seen.has(key)) { seen.add(key); merged.push(item); }
    }
  }
  return merged.slice(0, 10);
}

function stripGoogleSuffix(item) {
  const parts = (item.title || '').split(' - ');
  const source = parts.length > 1 ? parts.pop().trim() : 'Google News';
  const title = parts.join(' - ').trim();
  return { title, summary: item.contentSnippet || item.content || title, source, url: item.link || '', published: item.pubDate || '' };
}

const FETCHERS = {
  google: fetchGoogle, newsapi: fetchNewsapi, gnews: fetchGnews,
  iot: fetchIoT, rfid: fetchRFID, dev: fetchDev,
};

// ── Ollama translation ───────────────────────────────────────────
async function translateWithOllama(articles, topic) {
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
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  const r = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: 'json',
      options: { temperature: 0.5, num_predict: 4096 },
    }),
  }).finally(() => clearTimeout(timer));

  if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const text = (data.response || '').replace(/```json|```/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { throw new Error('Ollama returned invalid JSON: ' + text.slice(0, 200)); }
  if (!parsed.news || !Array.isArray(parsed.news)) {
    throw new Error('Ollama response missing news[]: ' + JSON.stringify(parsed).slice(0, 200));
  }
  return parsed.news;
}

// ── Ingest to Railway ────────────────────────────────────────────
async function pushToRailway(source, news) {
  const r = await fetch(`${RAILWAY_URL}/api/news/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Ingest-Token': INGEST_TOKEN,
    },
    body: JSON.stringify({ source, news }),
  });
  if (!r.ok) throw new Error(`Ingest ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ── Main ─────────────────────────────────────────────────────────
async function processSource(source) {
  const topic = SOURCE_TOPIC[source];
  if (!topic) throw new Error(`Unknown source: ${source}`);
  console.log(`[${source}] fetching RSS…`);
  const articles = await FETCHERS[source]();
  if (!articles || articles.length === 0) {
    console.log(`[${source}] 0 articles, skip`);
    return;
  }
  console.log(`[${source}] ${articles.length} articles → Ollama (${OLLAMA_MODEL})`);
  const t0 = Date.now();
  const news = await translateWithOllama(articles, topic);
  console.log(`[${source}] translated in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${news.length} items`);
  const result = await pushToRailway(source, news);
  console.log(`[${source}] ingested:`, result);
}

(async () => {
  console.log(`AI PULSE local translator → ${RAILWAY_URL}`);
  console.log(`Sources: ${SOURCES_FILTER.join(', ')}`);
  for (const src of SOURCES_FILTER) {
    try { await processSource(src); }
    catch (err) { console.error(`[${src}] FAILED:`, err.message); }
  }
  console.log('Done.');
})();
