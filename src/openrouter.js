import { createHash } from "node:crypto";

export class OpenRouterError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
  }
}

async function readResponse(response) {
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new OpenRouterError(
      body?.error?.message || body?.message || "OpenRouter request failed",
      response.status,
    );
  }
  return body;
}

export class OpenRouterClient {
  constructor({ model, maxOutputTokens, publicUrl }) {
    this.model = model;
    this.maxOutputTokens = maxOutputTokens;
    this.publicUrl = publicUrl;
  }

  async complete({ apiKey, messages, sessionId, userId }) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": this.publicUrl,
        "X-Title": "Nullius",
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: this.maxOutputTokens,
        temperature: 0.35,
        session_id: sessionId,
        user: createHash("sha256").update(`discord:${userId}`).digest("hex").slice(0, 32),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await readResponse(response);
    const content = body?.choices?.[0]?.message?.content;
    const text = Array.isArray(content)
      ? content.map((part) => part?.text || "").join("")
      : content;
    if (!text?.trim()) throw new OpenRouterError("The model returned an empty answer", 502);

    return {
      text: text.trim(),
      cost: Number(body?.usage?.cost) || 0,
      model: body?.model || this.model,
    };
  }

  async validateKey(apiKey) {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    return readResponse(response);
  }

  async exchangeOAuthCode({ code, verifier }) {
    const response = await fetch("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: "S256",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await readResponse(response);
    if (!body?.key) throw new OpenRouterError("OpenRouter did not return a key", 502);
    return body.key;
  }
}
