/**
 * Moltbook API client for posting gallery entries as "molts" (posts).
 *
 * Moltbook is a social network for AI agents (https://moltbook.com).
 * This client handles agent registration, posting, and status checking.
 *
 * API reference: https://www.moltbook.com/developers
 * Base URL: https://www.moltbook.com/api/v1
 */

const MOLTBOOK_API_BASE = "https://www.moltbook.com/api/v1";

interface MoltbookPost {
  submolt: string;
  title: string;
  content: string;
  url?: string;
}

interface MoltbookPostResult {
  ok: boolean;
  postId?: string;
  postUrl?: string;
  error?: string;
}

interface MoltbookAgentInfo {
  name: string;
  description?: string;
  karma?: number;
  isClaimed?: boolean;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function moltbookFetch(
  path: string,
  apiKey: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(`${MOLTBOOK_API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "campfire/1.0",
      ...options.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Check if a Moltbook API key is configured and valid. */
export async function checkMoltbookStatus(apiKey: string): Promise<{
  available: boolean;
  agent?: MoltbookAgentInfo;
  error?: string;
}> {
  if (!apiKey) {
    return { available: false, error: "No Moltbook API key configured" };
  }

  try {
    const res = await moltbookFetch("/agents/me", apiKey);
    if (!res.ok) {
      const body = await res.text().catch(() => "unknown error");
      return { available: false, error: `API key invalid: ${body}` };
    }
    const agent = (await res.json()) as MoltbookAgentInfo;
    return { available: true, agent };
  } catch (err) {
    return {
      available: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Post a gallery entry to Moltbook as a "molt" in the given submolt. */
export async function postToMoltbook(opts: {
  apiKey: string;
  title: string;
  content: string;
  replayUrl: string;
  submolt?: string;
}): Promise<MoltbookPostResult> {
  if (!opts.apiKey) {
    return { ok: false, error: "No Moltbook API key configured" };
  }

  const body: MoltbookPost = {
    submolt: opts.submolt || "general",
    title: opts.title,
    content: `${opts.content}\n\n---\n**Session Replay:** ${opts.replayUrl}`,
  };

  try {
    const res = await moltbookFetch("/posts", opts.apiKey, {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "unknown error");
      return { ok: false, error: `HTTP ${res.status}: ${errBody}` };
    }

    const result = (await res.json()) as { id?: string; slug?: string };
    const postId = result.id || result.slug;
    return {
      ok: true,
      postId,
      postUrl: postId ? `https://www.moltbook.com/post/${postId}` : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Register a new agent on Moltbook and return the API key. */
export async function registerMoltbookAgent(opts: {
  name: string;
  description?: string;
}): Promise<{ ok: boolean; apiKey?: string; error?: string }> {
  try {
    const res = await fetch(`${MOLTBOOK_API_BASE}/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "campfire/1.0",
      },
      body: JSON.stringify({
        name: opts.name,
        description: opts.description || "AI coding agent via Campfire",
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "unknown error");
      return { ok: false, error: `HTTP ${res.status}: ${body}` };
    }

    const result = (await res.json()) as { api_key?: string };
    if (!result.api_key) {
      return { ok: false, error: "Registration succeeded but no API key returned" };
    }
    return { ok: true, apiKey: result.api_key };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
