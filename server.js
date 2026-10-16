import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "15mb" }));
const here = path.dirname(fileURLToPath(import.meta.url));
const pageFile = [path.join(here, "public", "index.html"), path.join(here, "index.html")].find(f => fs.existsSync(f));
if (fs.existsSync(path.join(here, "public"))) app.use(express.static(path.join(here, "public")));
app.get("/", (_req, res) => {
  if (pageFile) return res.sendFile(pageFile);
  res.status(500).type("text").send("index.html not found. Files in project folder: " + fs.readdirSync(here).join(", "));
});

const { ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ACCESS_CODE, MODEL, FALLBACK_MODEL } = process.env;
const provider = ANTHROPIC_API_KEY ? "anthropic" : OPENAI_API_KEY ? "openai" : GEMINI_API_KEY ? "gemini" : null;
const DEFAULT_MODEL = { anthropic: "claude-sonnet-5-5", openai: "gpt-4o", gemini: "gemini-3.8-flash" };

const PROMPT = `You are reading a photo of a HANDWRITTEN invoice from a UK business. The photo may be skewed, dark, or include background such as a bag or table. There may be more than one invoice in the image.

Extract each invoice and return ONLY this JSON, with no other text:
{"invoices":[{"customer":string,"date":"YYYY-MM-DD","invoice_number":string,"sub_total":number,"vat":number,"net_total":number,"uncertain":boolean}]}

Guidance:
- customer: the name written in the "To" / "Bill to" area (the buyer), not the business that printed the invoice letterhead.
- invoice_number: the number beside "Invoice No" (it may be printed in red or stamped).
- date: dates are day/month/year, e.g. 9/9/26 is 2026-09-09.
- Amounts are in pounds. Pounds and pence are often written in two columns (e.g. "54" and "00" means 54.00).
- The pre-printed VAT Registration Number (a long number labelled "Vat No.") is NOT the VAT amount. Ignore it.
- sub_total: the total of the line items before VAT (often the underlined figure under the item totals).
- vat: the VAT amount (often written as "Add 20% vat" followed by the amount).
- net_total: the final amount payable including VAT (usually the last, underlined figure).
- If the VAT/TOTAL boxes at the bottom of the form are empty, use the figures written in the Total column.
- Use plain numbers without currency symbols. Use "" for an unreadable text field and 0 for an unreadable number.
- Set "uncertain": true whenever any handwriting was hard to read or you had to guess. Check that sub_total + vat = net_total; if not, set uncertain true.
- If the image does not contain an invoice, return {"invoices":[]}.`;

async function call(url, options) {
  const r = await fetch(url, options);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j?.error?.message || `provider error ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return j;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const transient = e => [429, 500, 502, 503, 504].includes(e.status) || /high demand|overloaded|unavailable|try again/i.test(e.message);

// Retries short-lived provider overloads, then tries FALLBACK_MODEL (if set).
async function readInvoice(b64) {
  const main = MODEL || DEFAULT_MODEL[provider];
  const models = [main, ...(FALLBACK_MODEL && FALLBACK_MODEL !== main ? [FALLBACK_MODEL] : [])];
  let last;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await readOnce(b64, model); }
      catch (e) {
        last = e;
        if (!transient(e)) throw e;
        console.warn(`${model} busy (attempt ${attempt + 1}): ${e.message.slice(0, 80)}`);
        await sleep(1500 * 2 ** attempt);
      }
    }
  }
  throw last;
}

async function readOnce(b64, model) {
  if (provider === "anthropic") {
    const j = await call("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: 1500,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
          { type: "text", text: PROMPT }] }]
      })
    });
    return j.content.filter(b => b.type === "text").map(b => b.text).join("");
  }
  if (provider === "openai") {
    const j = await call("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model, response_format: { type: "json_object" },
        messages: [{ role: "user", content: [
          { type: "text", text: PROMPT },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }] }]
      })
    });
    return j.choices[0].message.content;
  }
  const j = await call(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: "image/jpeg", data: b64 } }] }],
      generationConfig: { responseMimeType: "application/json" }
    })
  });
  return j.candidates[0].content.parts.map(p => p.text || "").join("");
}

function parseJson(text) {
  const t = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const m = t.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : { invoices: [] };
}

app.get("/api/status", (_req, res) => res.json({ ready: !!provider, provider, needsCode: !!ACCESS_CODE }));

app.post("/api/extract", async (req, res) => {
  if (ACCESS_CODE && req.get("x-access-code") !== ACCESS_CODE) return res.status(401).json({ error: "access code needed" });
  if (!provider) return res.status(503).json({ error: "no API key configured on the server" });
  const image = req.body?.image;
  if (!image || typeof image !== "string") return res.status(400).json({ error: "no image received" });
  try {
    const out = parseJson(await readInvoice(image));
    res.json({ invoices: Array.isArray(out.invoices) ? out.invoices : [] });
  } catch (e) {
    console.error("extract failed:", e.message);
    res.status(502).json({ error: "the reading service failed: " + e.message.slice(0, 160) });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Invoice Capture running. Provider:", provider || "none"));
