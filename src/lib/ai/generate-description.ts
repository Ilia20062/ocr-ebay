/**
 * generate-description.ts
 *
 * Calls the OpenRouter Chat Completions API to produce a SEO-optimised
 * eBay listing description from a raw product title.
 *
 * Model is configurable via OPENROUTER_MODEL env var.
 * Falls back to a safe placeholder if the API call fails so the
 * listing pipeline is never blocked by an AI error.
 */

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-120b:free";

const SYSTEM_PROMPT = `You are an eBay SEO and used OEM auto parts expert for the U.S. market.
Your task: based on the provided TITLE, generate a clean, ready-to-use eBay listing description in English (SEO-optimized for search).

Output rules:

Show only the final description text — no explanations, no markdown, no brackets, no code blocks.

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

Output:
Only the final description in perfect U.S. English, following all formatting and section rules above.`;

export async function generateListingDescription(
  title: string,
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;

  if (!apiKey) {
    console.warn(
      "[generate-description] OPENROUTER_API_KEY not set — using fallback description",
    );
    return fallbackDescription(title);
  }

  try {
    console.log(
      `[generate-description] Generating description for title="${title}" using model=${model}`,
    );

    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
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
        max_tokens: 2048,
        temperature: 0.4,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "(no body)");
      throw new Error(`OpenRouter HTTP ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };

    if (data.error?.message) {
      throw new Error(`OpenRouter error: ${data.error.message}`);
    }

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("OpenRouter returned empty content");
    }

    console.log(
      `[generate-description] ✅ Generated ${content.length} chars for "${title}"`,
    );
    return content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[generate-description] ❌ Failed to generate description: ${msg}`,
    );
    return fallbackDescription(title);
  }
}

function fallbackDescription(title: string): string {
  return `${title} — Used OEM auto part in good condition. Please verify fitment by OEM part number or VIN before ordering. Ships within 1 business day. 90-day warranty & easy returns. Expedited shipping available.`;
}
