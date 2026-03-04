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
    `${i + 1}. ${a.title} [${a.source || ''}] URL:${a.url || ''}`
  ).join('\n');

  const prompt = `Англи AI мэдээг монголоор орчуул. JSON хариулна уу.

${articleList}

{"news":[{"id":1,"title":"Монгол гарчиг","summary":"2-3 өгүүлбэр","detail":"3-4 өгүүлбэр","category":"model","source":"Source Name","url":"URL хэвээр","importance":8,"featured":false,"timeAgo":"2 цагийн өмнө"}]}

ЗААВАЛ: category нь ЗӨВХӨН нэг утга авна: "model", "research", "business", "safety", "tools". Хэзээ ч "|" тэмдэг бүү ашигла.
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

    const articles = feed.items.slice(0, 8).map(item => {
      // Google News includes source in title: "Title - Source Name"
      const parts = (item.title || '').split(' - ');
      const source = parts.length > 1 ? parts.pop().trim() : 'Google News';
      const title = parts.join(' - ').trim();
      return {
        title,
        summary: item.contentSnippet || item.content || title,
        source,
        url: item.link || '',
        published: item.pubDate || '',
      };
    });

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
      `https://newsapi.org/v2/everything?q=%22artificial+intelligence%22+OR+%22AI+model%22+OR+%22machine+learning%22+OR+%22GPT%22+OR+%22LLM%22&sortBy=publishedAt&language=en&pageSize=10`,
      { headers: { 'X-Api-Key': apiKey } }
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `NewsAPI алдаа: ${response.status}`);
    }

    const data = await response.json();
    const articles = (data.articles || []).slice(0, 8).map(a => ({
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

// ── 3. GNews ─────────────────────────────────────────────────────
app.post('/api/news/gnews', async (req, res) => {
  const apiKey = process.env.GNEWS_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GNEWS_KEY тохируулаагүй байна' });
  }

  try {
    const response = await fetch(
      `https://gnews.io/api/v4/search?q=%22artificial+intelligence%22+OR+%22AI+model%22+OR+%22machine+learning%22&lang=en&max=8&apikey=${apiKey}`
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.errors?.[0] || `GNews алдаа: ${response.status}`);
    }

    const data = await response.json();
    const articles = (data.articles || []).slice(0, 8).map(a => ({
      title: a.title || '',
      summary: a.description || '',
      source: a.source?.name || '',
      url: a.url || '',
      published: a.publishedAt || '',
    }));

    const result = await translateWithGemini(articles);
    res.json(result);
  } catch (err) {
    console.error('GNews error:', err.message);
    res.status(500).json({ error: `GNews алдаа: ${err.message}` });
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
