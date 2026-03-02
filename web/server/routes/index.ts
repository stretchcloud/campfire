import { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import { registerSessionRoutes } from "./session-routes.js";
import { registerRecordingRoutes } from "./recording-routes.js";
import { registerFsRoutes } from "./fs-routes.js";
import { registerEnvRoutes } from "./env-routes.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { registerGitRoutes } from "./git-routes.js";
import { registerSystemRoutes } from "./system-routes.js";
import { registerCronRoutes } from "./cron-routes.js";
import { registerGalleryRoutes } from "./gallery-routes.js";
import { registerWebhookRoutes } from "./webhook-routes.js";
import { registerAdapterRoutes } from "./adapter-routes.js";
import { registerCiRoutes } from "./ci-routes.js";
import { registerPromptRoutes } from "./prompt-routes.js";
import { registerLinearRoutes } from "./linear-routes.js";
import { registerDmuxRoutes } from "./dmux-routes.js";
import { registerOrchestratorRoutes } from "./orchestrator-routes.js";
import { registerSkillsRoutes } from "./skills-routes.js";

export function createRoutes(deps: RouteDeps): Hono {
  const api = new Hono();

  registerSessionRoutes(api, deps);
  registerRecordingRoutes(api, deps);
  registerFsRoutes(api, deps);
  registerEnvRoutes(api, deps);
  registerSettingsRoutes(api, deps);
  registerGitRoutes(api, deps);
  registerSystemRoutes(api, deps);
  registerCronRoutes(api, deps);
  registerGalleryRoutes(api, deps);
  registerWebhookRoutes(api, deps);
  registerAdapterRoutes(api, deps);
  registerCiRoutes(api, deps);
  registerPromptRoutes(api, deps);
  registerLinearRoutes(api, deps);
  registerDmuxRoutes(api, deps);
  registerOrchestratorRoutes(api, deps);
  registerSkillsRoutes(api, deps);

  return api;
}
