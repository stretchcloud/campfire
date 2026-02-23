import { useState, useEffect } from "react";
import { api } from "../api.js";
import { LinearLogo } from "./LinearLogo.js";
import { navigateTo } from "../utils/routing.js";

interface IntegrationCard {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  route: string;
  connected: boolean;
  checking: boolean;
}

export function IntegrationsPage({ embedded }: { embedded?: boolean }) {
  const [linearConnected, setLinearConnected] = useState(false);
  const [checkingLinear, setCheckingLinear] = useState(true);

  useEffect(() => {
    api.getSettings().then((s) => {
      if (s.linearApiKeyConfigured) {
        api.getLinearConnection()
          .then((conn) => setLinearConnected(conn.connected))
          .catch(() => setLinearConnected(false))
          .finally(() => setCheckingLinear(false));
      } else {
        setCheckingLinear(false);
      }
    }).catch(() => {
      setCheckingLinear(false);
    });
  }, []);

  const integrations: IntegrationCard[] = [
    {
      id: "linear",
      name: "Linear",
      description: "Browse issues and auto-generate branch names from Linear tickets.",
      icon: <LinearLogo className="w-8 h-8 text-[#5E6AD2]" />,
      route: "#/integrations/linear",
      connected: linearConnected,
      checking: checkingLinear,
    },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto">
        <h2 className="text-xl font-semibold text-cc-fg mb-2">Integrations</h2>
        <p className="text-sm text-cc-fg-muted mb-6">
          Connect external services to enhance your sessions.
        </p>

        <div className="grid gap-4">
          {integrations.map((integration) => (
            <button
              key={integration.id}
              onClick={() => navigateTo(integration.route)}
              className="flex items-center gap-4 p-4 rounded-lg border border-cc-border bg-cc-bg-subtle hover:bg-cc-bg-hover text-left transition-colors group"
            >
              <div className="shrink-0">{integration.icon}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-cc-fg">{integration.name}</span>
                  {integration.checking ? (
                    <span className="text-xs text-cc-fg-muted">checking…</span>
                  ) : integration.connected ? (
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
                      Connected
                    </span>
                  ) : (
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-cc-fg-muted/10 text-cc-fg-muted border border-cc-border">
                      Not connected
                    </span>
                  )}
                </div>
                <p className="text-xs text-cc-fg-muted mt-0.5">{integration.description}</p>
              </div>
              <div className="text-cc-fg-muted group-hover:text-cc-fg transition-colors">→</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
