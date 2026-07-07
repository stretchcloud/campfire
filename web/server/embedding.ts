/**
 * Embedding provider abstraction for semantic memory.
 *
 * Supports two providers:
 * - "openai": text-embedding-3-small (1536-dim) via OpenAI API
 * - "ollama": nomic-embed-text (768-dim) via local Ollama at http://localhost:11434
 * - "none": returns zero-vectors (disables vector search, fragments stored without embeddings)
 *
 * Provider is configured in ~/.campfire/settings.json via embeddingProvider field.
 */

import { getSettings, type EmbeddingProvider } from "./settings-manager.js";

export const OPENAI_DIM = 1536;
export const OLLAMA_DIM = 768;

/** Name of the currently configured embedding provider. */
export function getEmbeddingProviderName(): EmbeddingProvider {
  return getSettings().embeddingProvider;
}

/**
 * Generate an embedding vector for the given text using the configured provider.
 * Returns null if provider is "none" or if the embedding call fails.
 */
export async function embed(text: string): Promise<number[] | null> {
  const settings = getSettings();

  if (settings.embeddingProvider === "openai") {
    return embedWithOpenAI(text, settings.embeddingApiKey, settings.embeddingModel || "text-embedding-3-small");
  }

  if (settings.embeddingProvider === "ollama") {
    return embedWithOllama(text, settings.embeddingBaseUrl || "http://localhost:11434", settings.embeddingModel || "nomic-embed-text");
  }

  return null;
}

/**
 * Return the embedding dimension for the currently configured provider.
 * Used when creating LanceDB tables so the vector column has the correct width.
 *
 * v2 (design §3.5.2): returns null when provider is "none" — the old fake
 * 1536 default caused dimension lock-in. With provider "none", no vector is
 * populated and fragments are stored with embeddingStatus = "none".
 */
export function getEmbeddingDim(): number | null {
  const settings = getSettings();
  if (settings.embeddingProvider === "openai") return OPENAI_DIM;
  if (settings.embeddingProvider === "ollama") return OLLAMA_DIM;
  return null;
}

async function embedWithOpenAI(text: string, apiKey: string, model: string): Promise<number[] | null> {
  if (!apiKey) {
    console.warn("[embedding] OpenAI provider configured but no API key set");
    return null;
  }
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: text }),
    });
    if (!res.ok) {
      console.warn(`[embedding] OpenAI API error ${res.status}: ${await res.text()}`);
      return null;
    }
    const json = await res.json() as { data: Array<{ embedding: number[] }> };
    return json.data[0]?.embedding ?? null;
  } catch (err) {
    console.warn("[embedding] OpenAI request failed:", err);
    return null;
  }
}

async function embedWithOllama(text: string, baseUrl: string, model: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
    });
    if (!res.ok) {
      console.warn(`[embedding] Ollama API error ${res.status}: ${await res.text()}`);
      return null;
    }
    const json = await res.json() as { embedding: number[] };
    return json.embedding ?? null;
  } catch (err) {
    console.warn("[embedding] Ollama request failed:", err);
    return null;
  }
}
