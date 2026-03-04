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

// ── Shared: Gemini translate helper ──────────────────────────────
async function translateWithGemini(articles) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY тохируулаагүй');

  const articleList = articles.map((a, i) =>
    `${i + 1}. Title: ${a.title}\nSummary: ${a.summary || ''}\nSource: ${a.source || ''}\nURL: ${a.url || ''}\nPublished: ${a.published || ''}`
  ).join('\n\n');

  const prompt = `Та AI мэдээний орчуулагч. Дараах англи хэлний AI мэдээнүүдийг монгол хэлрүү орчуулж JSON формат болго.

Мэдээнүүд:
${articleList}

Зөвхөн JSON форматаар хариулна уу:
{
  "news": [
    {
      "id": 1,
      "title": "Монгол хэлрүү орчуулсан гарчиг",
      "summary": "2-3 өгүүлбэрийн тайлбар монгол хэлээр",
      "detail": "Дэлгэрэнгүй 3-4 өгүүлбэр монголоор",
      "category": "model|research|business|safety|tools",
      "source": "Эх сурвалжийн нэр",
      "url": "Эх мэдээний URL",
      "importance": 1-10,
      "featured": true|false,
      "timeAgo": "X цаг/минут өмнө"
    }
  ]
}

Чухал:
- featured=true зөвхөн 2 хамгийн чухал мэдээнд
- category-г мэдээний агуулгаас тодорхойл
- url талбарыг анхны мэдээнээс хэвээр хадгал
- timeAgo-г published огнооноос тооцоол`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

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
          maxOutputTokens: 8192,
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
  const data = JSON.parse(rawText);
  const candidate = data.candidates?.[0];
  if (!candidate?.content?.parts?.[0]?.text) {
    throw new Error('Gemini хариу хоосон');
  }

  const text = candidate.content.parts[0].text;
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ── Helper: time ago from date ───────────────────────────────────
function timeAgo(dateStr) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 60000);
  if (diff < 60) return `${diff} минутын өмнө`;
  if (diff < 1440) return `${Math.floor(diff / 60)} цагийн өмнө`;
  return `${Math.floor(diff / 1440)} өдрийн өмнө`;
}

// ── 1. Google News RSS ───────────────────────────────────────────
app.post('/api/news/google', async (req, res) => {
  try {
    const feed = await rssParser.parseURL(
      'https://news.google.com/rss/search?q=artificial+intelligence&hl=en-US&gl=US&ceid=US:en'
    );

    const articles = feed.items.slice(0, 10).map(item => ({
      title: item.title || '',
      summary: item.contentSnippet || item.content || '',
      source: item.creator || item.source?.name || 'Google News',
      url: item.link || '',
      published: item.pubDate || '',
    }));

    const result = await translateWithGemini(articles);
    res.json(result);
  } catch (err) {
    console.error('Google News error:', err.message);
    res.status(500).json({ error: `Google News алдаа: ${err.message}` });
  }
});

// ── 2. NewsAPI.org ───────────────────────────────────────────────
app.post('/api/news/newsapi', async (req, res) => {
  const apiKey = process.env.NEWSAPI_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'NEWSAPI_KEY тохируулаагүй байна' });
  }

  try {
    const response = await fetch(
      `https://newsapi.org/v2/everything?q=artificial+intelligence&sortBy=publishedAt&language=en&pageSize=10`,
      { headers: { 'X-Api-Key': apiKey } }
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `NewsAPI алдаа: ${response.status}`);
    }

    const data = await response.json();
    const articles = (data.articles || []).slice(0, 10).map(a => ({
      title: a.title || '',
      summary: a.description || '',
      source: a.source?.name || '',
      url: a.url || '',
      published: a.publishedAt || '',
    }));

    const result = await translateWithGemini(articles);
    res.json(result);
  } catch (err) {
    console.error('NewsAPI error:', err.message);
    res.status(500).json({ error: `NewsAPI алдаа: ${err.message}` });
  }
});

// ── 3. Bing News Search ──────────────────────────────────────────
app.post('/api/news/bing', async (req, res) => {
  const apiKey = process.env.BING_NEWS_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'BING_NEWS_KEY тохируулаагүй байна' });
  }

  try {
    const response = await fetch(
      'https://api.bing.microsoft.com/v7.0/news/search?q=artificial+intelligence&count=10&mkt=en-US',
      { headers: { 'Ocp-Apim-Subscription-Key': apiKey } }
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `Bing News алдаа: ${response.status}`);
    }

    const data = await response.json();
    const articles = (data.value || []).slice(0, 10).map(a => ({
      title: a.name || '',
      summary: a.description || '',
      source: a.provider?.[0]?.name || '',
      url: a.url || '',
      published: a.datePublished || '',
    }));

    const result = await translateWithGemini(articles);
    res.json(result);
  } catch (err) {
    console.error('Bing News error:', err.message);
    res.status(500).json({ error: `Bing News алдаа: ${err.message}` });
  }
});

// ── Original Gemini-generated news (legacy) ──────────────────────
app.post('/api/news', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY тохируулаагүй байна' });
  }

  try {
    const today = new Date().toLocaleDateString('mn-MN', {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    const prompt = `Та AI мэдээний шинжээч. Өнөөдрийн огноо: ${today}.

Хиймэл оюун ухааны салбарт сүүлийн үеийн хамгийн чухал мэдээ, хөгжлүүдийг жагсаа. Дараах категориудад хамаарах 8-10 мэдээ үүсгэ:

Зөвхөн JSON форматаар хариулна уу, ямар нэг тайлбар оруулалгүй:
{
  "news": [
    {
      "id": 1,
      "title": "Монгол хэл дээрх мэдээний гарчиг",
      "summary": "2-3 өгүүлбэрийн тайлбар монгол хэлээр",
      "detail": "Дэлгэрэнгүй 3-4 өгүүлбэр",
      "category": "model|research|business|safety|tools",
      "source": "Мэдээний эх сурвалж",
      "importance": 1-10,
      "featured": true|false,
      "timeAgo": "X цаг өмнө"
    }
  ]
}

Чухал: featured=true нь зөвхөн 2 хамгийн чухал мэдээнд тохирно. Бодит, сүүлийн үеийн AI мэдээг багтаа.`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 8192,
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
      return res.status(response.status).json({
        error: errMsg || `Gemini API алдаа: ${response.status}`
      });
    }

    const rawText = await response.text();
    let data;
    try { data = JSON.parse(rawText); } catch(e) {
      console.error('Raw response:', rawText.slice(0, 500));
      throw new Error('Gemini хариуг JSON болгож чадсангүй');
    }

    const candidate = data.candidates?.[0];
    if (!candidate || !candidate.content?.parts?.[0]?.text) {
      console.error('Unexpected Gemini response:', JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: 'Gemini хариу хоосон байна' });
    }

    const text = candidate.content.parts[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      console.error('JSON parse failed. Clean text:', clean.slice(0, 500));
      return res.status(502).json({ error: 'Gemini хариуг JSON болгож чадсангүй' });
    }

    res.json(parsed);
  } catch (err) {
    console.error('API error:', err.message);
    res.status(500).json({ error: `Серверийн алдаа: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`AI PULSE server → http://localhost:${PORT}`);
});
