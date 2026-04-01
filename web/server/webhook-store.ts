import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { WebhookConfig, WebhookCreateInput } from "./webhook-types.js";
import { ALL_WEBHOOK_EVENTS } from "./webhook-types.js";

// ─── Paths ──────────────────────────────────────────────────────────────────

const CAMPFIRE_DIR = join(homedir(), ".campfire");
const WEBHOOKS_DIR = join(CAMPFIRE_DIR, "webhooks");

function ensureDir(): void {
  mkdirSync(WEBHOOKS_DIR, { recursive: true });
}

function filePath(id: string): string {
  return join(WEBHOOKS_DIR, `${id}.json`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export function listWebhooks(): WebhookConfig[] {
  ensureDir();
  try {
    const files = readdirSync(WEBHOOKS_DIR).filter((f) => f.endsWith(".json"));
    const webhooks: WebhookConfig[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(WEBHOOKS_DIR, file), "utf-8");
        webhooks.push(JSON.parse(raw));
      } catch {
        // Skip corrupt files
      }
    }
    webhooks.sort((a, b) => a.name.localeCompare(b.name));
    return webhooks;
  } catch {
    return [];
  }
}

export function getWebhook(id: string): WebhookConfig | null {
  ensureDir();
  try {
    const raw = readFileSync(filePath(id), "utf-8");
    return JSON.parse(raw) as WebhookConfig;
  } catch {
    return null;
  }
}

export function createWebhook(data: WebhookCreateInput): WebhookConfig {
  if (!data.name || !data.name.trim()) throw new Error("Webhook name is required");
  if (!data.url || !data.url.trim()) throw new Error("Webhook URL is required");
  if (!data.events || data.events.length === 0) throw new Error("At least one event is required");

  // Validate event names against allowed events
  for (const event of data.events) {
    if (!ALL_WEBHOOK_EVENTS.includes(event)) {
      throw new Error(`Invalid event: "${event}"`);
    }
  }

  const id = slugify(data.name.trim());
  if (!id) throw new Error("Webhook name must contain alphanumeric characters");

  ensureDir();
  if (existsSync(filePath(id))) {
    throw new Error(`A webhook with a similar name already exists ("${id}")`);
  }

  const now = Date.now();
  const webhook: WebhookConfig = {
    id,
    name: data.name.trim(),
    url: data.url.trim(),
    events: data.events,
    secret: data.secret,
    enabled: data.enabled ?? true,
    format: data.format,
    sessionFilter: data.sessionFilter,
    createdAt: now,
    updatedAt: now,
    totalDeliveries: 0,
    failedDeliveries: 0,
  };
  writeFileSync(filePath(id), JSON.stringify(webhook, null, 2), "utf-8");
  return webhook;
}

export function updateWebhook(
  id: string,
  updates: Partial<WebhookConfig>,
): WebhookConfig | null {
  ensureDir();
  const existing = getWebhook(id);
  if (!existing) return null;

  const newName = updates.name?.trim() || existing.name;
  const newId = slugify(newName);
  if (!newId) throw new Error("Webhook name must contain alphanumeric characters");

  // If name changed, check for slug collision with a different webhook
  if (newId !== id && existsSync(filePath(newId))) {
    throw new Error(`A webhook with a similar name already exists ("${newId}")`);
  }

  // Validate events if provided
  if (updates.events) {
    if (updates.events.length === 0) throw new Error("At least one event is required");
    for (const event of updates.events) {
      if (!ALL_WEBHOOK_EVENTS.includes(event)) {
        throw new Error(`Invalid event: "${event}"`);
      }
    }
  }

  const webhook: WebhookConfig = {
    ...existing,
    ...updates,
    id: newId,
    name: newName,
    updatedAt: Date.now(),
    // Preserve immutable fields
    createdAt: existing.createdAt,
  };

  // If id changed, delete old file
  if (newId !== id) {
    try {
      unlinkSync(filePath(id));
    } catch {
      /* ok */
    }
  }

  writeFileSync(filePath(newId), JSON.stringify(webhook, null, 2), "utf-8");
  return webhook;
}

export function deleteWebhook(id: string): boolean {
  ensureDir();
  if (!existsSync(filePath(id))) return false;
  try {
    unlinkSync(filePath(id));
    return true;
  } catch {
    return false;
  }
}
