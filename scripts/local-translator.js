// AI PULSE — local translator (Ollama + Google Translate hybrid)
// Pipeline:
//   1. Fetch RSS for each source
//   2. Ollama (qwen2.5:14b) — structure articles in English: title, summary,
//      detail, category, importance, featured
//   3. Google Translate (@vitalets) — translate title/summary/detail to
//      Mongolian; keep category/importance/source/url/featured as-is
//   4. POST translated batch to Railway /api/news/ingest
//
// Runs on a personal machine, triggered by Windows Task Scheduler / cron.
// See README.md for setup.

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

const cliSource = (process.argv.find(a => a.startsWith('--source=')) || '').split('=')[1];
const SOURCES_FILTER = cliSource
  ? [cliSource]
  : (process.env.SOURCES === 'all' || !process.env.SOURCES
      ? ['google', 'newsapi', 'gnews', 'iot', 'rfid', 'dev']
      : process.env.SOURCES.split(',').map(s => s.trim()).filter(Boolean));

const rssParser = new RSSParser();

// ── Categories per topic (kept in sync with server/index.js) ─────
const TOPIC_CATEGORIES = {
  ai:   ['model', 'research', 'business', 'safety', 'tools'],
  iot:  ['hardware', 'connectivity', 'industry', 'security', 'platform'],
  rfid: ['hardware', 'retail', 'logistics', 'healthcare', 'standard'],
  dev:  ['agent', 'rag', 'llm', 'vlm', 'tooling', 'skill'],
};
const SOURCE_TOPIC = { google: 'ai', newsapi: 'ai', gnews: 'ai', iot: 'iot', rfid: 'rfid', dev: 'dev' };

// ── RSS fetchers ─────────────────────────────────────────────────
function stripGoogleSuffix(item) {
  const parts = (item.title || '').split(' - ');
  const source = parts.length > 1 ? parts.pop().trim() : 'Google News';
  const title = parts.join(' - ').trim();
  return { title, summary: item.contentSnippet || item.content || title, source, url: item.link || '', published: item.pubDate || '' };
}
async function fetchGoogle() {
  const f = await rssParser.parseURL('https://news.google.com/rss/search?q=artificial+intelligence&hl=en-US&gl=US&ceid=US:en');
  return f.items.slice(0, 6).map(stripGoogleSuffix);
}
async function fetchIoT() {
  const f = await rssParser.parseURL('https://news.google.com/rss/search?q=IoT+Internet+of+Things+smart+device&hl=en-US&gl=US&ceid=US:en');
  return f.items.slice(0, 8).map(stripGoogleSuffix);
}
async function fetchRFID() {
  const f = await rssParser.parseURL('https://news.google.com/rss/search?q=RFID+technology+tracking+tag&hl=en-US&gl=US&ceid=US:en');
  return f.items.slice(0, 8).map(stripGoogleSuffix);
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
      return p.items.slice(0, 3).map((item) => {
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
  return merged.slice(0, 6); // Reduced from 10 to keep Ollama batches manageable on partial-VRAM GPUs
}

const FETCHERS = {
  google: fetchGoogle, newsapi: fetchNewsapi, gnews: fetchGnews,
  iot: fetchIoT, rfid: fetchRFID, dev: fetchDev,
};

// ── Ollama: structure articles in ENGLISH ────────────────────────
async function enrichWithOllama(articles, topic) {
  const categories = TOPIC_CATEGORIES[topic] || TOPIC_CATEGORIES.ai;
  const articleList = articles.map((a, i) =>
    `${i + 1}. ${a.title} | source: ${a.source || ''} | url: ${a.url || ''} | snippet: ${(a.summary || '').slice(0, 200)}`
  ).join('\n');

  const prompt = `You are a JSON-only news structuring assistant. Output STRICT valid JSON, no markdown fences.

Below are ${articles.length} English news items on the topic "${topic.toUpperCase()}". For each item produce:
- title: keep the original English title
- summary: 2-3 sentences in ENGLISH
- detail: 3-4 sentences in ENGLISH
- category: exactly ONE of: ${categories.map(c => `"${c}"`).join(', ')}
- source: keep original
- url: keep original
- importance: integer 1-10 (rate how impactful)
- featured: boolean — set true for the SINGLE most important item only, rest false
- timeAgo: "recently"

Items:
${articleList}

Output schema (return EXACTLY this shape — and remember everything in ENGLISH):
{"news":[{"id":1,"title":"...","summary":"...","detail":"...","category":"...","source":"...","url":"...","importance":8,"featured":false,"timeAgo":"recently"}]}`;

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
      options: {
        temperature: 0.3,
        num_predict: 4096, // upped from 2048 — 8-article batches were truncating mid-JSON
        num_ctx: 8192,     // upped from 4096 to fit the larger prompt+output
      },
      keep_alive: '30m', // hold model in memory for the rest of this run
    }),
  }).finally(() => clearTimeout(timer));

  if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const text = (data.response || '').replace(/```json|```/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { throw new Error('Ollama JSON parse fail: ' + text.slice(0, 200)); }
  if (!parsed.news || !Array.isArray(parsed.news)) {
    throw new Error('Ollama missing news[]: ' + JSON.stringify(parsed).slice(0, 200));
  }

  // Normalize: category may come back as array — coerce to first valid
  const validCats = new Set(categories);
  for (const n of parsed.news) {
    if (Array.isArray(n.category)) n.category = n.category[0] || categories[0];
    if (typeof n.category === 'string' && n.category.includes('|')) n.category = n.category.split('|')[0].trim();
    if (!validCats.has(n.category)) n.category = categories[0];
  }
  return parsed.news;
}

