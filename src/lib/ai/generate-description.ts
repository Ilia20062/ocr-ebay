/**
 * generate-description.ts
 *
 * Calls the OpenRouter Chat Completions API to produce a SEO-optimised
 * eBay listing description from a raw product title.
 *
 * - Retries on 408/425/429/5xx with exponential backoff. Does NOT retry on
 *   4xx (bad request / auth) — those are bugs, not transient failures.
 * - 60s request timeout via AbortController; the whole call cannot hang.
 * - Returns rich result metadata so callers can surface accurate status
 *   (e.g. "fallback used because OpenRouter 429") instead of silently
 *   shipping a placeholder description to eBay.
 */

import { log, type LogContext } from "@/lib/log";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
// Free tier by request (no OpenRouter balance required). Verified end-to-end
// through THIS file's generateListingDescription (real SYSTEM_PROMPT, real
// 60s timeout/retry path) before picking it — most OpenRouter free models
// are "thinking" models that spend their token budget on hidden
// chain-of-thought and either return empty content or, worse, leak the raw
// reasoning transcript as if it were the answer:
//   - openai/gpt-oss-20b:free            — burned its whole budget on
//                                           reasoning, returned null content.
//   - nvidia/nemotron-3-nano-30b-a3b:free — dumped raw chain-of-thought
//                                           ("We need to produce HTML...")
//                                           as `content`, finish_reason=length.
//   - nvidia/nemotron-3.5-lightning:free  — same failure, worse: burned the
//                                           full 4096-token cap on a
//                                           "Here's a thinking process:"
//                                           transcript and never reached an
//                                           answer.
//   - nvidia/nemotron-3-super-120b-a12b:free — output was correct when it
//                                           landed, but real single-request
//                                           latency exceeded the 60s timeout
//                                           on every attempt tested.
//   - liquid/lfm-2.5-2.6b:free           — exhausted all retries on timeout.
//   - google/gemma-4-31b-it:free         — persistently 429s (shared free
//                                           pool congestion upstream at
//                                           Google AI Studio).
// nemotron-nano-9b-v2:free is the one that actually held up: finish_reason
// stop, clean structured HTML matching the prompt, real API latency <1s in
// isolated testing. Override with OPENROUTER_MODEL if you want a paid model.
const DEFAULT_MODEL = "nvidia/nemotron-nano-9b-v2:free";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1_000; // 1s, 2s, 4s capped at 5s
// Free "thinking" models spend part of this budget on hidden reasoning
// tokens before ever emitting content. Doubled from the original 2048 for
// headroom; costs nothing extra unless the model actually uses it.
const MAX_COMPLETION_TOKENS = 4096;

