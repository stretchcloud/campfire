import type { DetectedEnvironmentRule, McpServerConfig } from "./session-types.js";

export interface PackageJsonLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export interface ProjectContext {
  cwd: string;
  files: Set<string>;
  dirs: Set<string>;
  packageJson?: PackageJsonLike;
  envVars: Record<string, string>;
}

export interface DetectionRule {
  id: string;
  name: string;
  description: string;
  envRequired?: string[];
  detect(ctx: ProjectContext): boolean;
  mcpServer?: McpServerConfig;
}

function hasDependency(ctx: ProjectContext, dep: string): boolean {
  return Boolean(ctx.packageJson?.dependencies?.[dep] || ctx.packageJson?.devDependencies?.[dep]);
}

function hasAnyDependency(ctx: ProjectContext, deps: string[]): boolean {
  return deps.some((dep) => hasDependency(ctx, dep));
}

function envServer(command: string, args: string[] = []): McpServerConfig {
  return { type: "stdio", command, args };
}

export const ENVIRONMENT_RULES: DetectionRule[] = [
  {
    id: "supabase",
    name: "Supabase",
    description: "Supabase project or SDK detected.",
    envRequired: ["SUPABASE_URL"],
    detect: (ctx) => Boolean(ctx.envVars.SUPABASE_URL) || hasAnyDependency(ctx, ["@supabase/supabase-js", "supabase"]),
    mcpServer: envServer("npx", ["-y", "@supabase/mcp-server-supabase"]),
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Stripe SDK or secret key detected.",
    envRequired: ["STRIPE_SECRET_KEY"],
    detect: (ctx) => Boolean(ctx.envVars.STRIPE_SECRET_KEY) || hasDependency(ctx, "stripe"),
    mcpServer: envServer("npx", ["-y", "@stripe/mcp"]),
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "Vercel or Next.js deployment target detected.",
    detect: (ctx) => ctx.files.has("vercel.json") || hasDependency(ctx, "next"),
    mcpServer: envServer("npx", ["-y", "@vercel/mcp-server"]),
  },
  {
    id: "prisma",
    name: "Prisma",
    description: "Prisma schema or dependency detected.",
    envRequired: ["DATABASE_URL"],
    detect: (ctx) => ctx.files.has("prisma/schema.prisma") || hasAnyDependency(ctx, ["prisma", "@prisma/client"]),
  },
  {
    id: "docker",
    name: "Docker",
    description: "Dockerfile or compose configuration detected.",
    detect: (ctx) => ctx.files.has("Dockerfile") || ctx.files.has("docker-compose.yml") || ctx.files.has("docker-compose.yaml"),
  },
  {
    id: "flyio",
    name: "Fly.io",
    description: "Fly.io deployment configuration detected.",
    detect: (ctx) => ctx.files.has("fly.toml"),
  },
  {
    id: "github-actions",
    name: "GitHub Actions",
    description: "GitHub Actions workflow directory detected.",
    detect: (ctx) => ctx.dirs.has(".github/workflows"),
  },
  {
    id: "database",
    name: "Database",
    description: "Database connection configuration detected.",
    envRequired: ["DATABASE_URL"],
    detect: (ctx) => Boolean(ctx.envVars.DATABASE_URL),
  },
];

export function toDetectedRule(rule: DetectionRule, envVars: Record<string, string>): DetectedEnvironmentRule {
  const envRequired = rule.envRequired ?? [];
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description,
    envRequired: envRequired.length ? envRequired : undefined,
    envPresent: envRequired.filter((name) => Boolean(envVars[name])),
    envMissing: envRequired.filter((name) => !envVars[name]),
  };
}
