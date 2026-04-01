/** Hash-based routing utilities for the Campfire app. */

export type AppRoute =
  | { type: "home" }
  | { type: "session"; id: string }
  | { type: "settings" }
  | { type: "terminal" }
  | { type: "environments" }
  | { type: "scheduled" }
  | { type: "gallery" }
  | { type: "webhooks" }
  | { type: "adapters" }
  | { type: "clawhub" }
  | { type: "agents" }
  | { type: "prompts" }
  | { type: "integrations" }
  | { type: "integrations/linear" }
  | { type: "replay"; filename?: string; sessionId?: string }
  | { type: "public-replay"; token: string }
  | { type: "playground" }
  | { type: "unknown" };

export function parseHash(hash: string = window.location.hash): AppRoute {
  if (!hash || hash === "#/" || hash === "#") return { type: "home" };
  if (hash === "#/settings") return { type: "settings" };
  if (hash === "#/terminal") return { type: "terminal" };
  if (hash === "#/environments") return { type: "environments" };
  if (hash === "#/scheduled") return { type: "scheduled" };
  if (hash === "#/gallery") return { type: "gallery" };
  if (hash === "#/webhooks") return { type: "webhooks" };
  if (hash === "#/adapters") return { type: "adapters" };
  if (hash === "#/clawhub") return { type: "clawhub" };
  if (hash === "#/agents") return { type: "agents" };
  if (hash === "#/prompts") return { type: "prompts" };
  if (hash === "#/integrations") return { type: "integrations" };
  if (hash === "#/integrations/linear") return { type: "integrations/linear" };
  if (hash === "#/playground") return { type: "playground" };

  const replaySessionMatch = hash.match(/^#\/replay\/session\/(.+)$/);
  if (replaySessionMatch) return { type: "replay", sessionId: replaySessionMatch[1] };

  const replayFileMatch = hash.match(/^#\/replay\/(?!session\/)(.+)$/);
  if (replayFileMatch) return { type: "replay", filename: replayFileMatch[1] };

  const publicReplayMatch = hash.match(/^#\/public-replay\/(.+)$/);
  if (publicReplayMatch) return { type: "public-replay", token: publicReplayMatch[1] };

  return { type: "unknown" };
}

export function sessionHash(sessionId: string): string {
  return `#/session/${sessionId}`;
}

export function navigateToSession(sessionId: string): void {
  // Sessions don't use hash routing — they use the store's currentSessionId.
  // This just clears any full-page route hash so the session view shows.
  if (window.location.hash.startsWith("#/") && !window.location.hash.match(/^#\/session\//)) {
    window.location.hash = "";
  }
}

export function navigateHome(): void {
  window.location.hash = "";
}

export function navigateTo(route: string): void {
  window.location.hash = route;
}
