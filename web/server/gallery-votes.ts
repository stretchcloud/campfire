import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// ─── Paths ──────────────────────────────────────────────────────────────────

const GALLERY_DIR = join(homedir(), ".companion", "gallery");
const VOTES_FILE = join(GALLERY_DIR, "votes.json");

type VoteDirection = 1 | -1;
type VotesData = Record<string, Record<string, VoteDirection>>;

function ensureDir(): void {
  mkdirSync(GALLERY_DIR, { recursive: true });
}

// ─── Load / Save ────────────────────────────────────────────────────────────

function loadVotes(): VotesData {
  try {
    if (!existsSync(VOTES_FILE)) return {};
    const raw = readFileSync(VOTES_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveVotes(data: VotesData): void {
  ensureDir();
  writeFileSync(VOTES_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Hash an IP address for anonymous vote deduplication.
 * Uses SHA-256 so raw IPs are never stored.
 */
export function getVoterHash(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

/**
 * Record a vote (upvote=1, downvote=-1).
 * If the voter already voted the same direction, the vote is removed (toggle).
 * If the voter voted the opposite direction, the vote is flipped.
 * Returns the new total vote count for the entry.
 */
export function recordVote(
  entryId: string,
  voterId: string,
  direction: VoteDirection,
): number {
  const data = loadVotes();
  if (!data[entryId]) {
    data[entryId] = {};
  }

  const existing = data[entryId][voterId];
  if (existing === direction) {
    // Toggle off: remove vote
    delete data[entryId][voterId];
  } else {
    // New vote or flip direction
    data[entryId][voterId] = direction;
  }

  saveVotes(data);
  return getVoteCount(entryId, data);
}

/**
 * Get the total vote count for an entry (sum of all +1/-1 votes).
 */
export function getVoteCount(entryId: string, data?: VotesData): number {
  const votes = data || loadVotes();
  const entryVotes = votes[entryId];
  if (!entryVotes) return 0;
  return Object.values(entryVotes).reduce((sum, v) => sum + v, 0);
}

/**
 * Check if a voter has already voted on an entry.
 */
export function hasVoted(entryId: string, voterId: string): VoteDirection | null {
  const data = loadVotes();
  return data[entryId]?.[voterId] ?? null;
}

/**
 * Remove all votes for a gallery entry (called on entry deletion).
 */
export function removeEntryVotes(entryId: string): void {
  const data = loadVotes();
  if (data[entryId]) {
    delete data[entryId];
    saveVotes(data);
  }
}
