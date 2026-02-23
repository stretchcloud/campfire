/// Minimal serde types for the Campfire browser WebSocket protocol.
/// Only the message types the TUI actually needs are represented here.
/// Unknown fields are ignored via `#[serde(other)]` or `flatten`.
use serde::{Deserialize, Serialize};

// ─── Outgoing (TUI → server) ──────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutgoingMessage {
    SessionSubscribe {
        #[serde(rename = "sessionId")]
        session_id: String,
        client_msg_id: String,
    },
    UserMessage {
        content: String,
        client_msg_id: String,
    },
    PermissionResponse {
        request_id: String,
        behavior: String,          // "allow_once" | "reject_once" | "allow_always"
        tool_name: Option<String>,
    },
    Interrupt {},
}

// ─── Incoming (server → TUI) ─────────────────────────────────────────────────

/// Top-level envelope — we tag-match on `type` and decode the rest lazily.
#[derive(Debug, Deserialize)]
pub struct RawIncoming {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(flatten)]
    pub rest: serde_json::Value,
}

/// A session returned by GET /api/sessions
#[derive(Debug, Clone, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub name: Option<String>,
    pub state: Option<String>,    // "connected" | "disconnected" | "pending" | etc.
    #[serde(rename = "backendType")]
    pub backend_type: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "contextUsedPercent")]
    pub context_used_percent: Option<f64>,
}

impl SessionInfo {
    pub fn display_name(&self) -> String {
        self.name
            .clone()
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| self.id.chars().take(8).collect())
    }
}

/// A backend descriptor from GET /api/backends
#[derive(Debug, Clone, Deserialize)]
pub struct BackendInfo {
    pub id: String,
    pub name: String,
    pub available: bool,
}

/// A fully-rendered chat message (from `assistant`, `user_message`, `result`)
#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: MessageRole,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MessageRole {
    Assistant,
    User,
    Tool { name: String },
    System,
    Error,
}

/// Decoded `permission_request` payload
#[derive(Debug, Clone, Deserialize)]
pub struct PermissionRequest {
    pub request_id: String,
    pub tool_name: String,
    pub tool_input: Option<serde_json::Value>,
    pub description: Option<String>,
}

/// Parse an incoming raw WebSocket text frame into a typed event the app cares about.
pub enum IncomingEvent {
    /// Server confirmed session and sent initial state
    SessionInit { backend_type: String, model: String, context_used_percent: f64 },
    /// Bulk history load on subscribe
    MessageHistory(Vec<ChatMessage>),
    /// A complete assistant message
    AssistantMessage(String),
    /// A streaming text chunk
    TextDelta(String),
    /// Streaming stopped — flush the buffer
    TextStop,
    /// A tool call summary line
    ToolUse { tool_name: String, description: String },
    /// Tool result summary
    ToolResult { tool_name: String, is_error: bool },
    /// Turn completed
    TurnResult { is_error: bool, message: String },
    /// User message echoed back
    UserMessage(String),
    /// Permission needed
    PermissionRequest(PermissionRequest),
    /// Permission no longer needed (agent interrupted or timed out)
    PermissionCancelled { request_id: String },
    /// CLI process connected/disconnected
    CliConnected,
    CliDisconnected,
    /// Anything we don't need to act on
    Ignored,
}

/// Decode a raw JSON frame from the server into a typed event.
pub fn decode(raw: &str) -> IncomingEvent {
    let Ok(envelope) = serde_json::from_str::<RawIncoming>(raw) else {
        return IncomingEvent::Ignored;
    };

    match envelope.msg_type.as_str() {
        "session_init" => {
            let session = envelope.rest.get("session");
            let backend_type = session
                .and_then(|s| s.get("backend_type"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let model = session
                .and_then(|s| s.get("model"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let ctx = session
                .and_then(|s| s.get("context_used_percent"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            IncomingEvent::SessionInit { backend_type, model, context_used_percent: ctx }
        }

        "message_history" => {
            // messages: array of {role, content, ...}
            let messages = envelope.rest
                .get("messages")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(decode_history_msg).collect())
                .unwrap_or_default();
            IncomingEvent::MessageHistory(messages)
        }

        "assistant" => {
            let text = extract_text_from_message(&envelope.rest);
            if text.is_empty() {
                IncomingEvent::Ignored
            } else {
                IncomingEvent::AssistantMessage(text)
            }
        }

        "user_message" => {
            let content = envelope.rest
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if content.is_empty() {
                IncomingEvent::Ignored
            } else {
                IncomingEvent::UserMessage(content)
            }
        }

        "stream_event" => {
            let event = envelope.rest.get("event");
            let event_type = event
                .and_then(|e| e.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            match event_type {
                "content_block_delta" => {
                    let delta = event
                        .and_then(|e| e.get("delta"))
                        .and_then(|d| d.get("text"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if delta.is_empty() {
                        IncomingEvent::Ignored
                    } else {
                        IncomingEvent::TextDelta(delta.to_string())
                    }
                }
                "content_block_stop" => IncomingEvent::TextStop,
                _ => IncomingEvent::Ignored,
            }
        }

        "tool_progress" => {
            let tool_name = envelope.rest
                .get("tool_name")
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            let description = envelope.rest
                .get("input")
                .map(|v| truncate_json(v, 80))
                .unwrap_or_default();
            IncomingEvent::ToolUse { tool_name, description }
        }

        "result" => {
            let is_error = envelope.rest
                .get("is_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let message = if is_error {
                envelope.rest
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Error")
                    .to_string()
            } else {
                String::new()
            };
            IncomingEvent::TurnResult { is_error, message }
        }

        "permission_request" => {
            if let Ok(perm) = serde_json::from_value::<PermissionRequest>(envelope.rest) {
                IncomingEvent::PermissionRequest(perm)
            } else {
                IncomingEvent::Ignored
            }
        }

        "permission_cancelled" => {
            let request_id = envelope.rest
                .get("request_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            IncomingEvent::PermissionCancelled { request_id }
        }

        "cli_connected" => IncomingEvent::CliConnected,
        "cli_disconnected" => IncomingEvent::CliDisconnected,

        _ => IncomingEvent::Ignored,
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn decode_history_msg(v: &serde_json::Value) -> Option<ChatMessage> {
    let role_str = v.get("role").and_then(|r| r.as_str()).unwrap_or("");
    let content = extract_text_from_message(v);
    if content.is_empty() {
        return None;
    }
    let role = match role_str {
        "assistant" => MessageRole::Assistant,
        "user" => MessageRole::User,
        _ => return None,
    };
    Some(ChatMessage { role, content })
}

fn extract_text_from_message(v: &serde_json::Value) -> String {
    // Try message.content as array of {type:"text", text:"..."}
    if let Some(arr) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
        let texts: Vec<&str> = arr
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect();
        if !texts.is_empty() {
            return texts.join("\n");
        }
    }
    // Try content as string directly
    if let Some(s) = v.get("content").and_then(|c| c.as_str()) {
        return s.to_string();
    }
    // Try message.content as string
    if let Some(s) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_str()) {
        return s.to_string();
    }
    String::new()
}

fn truncate_json(v: &serde_json::Value, max: usize) -> String {
    let s = serde_json::to_string(v).unwrap_or_default();
    if s.len() <= max {
        s
    } else {
        format!("{}…", &s[..max])
    }
}
