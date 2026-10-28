// Minimal Gemini REST client for function calling. The key is a Worker secret.
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export function createGemini({ apiKey, model = 'gemini-3.1-flash-lite', fetchImpl = fetch, timeoutMs = 25000 } = {}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  return {
    model,
    async generate({ system, contents, tools, temperature = 0.4, maxOutputTokens = 3000 }) {
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations: tools }],
        toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: tools.map((t) => t.name) } },
        generationConfig: { temperature, maxOutputTokens },
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetchImpl(`${GEMINI_BASE}/${model}:generateContent`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
        });
        if ((res.status === 429 || res.status >= 500) && attempt === 0) { await new Promise((r) => setTimeout(r, 900)); continue; }
        if (!res.ok) throw new Error(`Gemini returned ${res.status}`);
        const j = await res.json();
        const content = j.candidates?.[0]?.content;
        if (!content?.parts?.length) throw new Error(`Gemini returned no content (${j.candidates?.[0]?.finishReason || 'unknown'})`);
        const calls = content.parts.filter((p) => p.functionCall).map((p) => ({ name: p.functionCall.name, args: p.functionCall.args || {}, id: p.functionCall.id }));
        return { content, calls, tokens: j.usageMetadata?.totalTokenCount ?? 0 };
      }
      throw new Error('Gemini was unavailable');
    },
  };
}
