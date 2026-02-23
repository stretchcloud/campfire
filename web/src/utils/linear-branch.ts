/** Utilities for generating git branch names from Linear issues. */

export interface LinearIssue {
  id: string;
  identifier: string; // e.g. "ENG-123"
  title: string;
  url?: string;
  state?: { name: string };
  team?: { key: string };
}

/**
 * Converts a Linear issue identifier + title into a slug suitable for a branch name.
 * Example: "ENG-123", "Add user authentication" → "eng-123-add-user-authentication"
 */
export function linearBranchSlug(identifier: string, title: string): string {
  const id = identifier.toLowerCase().replace(/\s+/g, "-");
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50)
    .replace(/-$/, "");
  return `${id}-${slug}`;
}

/**
 * Resolves a recommended branch name from a Linear issue, prefixed by type.
 * Defaults to "feat/" prefix; uses "fix/" if the issue state name contains "bug".
 */
export function resolveLinearBranch(issue: LinearIssue): string {
  const isBug = issue.state?.name?.toLowerCase().includes("bug") ?? false;
  const prefix = isBug ? "fix" : "feat";
  const slug = linearBranchSlug(issue.identifier, issue.title);
  return `${prefix}/${slug}`;
}