// ── Google Translate: EN → MN ────────────────────────────────────
let translateFn = null;
async function getTranslator() {
  if (!translateFn) {
    const mod = await import('@vitalets/google-translate-api');
    translateFn = mod.translate;
  }
  return translateFn;
}

// Sentinel that survives Google Translate (uppercase, no punctuation) —
// used to join title/summary/detail into ONE request per article so we
// burn 1 quota unit instead of 3.
const SEP = ' QQXQQ ';

async function translateOne(text, attempt = 0) {
  if (!text) return text;
  const translate = await getTranslator();
  try {
    const r = await translate(text, { to: 'mn' });
    return r.text;
  } catch (err) {
    // 429-style failures: back off exponentially up to 4 attempts
    const rateLimited = /Too Many Requests|429/i.test(err.message || '');
    if (attempt < (rateLimited ? 4 : 2)) {
      const wait = rateLimited ? 3000 * Math.pow(2, attempt) : 500 + attempt * 1000;
      await new Promise(r => setTimeout(r, wait));
      return translateOne(text, attempt + 1);
    }
    console.warn(`  translate fail (kept EN): ${(err.message || '').slice(0, 100)}`);
    return text; // last resort: keep English so the article isn't lost
  }
}

async function translateNewsToMongolian(news) {
  // ONE Google request per article (3 fields joined with a sentinel).
  // Sequential with a 250ms gap to stay well under Google's rate limit.
  const out = [];
  for (let i = 0; i < news.length; i++) {
    const n = news[i];
    const combined = `${n.title || ''}${SEP}${n.summary || ''}${SEP}${n.detail || ''}`;
    const translated = await translateOne(combined);
    const parts = translated.split(/\s*QQXQQ\s*/);
    // Defensive: if Google munged the sentinel, fall back to the original
    const [title, summary, detail] = parts.length >= 3
      ? [parts[0].trim(), parts[1].trim(), parts.slice(2).join(' ').trim()]
      : [n.title, n.summary, n.detail];
    out.push({
      ...n,
      title, summary, detail,
      timeAgo: 'саяхан', // Google translates "recently" inconsistently
    });
    process.stdout.write('.');
    if (i < news.length - 1) await new Promise(r => setTimeout(r, 250));
  }
  process.stdout.write('\n');
  return out;
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

  console.log(`\n[${source}] fetching RSS…`);
  const articles = await FETCHERS[source]();
  if (!articles || articles.length === 0) {
    console.log(`[${source}] 0 articles, skip`);
    return;
  }

  console.log(`[${source}] ${articles.length} articles → Ollama (${OLLAMA_MODEL})`);
  const t0 = Date.now();
  const enriched = await enrichWithOllama(articles, topic);
  console.log(`[${source}] structured in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${enriched.length} items`);

  const t1 = Date.now();
  const translated = await translateNewsToMongolian(enriched);
  console.log(`[${source}] translated in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  const result = await pushToRailway(source, translated);
  console.log(`[${source}] ingested:`, result);
}

(async () => {
  console.log(`AI PULSE local translator → ${RAILWAY_URL}`);
  console.log(`Pipeline: Ollama (${OLLAMA_MODEL}) [EN structuring] → Google Translate [EN→MN]`);
  console.log(`Sources: ${SOURCES_FILTER.join(', ')}`);
  for (const src of SOURCES_FILTER) {
    try { await processSource(src); }
    catch (err) { console.error(`[${src}] FAILED:`, err.message); }
  }
  console.log('\nDone.');
})();
