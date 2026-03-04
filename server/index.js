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
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY тохируулаагүй байна' });
  }

  try {
    const today = new Date().toLocaleDateString('mn-MN', {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: `Та AI мэдээний шинжээч. Өнөөдрийн огноо: ${today}.

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

Чухал: featured=true нь зөвхөн 2 хамгийн чухал мэдээнд тохирно. Бодит, сүүлийн үеийн AI мэдээг багтаа.`
        }]
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: errData.error?.message || `Anthropic API алдаа: ${response.status}`
      });
    }

    const data = await response.json();
    const text = data.content[0].text;
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
