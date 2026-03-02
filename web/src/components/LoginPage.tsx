import { useState } from "react";
import { api, setAuthToken } from "../api.js";

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password.trim()) return;
    setLoading(true);
    setError("");
    try {
      const { token } = await api.login(password);
      setAuthToken(token);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-[100dvh] flex items-center justify-center bg-cc-bg text-cc-fg px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <img src="/logo.svg" alt="" className="w-8 h-8 mx-auto mb-3 opacity-60" />
          <h1 className="text-[16px] font-semibold">Campfire</h1>
          <p className="text-[12px] text-cc-muted mt-1">Enter password to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoFocus
              className="w-full px-3 py-2 rounded-lg border border-cc-border bg-cc-input-bg text-cc-fg text-[13px] placeholder:text-cc-muted/50 focus:outline-none focus:border-cc-primary transition-colors"
            />
          </div>

          {error && (
            <p className="text-[12px] text-cc-error">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !password.trim()}
            className="w-full px-3 py-2 rounded-lg bg-cc-primary text-white text-[13px] font-medium hover:bg-cc-primary-hover disabled:opacity-50 transition-colors cursor-pointer"
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <p className="text-[10px] text-cc-muted/40 text-center mt-6">
          Set via CAMPFIRE_PASSWORD env var or Settings
        </p>
      </div>
    </div>
  );
}
