import { CONDENSE_TIMEOUT_MS, GEMINI_API_BASE, GEMINI_DEFAULT_MODEL, MAX_QUERY_LENGTH } from "./constants.js";
import type { Env } from "./env.js";

/**
 * Turns a chat thread into something a search can use.
 *
 * Linear's semantic search matches a query against issue text, and a thread is
 * not a query: twenty messages about three subjects average out to nothing in
 * particular. Its ranking is also markedly better in English, and the issues
 * are written in English, so the phrase is translated on the way out.
 *
 * The model's entire output is a search phrase. It never sees the issue list,
 * never writes into the room, and has no path to the bridge's replies.
 */

const INSTRUCTION = [
  "Below is a chat thread. Reply with a short search phrase in English, at most 12 words,",
  "naming the concrete topic, task or problem being discussed.",
  "Translate if the thread is in another language.",
  "No preamble, no quotes, no explanation.",
  "If the thread has no substantive topic, reply with exactly NONE.",
].join(" ");

export const NO_TOPIC = "NONE";

export function condensingEnabled(env: Env): boolean {
  return Boolean(env.GEMINI_API_KEY);
}

/** Returns null when condensing is off or fails, so the caller falls back to the raw text. */
export async function condenseThread(env: Env, text: string): Promise<string | null> {
  if (!env.GEMINI_API_KEY) {
    return null;
  }

  const model = env.GEMINI_MODEL ?? GEMINI_DEFAULT_MODEL;

  try {
    const response = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${INSTRUCTION}\n\n${text}` }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 2048 },
      }),
      signal: AbortSignal.timeout(CONDENSE_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error(`Condensing failed: ${response.status}`);
      return null;
    }

    const payload = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const phrase = (payload.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim();

    return phrase ? phrase.slice(0, MAX_QUERY_LENGTH) : null;
  } catch (error) {
    console.error("Condensing failed", error);
    return null;
  }
}
