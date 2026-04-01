/**
 * Associates Linear issues with Campfire sessions.
 * Persisted to ~/.campfire/linear-session-issues.json
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

export interface LinkedIssue {
  issueId: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  teamKey: string;
  linkedAt: number;
}

interface IssueMap {
  [sessionId: string]: LinkedIssue;
}

const STORE_DIR = join(homedir(), ".campfire");
const STORE_PATH = join(STORE_DIR, "linear-session-issues.json");

function loadIssues(): IssueMap {
  if (!existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveIssues(data: IssueMap): void {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

/** Link a Linear issue to a session. */
export function linkIssueToSession(sessionId: string, issue: Omit<LinkedIssue, "linkedAt">): LinkedIssue {
  const data = loadIssues();
  const entry: LinkedIssue = { ...issue, linkedAt: Date.now() };
  data[sessionId] = entry;
  saveIssues(data);
  return entry;
}

/** Get the linked Linear issue for a session. */
export function getLinkedIssue(sessionId: string): LinkedIssue | null {
  const data = loadIssues();
  return data[sessionId] ?? null;
}

/** Remove the linked issue for a session. */
export function unlinkIssue(sessionId: string): boolean {
  const data = loadIssues();
  if (!(sessionId in data)) return false;
  delete data[sessionId];
  saveIssues(data);
  return true;
}

/** Transition a Linear issue to a new state via the API. */
export async function transitionIssue(
  issueId: string,
  stateId: string,
  apiKey: string,
): Promise<boolean> {
  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": apiKey,
      },
      body: JSON.stringify({
        query: `
          mutation TransitionIssue($issueId: String!, $stateId: String!) {
            issueUpdate(id: $issueId, input: { stateId: $stateId }) {
              success
            }
          }
        `,
        variables: { issueId, stateId },
      }),
    });
    const data = await res.json() as { data?: { issueUpdate?: { success: boolean } } };
    return data.data?.issueUpdate?.success ?? false;
  } catch {
    return false;
  }
}
