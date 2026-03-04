const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

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
    const parsed = JSON.parse(clean);

    res.json(parsed);
  } catch (err) {
    console.error('API error:', err.message);
    res.status(500).json({ error: `Серверийн алдаа: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`AI PULSE server → http://localhost:${PORT}`);
});
