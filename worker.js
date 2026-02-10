/**
 * Cloudflare Worker for Captivate -> OpenAI proxy
 * - Accepts: { prompt: string }
 * - Returns: { text: string }   (cleaned, no ``` fences)
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
  // Removes ```json ... ``` or ``` ... ```
  return s.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, "$1").trim();
}

function extractOutputTextFromResponsesAPI(data) {
  // Your current extraction logic, kept but wrapped as a function
  let text = "";
  if (data && data.output && Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item && item.content && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part && part.type === "output_text" && typeof part.text === "string") {
            text += part.text;
          }
        }
      }
    }
  }
  return text;
}

export default {
  async fetch(request, env) {
    // --- CORS preflight ---
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // --- Only allow POST ---
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
        status: 405,
        headers: corsHeaders(),
      });
    }

    try {
      // --- Read prompt from request ---
      const body = await request.json().catch(() => ({}));
      const prompt = body?.prompt;

      if (!prompt || typeof prompt !== "string") {
        return new Response(JSON.stringify({ error: "Missing or invalid prompt" }), {
          status: 400,
          headers: corsHeaders(),
        });
      }

      if (!env.OPENAI_API_KEY) {
        return new Response(JSON.stringify({ error: "Missing OPENAI_API_KEY in env" }), {
          status: 500,
          headers: corsHeaders(),
        });
      }

      // --- Call OpenAI (Responses API) ---
      // Strong instruction to return plain text only.
      const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
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
                "You are a strict grader. Return plain text only. Do NOT wrap output in Markdown or code fences. Do NOT output ``` blocks.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          max_output_tokens: 250,
          temperature: 0.2,
        }),
      });

      // If OpenAI fails, pass error details back to Captivate
      if (!openaiResponse.ok) {
        const errText = await openaiResponse.text().catch(() => "");
        return new Response(
          JSON.stringify({
            error: "OpenAI proxy error",
            status: openaiResponse.status,
            details: errText.slice(0, 2000),
          }),
          { status: 502, headers: corsHeaders() }
        );
      }

      const data = await openaiResponse.json();

      // --- Extract text safely ---
      let text = extractOutputTextFromResponsesAPI(data);

      // Fallback: sometimes Responses API can include convenience fields in future shapes
      if (!text && typeof data?.output_text === "string") {
        text = data.output_text;
      }

      if (!text) {
        text = "No response generated.";
      }

      // --- Clean fences / markdown wrappers ---
      text = stripCodeFences(text);

      // --- Return clean JSON to Captivate ---
      return new Response(JSON.stringify({ text }), {
        status: 200,
        headers: corsHeaders(),
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: "Worker error",
          details: String(err?.message || err),
        }),
        { status: 500, headers: corsHeaders() }
      );
    }
  },
};
