/// REST client for the Campfire server.
/// Uses reqwest with JSON deserialization.
use crate::protocol::{BackendInfo, SessionInfo};
use reqwest::Client;

pub struct ApiClient {
    base_url: String,
    client: Client,
}

impl ApiClient {
    pub fn new(base_url: &str) -> Self {
        Self {
            base_url: base_url.to_string(),
            client: Client::new(),
        }
    }

    /// GET /api/sessions — returns all non-archived sessions
    pub async fn list_sessions(&self) -> anyhow::Result<Vec<SessionInfo>> {
        let url = format!("{}/api/sessions", self.base_url);
        let resp = self.client.get(&url).send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("list_sessions: HTTP {}", resp.status());
        }
        let sessions: Vec<SessionInfo> = resp.json().await?;
        // Filter out archived sessions
        let active: Vec<SessionInfo> = sessions
            .into_iter()
            .filter(|s| s.state.as_deref() != Some("archived") && s.archived != Some(true))
            .collect();
        Ok(active)
    }

    /// GET /api/backends — returns available backend types
    pub async fn list_backends(&self) -> anyhow::Result<Vec<BackendInfo>> {
        let url = format!("{}/api/backends", self.base_url);
        let resp = self.client.get(&url).send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("list_backends: HTTP {}", resp.status());
        }
        let backends: Vec<BackendInfo> = resp.json().await?;
        Ok(backends)
    }

    /// POST /api/sessions/create — create a new session
    pub async fn create_session(
        &self,
        backend_type: &str,
        cwd: &str,
    ) -> anyhow::Result<String> {
        let url = format!("{}/api/sessions/create", self.base_url);
        let body = serde_json::json!({
            "backendType": backend_type,
            "cwd": cwd,
        });
        let resp = self.client.post(&url).json(&body).send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("create_session: HTTP {}", resp.status());
        }
        let data: serde_json::Value = resp.json().await?;
        let id = data
            .get("sessionId")
            .or_else(|| data.get("id"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("no sessionId in response"))?
            .to_string();
        Ok(id)
    }

    /// POST /api/sessions/:id/kill — stop a session's agent
    pub async fn kill_session(&self, session_id: &str) -> anyhow::Result<()> {
        let url = format!("{}/api/sessions/{}/kill", self.base_url, session_id);
        self.client.post(&url).send().await?;
        Ok(())
    }

    /// Convert an HTTP URL to a WebSocket URL for the browser WS endpoint.
    /// http://localhost:3456 → ws://localhost:3456/ws/browser/:id
    pub fn ws_url(&self, session_id: &str) -> String {
        let base = self.base_url
            .replace("https://", "wss://")
            .replace("http://", "ws://");
        format!("{}/ws/browser/{}", base, session_id)
    }
}
