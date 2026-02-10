/*
  Cloudflare Worker: secure proxy for LLM feedback
 
  What this Worker does:
  1) Receives a learner response from a browser-based activity (Captivate, website, LMS embed)
  2) Uses a secret API key stored in Cloudflare (not in the browser, not in GitHub)
  3) Calls the LLM provider (OpenAI here)
  4) Returns structured JSON feedback to the browser
 
  What students MUST customize in this file:
  - systemPrompt (evaluation instructions)
  - userPrompt (how you present the learning objective, criteria, and response)
  - isAllowedOrigin() (add your GitHub Pages base domain)
 
  What students should NOT customize if you don't have JavaScript knowledge:
  - CORS/preflight handling
  - request parsing
  - OpenAI API call plumbing
  - JSON extraction and parsing
*/
 
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = isAllowedOrigin(origin);

    // DEBUG: server-side log (use Cloudflare logs or `wrangler tail`)
    console.log("[worker] hit", request.method, request.url, "origin:", origin || "(none)");
 
    // Preflight (browser permission check).
    // Do not edit this section.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(allowedOrigin)
      });
    }

    // ✅ NEW: Allow GET so visiting the Worker URL in a browser shows a helpful message.
    if (request.method === "GET") {
      const headers = {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Worker-Alive": "1"
      };
      // If this GET comes from your allowed site, include CORS headers.
      if (allowedOrigin) Object.assign(headers, corsHeaders(allowedOrigin));

      return new Response("OK. Worker is running. Send POST to use this API.", {
        status: 200,
        headers
      });
    }
 
    // Only allow POST requests.
    // Do not edit this section.
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
 
    // Block disallowed origins.
    // Do not edit this section.
    if (!allowedOrigin) {
      return new Response(JSON.stringify({ error: "Origin not allowed", origin }), {
        status: 403,
        headers: { "Content-Type": "application/json" }
      });
    }
 
    // Parse JSON body from the browser.
    // Do not edit this section.
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(allowedOrigin) }
      });
    }
 
    // These values come from the frontend (Captivate, website, etc.).
    // Frontend sends:
    // - response_text: what the learner wrote
    // - learning_objective: what you want them to demonstrate
    // - criteria: how you will judge quality/correctness
    const responseText = String(body.response_text || "").trim();
    const learningObjective = String(body.learning_objective || "").trim();
    const criteria = Array.isArray(body.criteria) ? body.criteria : [];
 
    // Simple guardrails.
    // Do not edit this section.
    if (responseText.length < 10 || responseText.length > 2000) {
      return new Response(JSON.stringify({ error: "Response length out of range" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(allowedOrigin) }
      });
    }
 
    if (!learningObjective) {
      return new Response(JSON.stringify({ error: "Missing learning_objective" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(allowedOrigin) }
      });
    }
 
    // The API key must be stored as a Cloudflare Secret named OPENAI_API_KEY.
    // Do not edit this section.
    if (!env.OPENAI_API_KEY) {
      return new Response(JSON.stringify({ error: "Missing OPENAI_API_KEY" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders(allowedOrigin) }
      });
    }
 
    /*
      ============================
      SECTION STUDENTS MUST EDIT
      ============================
 
      Your job is to write the evaluation prompts.
 
      You must edit:
      - systemPrompt: sets the model’s role and rules
      - userPrompt: gives the model the learning objective, criteria, and learner response
 
      Important requirements:
      - Your prompt MUST instruct the model to return ONLY JSON.
      - Your prompt MUST reference the learning objective or criteria in its feedback.
      - Verdict must be exactly one of:
          "Correct"
          "Not quite right"
          "Incorrect"
 
      Do not remove these template variables, they come from the frontend:
        ${learningObjective}  (string)
        ${criteria}           (array of strings)
        ${responseText}       (string)
    */
 
    // Students edit this.
    // Keep this prompt short and specific. Write your own instructions below.
    const systemPrompt =
      "You are a strict but helpful grader for a short-answer question in an education course. " +
      "Grade ONLY based on the rubric and the learner response provided. " +
      "Be fair: do not assume missing details; do not infer intent. " +
      "Return ONLY valid JSON (no markdown, no extra text). " +
      "Your JSON MUST have exactly these keys: " +
      '"verdict" and "feedback". ' +
      'Rules: "verdict" must be either "meets" or "needs_improvement". ' +
      '"feedback" must be one paragraph that explicitly references the rubric elements, ' +
      "states what is missing (if anything), and gives a rewrite template sentence the learner can copy.";
 
    // Students edit this.
    // This is where you include the values sent from the frontend.
    // You can change the wording around them, but keep the variables.
    const userPrompt =
      `Learning objective:\n${learningObjective}\n\n` +
      `Evaluation criteria:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\n` +
      `Learner response:\n${responseText}\n\n` +
      "Instructions for grading:\n" +
      "- Decide verdict using the rubric.\n" +
      '- Set "verdict" to "meets" ONLY if the learner clearly includes ALL required parts:\n' +
      "  1) Learner problem addressed (a specific barrier or need, not just 'helps learning').\n" +
      "  2) How the LLM helps (what it does and why it helps, ideally naming a mechanism like explaining, rewriting, feedback generation, guided dialogue).\n" +
      "  3) One concrete example with structure: who + context + what they do with the LLM + what output they get.\n" +
      '- Otherwise set "verdict" to "needs_improvement".\n' +
      "- Extra credit items (audience specificity, limitations like privacy/bias/hallucinations/teacher review) are optional and must not be required for a meets verdict.\n" +
      '- "feedback" requirements:\n' +
      "  - One paragraph.\n" +
      "  - Explicitly name which of the three required parts are missing or weak.\n" +
      "  - Provide a copy-ready rewrite template the learner can fill in, with placeholders.\n" +
      "  - Do not add any keys besides verdict and feedback.\n";
 
 
    // Call OpenAI Responses API (server-side).
    // Do not edit this section.
    const openaiResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        text: { format: { type: "json_object" } }
      })
    });
 
    if (!openaiResp.ok) {
      const err = await openaiResp.text();
      return new Response(JSON.stringify({ error: "OpenAI error", detail: err.slice(0, 300) }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders(allowedOrigin) }
      });
    }
 
    const data = await openaiResp.json();
 
    // Extract JSON text from OpenAI Responses API.
    // Do not edit this section.
    const jsonText =
      (typeof data.output_text === "string" && data.output_text.trim()) ||
      extractTextFromResponsesOutput(data) ||
      "";
 
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return new Response(
        JSON.stringify({
          error: "Model returned non-JSON",
          raw: jsonText.slice(0, 400),
          openai_response_preview: JSON.stringify(data).slice(0, 800)
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders(allowedOrigin) }
        }
      );
    }
 
    // ✅ Small debug header so you can confirm the worker ran.
    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Worker-Alive": "1",
        ...corsHeaders(allowedOrigin)
      }
    });
 
    function extractTextFromResponsesOutput(d) {
      try {
        const out = Array.isArray(d.output) ? d.output : [];
        for (const item of out) {
          const content = Array.isArray(item.content) ? item.content : [];
          for (const c of content) {
            if (c && typeof c.text === "string" && c.text.trim()) return c.text.trim();
          }
        }
        return "";
      } catch {
        return "";
      }
    }
  }
};
 
/*
  CUSTOMIZE THIS FUNCTION (students must do this):
 
  Add the website origin that is allowed to call your Worker from the browser.
 
  GitHub Pages origin is only the base domain:
  https://yourusername.github.io
  Do NOT include your repo name after it.
*/
function isAllowedOrigin(origin) {
  if (!origin) return null;
 
  // Optional: allow Captivate preview on localhost while testing
  if (/^http:\/\/localhost:\d+$/.test(origin)) return origin;
 
  // Students MUST customize this line:
  if (origin === "https://yue7xu.github.io") return origin;
 
  return null;
}
 
// Do not edit this function.
function corsHeaders(origin) {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
