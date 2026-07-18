// One-off/repair tool: pull the server's CACHED news, translate any
// still-English items to Mongolian via Google Translate (MyMemory fallback,
// no Ollama needed — items are already structured), and ingest them back.
//
//   node retranslate-cached.js                 # all sources
//   node retranslate-cached.js --source=trending
//
// Reuses the same sentinel + fallback strategy as local-translator.js.

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const RAILWAY_URL = process.env.RAILWAY_URL || 'https://ainews-production-9c46.up.railway.app';
const INGEST_TOKEN = process.env.INGEST_TOKEN;
if (!INGEST_TOKEN) { console.error('FATAL: INGEST_TOKEN missing'); process.exit(1); }

const cliSource = (process.argv.find(a => a.startsWith('--source=')) || '').split('=')[1];
const ALL = ['trending', 'google', 'newsapi', 'gnews', 'edge', 'iot', 'rfid', 'dev'];
const SOURCES = cliSource ? [cliSource] : ALL;

// ── translate helpers (same strategy as local-translator.js) ─────
const SEP = '\n---\n';
const SPLIT_RE = /\s*\n?-{3,}\n?\s*/;
let translateFn = null;
async function getTranslator() {
  if (!translateFn) translateFn = (await import('@vitalets/google-translate-api')).translate;
  return translateFn;
}
async function translateGoogle(text) {
  const t = await getTranslator();
  return (await t(text, { to: 'mn' })).text;
}
async function translateMyMemory(text) {
  const r = await fetch('https://api.mymemory.translated.net/get?langpair=en|mn&q=' + encodeURIComponent(text));
  if (!r.ok) throw new Error(`MyMemory ${r.status}`);
  const j = await r.json();
  const out = j.responseData?.translatedText;
  if (!out || j.responseStatus >= 400) throw new Error(`MyMemory: ${j.responseDetails || 'no translation'}`);
  return out;
}
let googleBlockedUntil = 0;
async function translateOne(text, attempt = 0) {
  if (!text) return text;
  if (Date.now() < googleBlockedUntil) {
    try { return await translateMyMemory(text); } catch { return text; }
  }
  try { return await translateGoogle(text); }
  catch (err) {
    if (/Too Many Requests|429/i.test(err.message || '')) {
      googleBlockedUntil = Date.now() + 15 * 60_000;
      try { return await translateMyMemory(text); } catch { return text; }
    }
    if (attempt < 2) { await new Promise(r => setTimeout(r, 500 + attempt * 1000)); return translateOne(text, attempt + 1); }
    return text;
  }
}

// Heuristic: does the text look untranslated (mostly Latin, no Cyrillic)?
function looksEnglish(s) {
  if (!s) return false;
  const cyr = (s.match(/[Ѐ-ӿ]/g) || []).length;
  const lat = (s.match(/[A-Za-z]/g) || []).length;
  return lat > 10 && cyr / Math.max(1, lat) < 0.15;
}

async function processSource(source) {
  const res = await fetch(`${RAILWAY_URL}/api/news/cached`);
  const data = await res.json();
  const news = data[source]?.news || [];
  if (!news.length) { console.log(`[${source}] cache empty, skip`); return; }
  const en = news.filter(n => looksEnglish(n.title));
  if (!en.length) { console.log(`[${source}] already Mongolian (${news.length} items), skip`); return; }

  console.log(`[${source}] translating ${en.length}/${news.length} items…`);
  const out = [];
  for (let i = 0; i < news.length; i++) {
    const n = news[i];
    if (!looksEnglish(n.title)) { out.push(n); continue; }
    const combined = `${n.title || ''}${SEP}${n.summary || ''}${SEP}${n.detail || ''}`;
    const tr = await translateOne(combined);
    const parts = tr.split(SPLIT_RE);
    let title, summary, detail;
    if (parts.length >= 3) {
      title = parts[0].trim(); summary = parts[1].trim(); detail = parts.slice(2).join(' ').trim();
    } else {
      title = await translateOne(n.title); summary = await translateOne(n.summary); detail = await translateOne(n.detail);
    }
    out.push({ ...n, title, summary, detail, timeAgo: n.timeAgo || 'саяхан' });
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 300));
  }
  process.stdout.write('\n');

  const r = await fetch(`${RAILWAY_URL}/api/news/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': INGEST_TOKEN },
    body: JSON.stringify({ source, news: out }),
  });
  if (!r.ok) throw new Error(`Ingest ${r.status}: ${(await r.text()).slice(0, 150)}`);
  console.log(`[${source}] ingested:`, await r.json());
}

(async () => {
  console.log(`retranslate-cached → ${RAILWAY_URL}`);
  for (const s of SOURCES) {
    try { await processSource(s); }
    catch (e) { console.error(`[${s}] FAILED:`, e.message); }
  }
  console.log('Done.');
})();
