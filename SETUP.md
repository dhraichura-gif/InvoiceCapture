# Invoice Capture: setup on GitHub + Render

## 1. Repo layout
```
your-repo/
  package.json
  server.js
  public/index.html
```
Delete your old root-level index.html.

## 2. Get ONE vision API key (pick a provider)
- Anthropic (Claude): console.anthropic.com -> API keys
- OpenAI: platform.openai.com -> API keys
- Google Gemini: aistudio.google.com -> Get API key (has had a free tier; check current limits)

## 3. Render
1. New -> **Web Service** (not Static Site). Connect your GitHub repo.
2. Build command: `npm install`   Start command: `npm start`
3. Environment variables (Environment tab):
   - ONE of: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`
   - `ACCESS_CODE` = a password of your choice (strongly recommended, otherwise anyone with the link can spend your API credit)
   - optional `MODEL` to override the default model name
4. Deploy, open the URL, enter the access code when asked, and upload an invoice.

## Troubleshooting
- Banner says "reading service is not connected": the API key variable is missing or the service is a Static Site.
- "the reading service failed: ..." : the message comes from the provider (wrong key, no credit, or the model name is retired; set `MODEL`).
- Render free tier sleeps when idle; the first request can take ~30 seconds.
