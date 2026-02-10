/**
 * Cloudflare Worker: Captivate -> OpenAI proxy
 * Input:  { prompt: string }
 * Output: { text: string }
 */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

function stripCodeFences(s) {
  if (!s) return "";
  // Remove ```json ... ``` or ``` ... ```
  return s.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, "$1").trim();
}

function extractTextFromResponsesAPI(data) {
  // Primary shape for /v1/responses
  let text = "";

  if (data?.output && Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item?.content && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part?.type === "output_text" && typeof part.text === "string") {
            text += part.text;
          }
        }
      }
    }
  }

  // Fallback if OpenAI includes output_text convenience field
  if (!text && typeof data?.output_text === "string") {
    text = data.output_text;
  }

  return text;
}

export default {
  async fetch(request, env) {
    // ---- CORS preflight ----
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // ---- Only POST ----
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ text: "Method Not Allowed" }), {
        status: 405,
        headers: corsHeaders(),
      });
    }

    try {
      // ---- Parse input ----
      const body = await request.json().catch(() => ({}));
      const prompt = body?.prompt;

      if (!prompt || typeof prompt !== "string") {
        return new Response(JSON.stringify({ text: "Missing or invalid prompt" }), {
          status: 400,
          headers: corsHeaders(),
        });
      }

      if (!env.OPENAI_API_KEY) {
        return new Response(JSON.stringify({ text: "Missing OPENAI_API_KEY in Worker env" }), {
          status: 500,
          headers: corsHeaders(),
        });
      }

      // ---- Call OpenAI ----
      const openaiRes = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          input: [
            {
              role: "system",
              content:
                "Return plain text only. Do NOT use Markdown. Do NOT wrap output in code fences. No ``` blocks. Follow the requested output format exactly.",
            },
            { role: "user", content: prompt },
          ],
          max_output_tokens: 350,
          temperature: 0.2,
        }),
      });

      // ---- Surface OpenAI error details to Captivate ----
      if (!openaiRes.ok) {
        const errRaw = await openaiRes.text().catch(() => "");
        const msg =
          `OpenAI error ${openaiRes.status}. ` +
          (errRaw ? errRaw.slice(0, 1400) : "No error body.");

        return new Response(JSON.stringify({ text: msg }), {
          status: 502,
          headers: corsHeaders(),
        });
      }

      const data = await openaiRes.json();

      // ---- Extract text ----
      let text = extractTextFromResponsesAPI(data);
      if (!text) text = "No response generated.";

      // ---- Clean fences just in case ----
      text = stripCodeFences(text);

      // ---- Return ----
      return new Response(JSON.stringify({ text }), {
        status: 200,
        headers: corsHeaders(),
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ text: "Worker error: " + String(err?.message || err) }),
        { status: 500, headers: corsHeaders() }
      );
    }
  },
};
