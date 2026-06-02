# AI PULSE — Local Translator

Runs on a personal machine: fetches RSS, translates with a local Ollama model
(qwen2.5:14b by default), and pushes batches to the Railway server's
`/api/news/ingest` endpoint. Designed to be triggered by Windows Task
Scheduler or cron.

## Setup (one-time)

1. **Install Ollama** and pull the model:
   ```
   ollama pull qwen2.5:14b
   ```

2. **Set the Railway env var** `INGEST_TOKEN` to a long random string:
   ```
   # PowerShell — generate a random 48-char token
   -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | % {[char]$_})
   ```
   Paste that value into Railway → Variables → `INGEST_TOKEN`.

3. **Install local deps:**
   ```
   cd scripts
   npm install
   ```

4. **Configure:**
   ```
   cp .env.example .env
   # edit .env — paste the same INGEST_TOKEN
   ```

## Run

Smoke test (just the DEV source, ~1 min):
```
npm test
```

All sources (~3-5 min depending on model speed):
```
npm start
```

## Schedule daily

### Windows Task Scheduler

1. Open Task Scheduler → Create Basic Task
2. Trigger: Daily at e.g. 09:00 and 18:00
3. Action: Start a program
   - Program: `C:\Program Files\nodejs\node.exe`
   - Arguments: `local-translator.js`
   - Start in: `D:\AI_news\scripts`
4. Conditions → uncheck "Start the task only if the computer is on AC power" (if laptop)

### Linux / macOS cron

```
0 9,18 * * * cd /path/to/AI_news/scripts && /usr/bin/node local-translator.js >> ~/ai-pulse-translator.log 2>&1
```

## How the server interacts

- The server's old `warmCacheSequential` (which called Gemini) still exists
  for fallback, but with `GEMINI_API_KEY` empty it just no-ops.
- When this script POSTs to `/api/news/ingest`, the server overwrites that
  source's in-memory cache. Frontend then sees fresh data immediately via
  `/api/news/cached`.
- Push notifications fire automatically for the most-important new article
  per ingest batch (de-duped per subscriber).

## Troubleshooting

- **`Ollama 500: model not loaded`** — first run downloads/loads the model;
  `ollama run qwen2.5:14b` once interactively to warm it up.
- **`Ingest 401`** — `INGEST_TOKEN` mismatch between `.env` and Railway.
- **JSON parse fail** — Ollama sometimes wraps output; the script strips
  ` ```json ` fences. If a particular model still fails, lower
  `num_predict` or use a stricter `format: "json"` prompt.
- **Long latency** — qwen2.5:14b runs ~30-60s per batch on a modern GPU,
  3-5 min on CPU. Use `qwen2.5:7b` for speed at the cost of quality.
