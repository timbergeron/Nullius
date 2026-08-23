import { createHash } from "node:crypto";

export class OpenRouterError extends Error {
  constructor(message, status = 500, cost = 0) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.cost = cost;
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
  constructor({ model, maxOutputTokens, retryOutputTokens, publicUrl, logger = console }) {
    this.model = model;
    this.maxOutputTokens = maxOutputTokens;
    this.retryOutputTokens = Math.max(
      maxOutputTokens,
      retryOutputTokens || maxOutputTokens * 2,
    );
    this.publicUrl = publicUrl;
    this.logger = logger;
  }

  async requestCompletion({ apiKey, messages, sessionId, userId, maxCompletionTokens }) {
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
        max_completion_tokens: maxCompletionTokens,
        temperature: 0.35,
        session_id: sessionId,
        user: createHash("sha256").update(`discord:${userId}`).digest("hex").slice(0, 32),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    return readResponse(response);
  }

  async complete({ apiKey, messages, sessionId, userId }) {
    const limits = [...new Set([this.maxOutputTokens, this.retryOutputTokens])];
    let totalCost = 0;

    for (let attempt = 0; attempt < limits.length; attempt += 1) {
      const body = await this.requestCompletion({
        apiKey,
        messages,
        sessionId,
        userId,
        maxCompletionTokens: limits[attempt],
      });
      totalCost += Number(body?.usage?.cost) || 0;
      const choice = body?.choices?.[0] || {};
      const content = choice.message?.content;
      const finishReason = choice.finish_reason || choice.native_finish_reason || "";
      const reasoningTokens = Number(
        body?.usage?.completion_tokens_details?.reasoning_tokens,
      ) || 0;
      const completionTokens = Number(body?.usage?.completion_tokens) || 0;
      const text = Array.isArray(content)
        ? content.map((part) => part?.text || "").join("")
        : content;
      const complete = Boolean(text?.trim()) && finishReason !== "length";

      if (complete) {
        return {
          text: text.trim(),
          cost: totalCost,
          model: body?.model || this.model,
        };
      }

      if (attempt + 1 < limits.length) {
        this.logger.warn?.("Retrying truncated OpenRouter completion", {
          model: body?.model || this.model,
          finishReason: finishReason || "empty",
          contentCharacters: typeof text === "string" ? text.length : 0,
          completionTokens,
          reasoningTokens,
          nextMaxCompletionTokens: limits[attempt + 1],
        });
        continue;
      }

      const reason = finishReason === "length"
        ? `The model exhausted ${limits[attempt]} completion tokens before finishing`
        : "The model returned an empty answer";
      throw new OpenRouterError(reason, 502, totalCost);
    }

    throw new OpenRouterError("The model returned an empty answer", 502);
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
