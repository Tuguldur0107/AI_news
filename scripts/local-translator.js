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
      ? ['trending', 'google', 'newsapi', 'gnews', 'edge', 'iot', 'rfid', 'dev']
      : process.env.SOURCES.split(',').map(s => s.trim()).filter(Boolean));

const rssParser = new RSSParser();

// ── Categories per topic (kept in sync with server/index.js) ─────
const TOPIC_CATEGORIES = {
  ai:       ['model', 'research', 'business', 'safety', 'tools'],
  iot:      ['hardware', 'connectivity', 'industry', 'security', 'platform'],
  rfid:     ['hardware', 'retail', 'logistics', 'healthcare', 'standard'],
  dev:      ['agent', 'rag', 'llm', 'vlm', 'tooling', 'skill'],
  trending: ['model', 'research', 'tooling', 'agent', 'business'],
  edge:     ['inference', 'hardware', 'vision', 'privacy', 'tinyml'],
};
const SOURCE_TOPIC = { google: 'ai', newsapi: 'ai', gnews: 'ai', iot: 'iot', rfid: 'rfid', dev: 'dev', trending: 'trending', edge: 'edge' };

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

// ── EDGE: edge-computing / edge-AI via Google News RSS ───────────
async function fetchEdge() {
  const f = await rssParser.parseURL('https://news.google.com/rss/search?q=%22edge+computing%22+OR+%22edge+AI%22+OR+%22on-device+AI%22+OR+%22TinyML%22+OR+%22edge+inference%22&hl=en-US&gl=US&ceid=US:en');
  return f.items.slice(0, 8).map(stripGoogleSuffix);
}

// ── TRENDING: free popularity aggregation (HN + Dev.to + Lobsters) ─
// Same daily.dev-style model as server/index.js — free, keyless APIs, ranked
// by per-source-normalized popularity, filtered to AI/dev relevance.
const TREND_KEYWORDS = /\b(a\.?i\.?|artificial intelligence|machine learning|\bml\b|llm|gpt|claude|gemini|llama|mistral|openai|anthropic|deepseek|agent|\brag\b|vlm|mcp|model|neural|deep learning|transformer|inference|prompt|embedding|fine.?tun|diffusion|pytorch|tensorflow|hugging.?face|dataset|\bgpu\b|cuda|programming|software|framework|open.?source|kubernetes|\brust\b|python|typescript|javascript|database|compiler|robot|chip|semiconductor)\b/i;