const SYSTEM_PROMPT = `You are an eBay SEO and used OEM auto parts expert for the U.S. market.
Your task: based on the provided TITLE, generate a clean, ready-to-use eBay listing description in English (SEO-optimized for search).

Output rules:

Show only the final description text (HTML)— no explanations, no markdown, no brackets, no code blocks.

Do not output separate keyword or tag lists — keywords must appear naturally.

Audience: U.S. buyers. Use clear, natural American English with short paragraphs and lists for easy reading (especially on mobile).

Emojis allowed only for section icons and warnings: ⭐, 🛠️, 📐, 🔢, 📦, 🚫, 🔧, 🚚, ⚠️. No other emojis.

Always end with: "Ships within 1 business day" and "90-day warranty & easy returns" and "Expedited shipping".

Logic to follow:

Parse the TITLE for years, make, model, position/side, and part name.

Expand "left/right" into U.S. terms:

left → driver side, LH

right → passenger side, RH

Keep "front/rear" but repeat naturally (e.g. "rear left / driver side (LH)").

Convert British to American terms (bonnet → hood, boot → trunk, wing → fender).

In the first 1–2 lines, display the main OEM PN (if present in TITLE).

Include variations (no spaces, with spaces, with dashes, with prefix letter if applicable):
e.g. A2128200102; 2128200102; 212-820-01-02; A 212 820 01 02.

If PN unknown: write a careful note asking to verify by OEM PN or VIN.

Mention chassis/platform (e.g. Mercedes W218/C218/X218, BMW F10/F30, etc.) when confidently known.

In 📐 Compatibility: list years, make/model, platform/body, and side/position with synonyms (e.g. rear left / driver side (LH)).

Add a warning if applicable: ⚠️ Match by OEM PN and impedance for your audio package; options and build dates may change the required part.

In 🛠️ Condition: give truthful, verifiable statements — never assume.

Example: "Used OEM — inspected, cleaned, ready to install."

Add notes like "no structural damage observed" or "sound tested" only when typical for this part.

In ⭐ Key Features: list 3–5 brief bullet points (OEM fit, restores function/appearance, better than aftermarket, impedance match, etc.).

Avoid absolute guarantees unless certain.

In 🔢 Part Numbers, include the main OEM PN and its formats (if present in TITLE).

Then output exactly two lines in this format:

Interchange / Replaces: <list of 100% verified OEM PNs for this part, with dash variants and color/trim suffixes>;

Fits: <make model (chassis) years>; <short position/side from TITLE>.

Rules:

Only confirmed PNs (base, supersessions, color variants) (if present in TITLE).

Normalize like 8R0947292 and 8R0-947-292.

Add suffixes like (6PS – Soul Black) when known.

If left-side PN unknown → N/A.

No emojis, quotes, lists, or extra lines.

Include all sections in this exact order:

Short intro paragraph (1–2 lines: brand, model, years, side/position, OEM PN).

⭐ Key Features

🛠️ Condition

📐 Compatibility

🔢 Part Numbers

📦 What's Included

🚫 Not Included

🔧 Install & Tech Tips

🚚 Shipping & Warranty

Use natural keyword placement — no "keyword stuffing." Include synonyms naturally (e.g. tail light / tail lamp, door speaker / woofer / loudspeaker).

Don't promise specs or functions not confirmed by photo or data.

If unsure: use cautious wording ("verify on your original label").

Input:

You'll always receive a TITLE.

Never output links.

If OEM PN or label photo is known, include all format variations.

If info is limited, still produce a careful, informative description and recommend verifying by PN/VIN.

HTML FORMAT (required): Output valid HTML only. Wrap every paragraph in <p>. Use <ul><li> for every bullet list. Make each section heading a <p><strong>…</strong></p> with its emoji icon inside (e.g. <p><strong>⭐ Key Features</strong></p>). Do NOT use markdown, do NOT add an <html>/<body> wrapper, and do NOT use code fences.

Output:
Only the html of final description in perfect U.S. English, following all formatting and section rules above.`;

export type DescriptionSource = "ai" | "fallback";

/** Identifying context propagated into every log line for this call. */
export interface GenerateDescriptionContext {
  searchId?: string | null;
  batchId?: string | null;
  sku?: string | null;
  userId?: string | null;
}

export interface GenerateDescriptionResult {
  description: string;
  /** `'ai'` when OpenRouter produced usable text; `'fallback'` otherwise. */
  source: DescriptionSource;
  /** Whether a placeholder was substituted. Kept as alias of `source==='fallback'` for ergonomics. */
  usedFallback: boolean;
  /** Resolved model identifier used in the request. */
  model: string;
  /** OpenRouter `x-request-id` header — quote this when filing vendor tickets. */
  requestId?: string;
  /** OpenRouter `id` field from the response body. */
  responseId?: string;
  /** End-to-end wall time including retries (ms). */
  durMs: number;
  /** Number of HTTP attempts made. 0 when pre-flight rejected (no key, empty title). */
  attempts: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Populated when `source === 'fallback'`. Human-readable summary of *why*. */
  error?: string;
  /** Last HTTP status observed (set on non-OK responses). */
  lastStatus?: number;
  /** OpenRouter finish_reason from the chosen completion (e.g. `'stop'`, `'length'`). */
  finishReason?: string;
}