async function fetchJsonSafe(url, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'User-Agent': 'AI-PULSE/1.0 (news aggregator)' } });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function fetchHackerNewsTop() {
  const ids = await fetchJsonSafe('https://hacker-news.firebaseio.com/v0/topstories.json');
  const items = await Promise.all((ids || []).slice(0, 50).map(async id => {
    try { return await fetchJsonSafe(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, 6000); } catch { return null; }
  }));
  return items.filter(i => i && i.title && i.url).map(i => ({ title: i.title, summary: i.title, source: 'Hacker News', url: i.url, score: i.score || 0 }));
}
async function fetchDevtoTop() {
  const arr = await fetchJsonSafe('https://dev.to/api/articles?top=1&per_page=25');
  return (arr || []).map(a => ({ title: a.title || '', summary: a.description || a.title || '', source: 'Dev.to', url: a.url || '', score: a.positive_reactions_count || 0 }));
}
async function fetchLobstersHot() {
  const arr = await fetchJsonSafe('https://lobste.rs/hottest.json');
  return (arr || []).map(p => ({ title: p.title || '', summary: p.description || p.title || '', source: 'Lobsters', url: p.url || p.comments_url || '', score: p.score || 0 }));
}
async function fetchTrending() {
  const results = await Promise.allSettled([fetchHackerNewsTop(), fetchDevtoTop(), fetchLobstersHot()]);
  const all = [];
  for (const r of results) if (r.status === 'fulfilled') all.push(...r.value);
  if (all.length === 0) throw new Error('all trending sources failed');
  const rel = all.filter(a => a.title && a.url && TREND_KEYWORDS.test(`${a.title} ${a.summary || ''}`));
  const mx = {};
  for (const a of rel) mx[a.source] = Math.max(mx[a.source] || 1, a.score);
  for (const a of rel) a._n = a.score / (mx[a.source] || 1);
  rel.sort((x, y) => y._n - x._n);
  const seen = new Set(); const m = [];
  for (const a of rel) {
    const k = (a.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
    if (k && !seen.has(k)) { seen.add(k); m.push(a); }
  }
  return m.slice(0, 10);
}

const FETCHERS = {
  google: fetchGoogle, newsapi: fetchNewsapi, gnews: fetchGnews,
  iot: fetchIoT, rfid: fetchRFID, dev: fetchDev,
  trending: fetchTrending, edge: fetchEdge,
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

// Sentinel — Markdown-style separator that BOTH Google Translate and
// MyMemory preserve verbatim. Used to bundle title/summary/detail into
// one request per article (1/3 the quota).
const SEP = '\n---\n';
const SPLIT_RE = /\s*\n?-{3,}\n?\s*/;

// Translate via Google Translate (may rate-limit per IP)
async function translateGoogle(text) {
  const translate = await getTranslator();
  const r = await translate(text, { to: 'mn' });
  return r.text;
}

// Translate via MyMemory — public free tier, no key required, ~5K words/day
// anonymous. Used as fallback when Google's IP rate limit kicks in.
async function translateMyMemory(text) {
  const url = 'https://api.mymemory.translated.net/get?langpair=en|mn&q=' + encodeURIComponent(text);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`MyMemory ${r.status}`);
  const j = await r.json();
  const out = j.responseData?.translatedText;
  if (!out || j.responseStatus >= 400) {
    throw new Error(`MyMemory: ${j.responseDetails || 'no translation'}`);
  }
  return out;
}

// translateOne — try Google first (faster, better quality), fall back to
// MyMemory on rate-limit, keep English as last resort
let googleBlockedUntil = 0;
async function translateOne(text, attempt = 0) {
  if (!text) return text;

  // If Google was just rate-limited, skip straight to MyMemory for a while
  if (Date.now() < googleBlockedUntil) {
    try { return await translateMyMemory(text); }
    catch (err) {
      console.warn(`  MyMemory fail (kept EN): ${(err.message || '').slice(0, 100)}`);
      return text;
    }
  }

  try {
    return await translateGoogle(text);
  } catch (err) {
    const rateLimited = /Too Many Requests|429/i.test(err.message || '');
    if (rateLimited) {
      // Stop hammering Google for 15 minutes; switch to MyMemory for now
      googleBlockedUntil = Date.now() + 15 * 60_000;
      try {
        const t = await translateMyMemory(text);
        if (attempt === 0) console.warn('  → switched to MyMemory (Google rate-limited)');
        return t;
      } catch (mmErr) {
        console.warn(`  both translators failed (kept EN): ${(mmErr.message || '').slice(0, 100)}`);
        return text;
      }
    }
    // Non-rate-limit Google failure: small retry then keep EN
    if (attempt < 2) {
      await new Promise(r => setTimeout(r, 500 + attempt * 1000));
      return translateOne(text, attempt + 1);
    }
    console.warn(`  translate fail (kept EN): ${(err.message || '').slice(0, 100)}`);
    return text;
  }
}

async function translateNewsToMongolian(news) {
  // ONE translation request per article (3 fields joined with markdown
  // separators). Sequential with a 300ms gap to stay friendly to both
  // backends.
  const out = [];
  for (let i = 0; i < news.length; i++) {
    const n = news[i];
    const combined = `${n.title || ''}${SEP}${n.summary || ''}${SEP}${n.detail || ''}`;
    const translated = await translateOne(combined);
    const parts = translated.split(SPLIT_RE);
    // Defensive: if the backend munged the sentinel, fall back per-field
    let title, summary, detail;
    if (parts.length >= 3) {
      [title, summary] = [parts[0].trim(), parts[1].trim()];
      detail = parts.slice(2).join(' ').trim();
    } else {
      // Sentinel didn't survive — translate each piece individually
      [title, summary, detail] = await Promise.all([
        translateOne(n.title),
        translateOne(n.summary),
        translateOne(n.detail),
      ]);
    }
    out.push({
      ...n,
      title, summary, detail,
      timeAgo: 'саяхан', // backends translate "recently" inconsistently
    });
    process.stdout.write('.');
    if (i < news.length - 1) await new Promise(r => setTimeout(r, 300));
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