interface OpenRouterResponse {
  id?: string;
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  error?: { message?: string; code?: number | string; type?: string };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/** Sleep helper for retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(5_000, BASE_BACKOFF_MS * 2 ** (attempt - 1));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function looksLikeRefusal(content: string): boolean {
  if (content.length < 80) return true; // structured listing is always longer
  const low = content.toLowerCase().slice(0, 200);
  return (
    low.startsWith("i'm sorry") ||
    low.startsWith("i am sorry") ||
    low.startsWith("i cannot") ||
    low.startsWith("i can't") ||
    low.startsWith("as an ai") ||
    low.startsWith("sorry, ") ||
    low.includes("cannot comply")
  );
}

function sanitize(content: string): string {
  let s = content.trim();
  // Strip markdown fences if the model added them despite the prompt.
  if (s.startsWith("```")) {
    s = s
      .replace(/^```[a-zA-Z]*\n?/, "")
      .replace(/```\s*$/, "")
      .trim();
  }
  return s;
}

function fallbackDescription(title: string): string {
  const safeTitle = title?.trim() || "Used OEM auto part";
  return (
    `${safeTitle} — Used OEM auto part in good condition. ` +
    `Please verify fitment by OEM part number or VIN before ordering. ` +
    `Ships within 1 business day. 90-day warranty & easy returns. Expedited shipping available.`
  );
}

interface AttemptOutcome {
  kind: "ok" | "retry" | "fatal";
  content?: string;
  finishReason?: string;
  responseId?: string;
  requestId?: string;
  status?: number;
  usage?: OpenRouterResponse["usage"];
  err?: string;
}

/**
 * Try ONE call to the OpenRouter API. Returns a discriminated outcome so the
 * caller knows whether to retry, give up, or use the content.
 */
async function callOpenRouter(
  title: string,
  apiKey: string,
  model: string,
  attempt: number,
  baseCtx: LogContext,
): Promise<AttemptOutcome> {
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(), REQUEST_TIMEOUT_MS);
  const reqStart = Date.now();

  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      signal: aborter.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer":
          process.env.NEXT_PUBLIC_APP_URL ?? "https://localhost:3000",
        "X-Title": "OCR-CRM eBay Auto-Lister",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `TITLE: ${title}` },
        ],
        max_tokens: MAX_COMPLETION_TOKENS,
        temperature: 0.4,
      }),
    });

    const requestId = response.headers.get("x-request-id") ?? undefined;
    const reqDurMs = Date.now() - reqStart;

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "(no body)");
      const errCtx: LogContext = {
        ...baseCtx,
        attempt,
        status_code: response.status,
        request_id: requestId,
        dur_ms: reqDurMs,
        body_preview: bodyText.slice(0, 500),
      };

      if (isRetryableStatus(response.status)) {
        log.warn(`OpenRouter ${response.status} — will retry`, errCtx);
        return {
          kind: "retry",
          status: response.status,
          requestId,
          err: `HTTP ${response.status}`,
        };
      }

      log.error(
        "OpenRouter returned non-retryable error status",
        errCtx,
      );
      return {
        kind: "fatal",
        status: response.status,
        requestId,
        err: `HTTP ${response.status}: ${bodyText.slice(0, 300)}`,
      };
    }

    const data = (await response.json()) as OpenRouterResponse;

    if (data.error?.message) {
      log.error("OpenRouter returned error in response body", {
        ...baseCtx,
        attempt,
        status_code: response.status,
        request_id: requestId,
        response_id: data.id,
        api_error_code: data.error.code,
        api_error_type: data.error.type,
        err: data.error.message,
      });
      return {
        kind: "fatal",
        status: response.status,
        requestId,
        responseId: data.id,
        err: `OpenRouter API error: ${data.error.message}`,
      };
    }

    const choice = data.choices?.[0];
    const rawContent = choice?.message?.content?.trim();
    const finishReason = choice?.finish_reason;

    if (!rawContent) {
      log.error("OpenRouter returned empty content", {
        ...baseCtx,
        attempt,
        status_code: response.status,
        request_id: requestId,
        response_id: data.id,
        finish_reason: finishReason,
      });
      return {
        kind: "fatal",
        status: response.status,
        requestId,
        responseId: data.id,
        finishReason,
        err: "empty content from OpenRouter",
      };
    }

    if (looksLikeRefusal(rawContent)) {
      log.warn(
        "OpenRouter returned refusal-shaped content — treating as failure",
        {
          ...baseCtx,
          attempt,
          status_code: response.status,
          request_id: requestId,
          response_id: data.id,
          finish_reason: finishReason,
          content_preview: rawContent.slice(0, 200),
        },
      );
      return {
        kind: "fatal",
        status: response.status,
        requestId,
        responseId: data.id,
        finishReason,
        err: "refusal-shaped content",
      };
    }

    const cleaned = sanitize(rawContent);
    log.info("OpenRouter call succeeded", {
      ...baseCtx,
      attempt,
      status_code: response.status,
      request_id: requestId,
      response_id: data.id,
      finish_reason: finishReason,
      prompt_tokens: data.usage?.prompt_tokens,
      completion_tokens: data.usage?.completion_tokens,
      total_tokens: data.usage?.total_tokens,
      chars: cleaned.length,
      dur_ms: reqDurMs,
    });

    return {
      kind: "ok",
      content: cleaned,
      finishReason,
      responseId: data.id,
      requestId,
      status: response.status,
      usage: data.usage,
    };
  } catch (err) {
    const reqDurMs = Date.now() - reqStart;
    const isAbort = err instanceof Error && err.name === "AbortError";
    const errCtx: LogContext = { ...baseCtx, attempt, dur_ms: reqDurMs, err };
    if (isAbort) {
      log.error(
        `OpenRouter request timed out after ${REQUEST_TIMEOUT_MS}ms`,
        errCtx,
      );
      return { kind: "retry", err: `timeout after ${REQUEST_TIMEOUT_MS}ms` };
    }
    log.error("OpenRouter request failed with network error", errCtx);
    return {
      kind: "retry",
      err: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate an eBay listing description using OpenRouter AI.
 *
 * The caller should branch on `result.source`:
 *   - 'ai'       → use as-is
 *   - 'fallback' → AI failed; you got a safe placeholder, surface a warning
 */
export async function generateListingDescription(
  title: string,
  ctx: GenerateDescriptionContext = {},
): Promise<GenerateDescriptionResult> {
  const started = Date.now();
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
  const baseCtx: LogContext = {
    scope: "ai.openrouter",
    model,
    title_len: title?.length ?? 0,
    search_id: ctx.searchId ?? null,
    batch_id: ctx.batchId ?? null,
    sku: ctx.sku ?? null,
    user_id: ctx.userId ?? null,
  };

  if (!apiKey || apiKey.startsWith("sk-or-v1-your-key")) {
    const msg = "OPENROUTER_API_KEY missing or placeholder";
    log.warn(msg + " — returning fallback description", baseCtx);
    return {
      description: fallbackDescription(title),
      source: "fallback",
      usedFallback: true,
      model,
      durMs: Date.now() - started,
      attempts: 0,
      error: msg,
    };
  }

  if (!title || title.trim().length === 0) {
    log.error("Empty title supplied — refusing to call OpenRouter", baseCtx);
    return {
      description: fallbackDescription(title),
      source: "fallback",
      usedFallback: true,
      model,
      durMs: Date.now() - started,
      attempts: 0,
      error: "empty title",
    };
  }

  log.info("Generating description via OpenRouter", baseCtx);

  let lastErr: string | undefined;
  let lastStatus: number | undefined;
  let lastRequestId: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const outcome = await callOpenRouter(title, apiKey, model, attempt, baseCtx);
    lastErr = outcome.err ?? lastErr;
    lastStatus = outcome.status ?? lastStatus;
    lastRequestId = outcome.requestId ?? lastRequestId;

    if (outcome.kind === "ok" && outcome.content) {
      const durMs = Date.now() - started;
      log.info("Description generated", {
        ...baseCtx,
        attempts: attempt,
        dur_ms: durMs,
        request_id: outcome.requestId,
        response_id: outcome.responseId,
        chars: outcome.content.length,
      });
      return {
        description: outcome.content,
        source: "ai",
        usedFallback: false,
        model,
        requestId: outcome.requestId,
        responseId: outcome.responseId,
        durMs,
        attempts: attempt,
        promptTokens: outcome.usage?.prompt_tokens,
        completionTokens: outcome.usage?.completion_tokens,
        totalTokens: outcome.usage?.total_tokens,
        lastStatus: outcome.status,
        finishReason: outcome.finishReason,
      };
    }

    if (outcome.kind === "fatal") break;

    if (attempt < MAX_ATTEMPTS) {
      const wait = backoffMs(attempt);
      log.warn(`Backing off ${wait}ms before retrying OpenRouter`, {
        ...baseCtx,
        attempt,
        next_attempt: attempt + 1,
      });
      await sleep(wait);
    }
  }

  const durMs = Date.now() - started;
  log.error("All OpenRouter attempts exhausted — using fallback description", {
    ...baseCtx,
    attempts: MAX_ATTEMPTS,
    dur_ms: durMs,
    status_code: lastStatus,
    request_id: lastRequestId,
    err: lastErr,
  });

  return {
    description: fallbackDescription(title),
    source: "fallback",
    usedFallback: true,
    model,
    requestId: lastRequestId,
    durMs,
    attempts: MAX_ATTEMPTS,
    lastStatus,
    error: lastErr ?? "unknown error",
  };
}
