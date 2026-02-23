/// Core application state and main event loop.
use crate::{
    api::ApiClient,
    events::{spawn_event_task, AppEvent},
    protocol::{BackendInfo, ChatMessage, MessageRole, OutgoingMessage, PermissionRequest, SessionInfo},
    ui,
    ws::{run_ws_task, WsEvent},
};
use crossterm::event::{KeyCode, KeyModifiers};
use ratatui::{backend::CrosstermBackend, Terminal};
use serde_json;
use std::io::Stdout;
use tokio::sync::mpsc;
use uuid::Uuid;

// ─── Mode ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum Mode {
    /// Navigate the session list; scroll messages
    Normal,
    /// Typing in the composer
    Insert,
    /// Permission overlay is visible
    PermissionPrompt,
    /// New-session backend picker
    NewSession,
}

// ─── App ──────────────────────────────────────────────────────────────────────

pub struct App {
    // ── connection ───────────────────────────────────────────────────────────
    pub server_url: String,
    pub api: ApiClient,

    // ── session list ─────────────────────────────────────────────────────────
    pub sessions: Vec<SessionInfo>,
    pub session_cursor: usize,           // highlighted row in session list
    pub active_session: Option<String>,  // currently viewed session ID

    // ── chat panel ───────────────────────────────────────────────────────────
    pub messages: Vec<ChatMessage>,
    pub streaming_text: String,         // accumulates content_block_delta chunks
    pub chat_scroll: u16,               // lines scrolled up from bottom

    // ── composer ─────────────────────────────────────────────────────────────
    pub input: String,
    pub input_cursor: usize,            // byte position in input

    // ── mode ─────────────────────────────────────────────────────────────────
    pub mode: Mode,

    // ── permission overlay ───────────────────────────────────────────────────
    pub pending_permission: Option<PermissionRequest>,

    // ── new-session picker ───────────────────────────────────────────────────
    pub backends: Vec<BackendInfo>,
    pub backend_cursor: usize,

    // ── websocket ────────────────────────────────────────────────────────────
    pub ws_tx: Option<mpsc::Sender<String>>,  // send raw JSON strings to WS task

    // ── session metadata (from session_init) ─────────────────────────────────
    pub backend_type: String,
    pub model: String,
    pub context_used_percent: f64,
    pub ws_connected: bool,

    // ── status bar ───────────────────────────────────────────────────────────
    pub status: String,

    // ── quit flag ────────────────────────────────────────────────────────────
    pub should_quit: bool,
}

impl App {
    pub fn new(server_url: String) -> Self {
        let api = ApiClient::new(&server_url);
        Self {
            server_url,
            api,
            sessions: vec![],
            session_cursor: 0,
            active_session: None,
            messages: vec![],
            streaming_text: String::new(),
            chat_scroll: 0,
            input: String::new(),
            input_cursor: 0,
            mode: Mode::Normal,
            pending_permission: None,
            backends: vec![],
            backend_cursor: 0,
            ws_tx: None,
            backend_type: String::new(),
            model: String::new(),
            context_used_percent: 0.0,
            ws_connected: false,
            status: String::from("Loading sessions…"),
            should_quit: false,
        }
    }

    // ─── Session list ─────────────────────────────────────────────────────────

    pub fn cursor_up(&mut self) {
        if self.session_cursor > 0 {
            self.session_cursor -= 1;
        }
    }

    pub fn cursor_down(&mut self) {
        if !self.sessions.is_empty() && self.session_cursor < self.sessions.len() - 1 {
            self.session_cursor += 1;
        }
    }

    pub fn selected_session_id(&self) -> Option<&str> {
        self.sessions.get(self.session_cursor).map(|s| s.id.as_str())
    }

    // ─── Chat scroll ──────────────────────────────────────────────────────────

    pub fn scroll_up(&mut self) {
        self.chat_scroll = self.chat_scroll.saturating_add(3);
    }

    pub fn scroll_down(&mut self) {
        self.chat_scroll = self.chat_scroll.saturating_sub(3);
    }

    // ─── Composer ────────────────────────────────────────────────────────────

    pub fn input_char(&mut self, c: char) {
        self.input.insert(self.input_cursor, c);
        self.input_cursor += c.len_utf8();
    }

    pub fn input_backspace(&mut self) {
        if self.input_cursor > 0 {
            // Find the char boundary before cursor
            let prev = self.input[..self.input_cursor]
                .char_indices()
                .next_back()
                .map(|(i, _)| i)
                .unwrap_or(0);
            self.input.drain(prev..self.input_cursor);
            self.input_cursor = prev;
        }
    }

    pub fn send_message(&mut self) {
        let content = self.input.trim().to_string();
        if content.is_empty() {
            return;
        }
        self.input.clear();
        self.input_cursor = 0;

        // Echo as user message immediately
        self.messages.push(ChatMessage {
            role: MessageRole::User,
            content: content.clone(),
        });
        self.chat_scroll = 0;

        // Send over WebSocket
        if let Some(tx) = &self.ws_tx {
            let msg = OutgoingMessage::UserMessage {
                content,
                client_msg_id: Uuid::new_v4().to_string(),
            };
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = tx.try_send(json);
            }
        } else {
            self.status = "Not connected — cannot send message.".to_string();
        }
    }

    // ─── Permission handling ──────────────────────────────────────────────────

    pub fn approve_permission(&mut self, behavior: &str) {
        if let Some(perm) = self.pending_permission.take() {
            if let Some(tx) = &self.ws_tx {
                let msg = OutgoingMessage::PermissionResponse {
                    request_id: perm.request_id,
                    behavior: behavior.to_string(),
                    tool_name: Some(perm.tool_name),
                };
                if let Ok(json) = serde_json::to_string(&msg) {
                    let _ = tx.try_send(json);
                }
            }
        }
        self.mode = Mode::Normal;
    }

    // ─── WS event processing ──────────────────────────────────────────────────

    pub fn handle_ws_event(&mut self, event: WsEvent) {
        use crate::protocol::IncomingEvent;
        match event {
            WsEvent::Connected => {
                self.ws_connected = true;
                self.status = format!("Connected to {}", self.active_session.as_deref().unwrap_or("session"));
            }
            WsEvent::Disconnected(reason) => {
                self.ws_connected = false;
                self.ws_tx = None;
                self.status = format!("Disconnected: {reason}");
            }
            WsEvent::Incoming(incoming) => match incoming {
                IncomingEvent::SessionInit { backend_type, model, context_used_percent } => {
                    self.backend_type = backend_type;
                    self.model = model;
                    self.context_used_percent = context_used_percent;
                    self.update_status_bar();
                }
                IncomingEvent::MessageHistory(msgs) => {
                    self.messages = msgs;
                    self.chat_scroll = 0;
                    self.update_status_bar();
                }
                IncomingEvent::AssistantMessage(text) => {
                    // Flush any pending streaming first
                    self.flush_streaming();
                    self.messages.push(ChatMessage {
                        role: MessageRole::Assistant,
                        content: text,
                    });
                    self.chat_scroll = 0;
                }
                IncomingEvent::UserMessage(text) => {
                    // Avoid duplicating our own echoed messages
                    let already = self.messages.last()
                        .map(|m| m.role == MessageRole::User && m.content == text)
                        .unwrap_or(false);
                    if !already {
                        self.messages.push(ChatMessage {
                            role: MessageRole::User,
                            content: text,
                        });
                    }
                }
                IncomingEvent::TextDelta(chunk) => {
                    self.streaming_text.push_str(&chunk);
                    self.chat_scroll = 0;
                }
                IncomingEvent::TextStop => {
                    self.flush_streaming();
                }
                IncomingEvent::ToolUse { tool_name, description } => {
                    let content = if description.is_empty() {
                        tool_name.clone()
                    } else {
                        format!("{tool_name} → {description}")
                    };
                    self.messages.push(ChatMessage {
                        role: MessageRole::Tool { name: tool_name },
                        content,
                    });
                    self.chat_scroll = 0;
                }
                IncomingEvent::ToolResult { tool_name: _, is_error } => {
                    if is_error {
                        self.messages.push(ChatMessage {
                            role: MessageRole::Error,
                            content: "Tool returned an error".to_string(),
                        });
                    }
                }
                IncomingEvent::TurnResult { is_error, message } => {
                    self.flush_streaming();
                    if is_error && !message.is_empty() {
                        self.messages.push(ChatMessage {
                            role: MessageRole::Error,
                            content: message,
                        });
                    }
                    self.update_status_bar();
                }
                IncomingEvent::PermissionRequest(perm) => {
                    self.pending_permission = Some(perm);
                    self.mode = Mode::PermissionPrompt;
                }
                IncomingEvent::PermissionCancelled { request_id } => {
                    if self.pending_permission.as_ref().map(|p| p.request_id == request_id).unwrap_or(false) {
                        self.pending_permission = None;
                        if self.mode == Mode::PermissionPrompt {
                            self.mode = Mode::Normal;
                        }
                    }
                }
                IncomingEvent::CliConnected => {
                    self.ws_connected = true;
                    self.update_status_bar();
                }
                IncomingEvent::CliDisconnected => {
                    self.status = "Agent disconnected".to_string();
                }
                IncomingEvent::Ignored => {}
            },
        }
    }

    fn flush_streaming(&mut self) {
        if !self.streaming_text.is_empty() {
            let text = std::mem::take(&mut self.streaming_text);
            self.messages.push(ChatMessage {
                role: MessageRole::Assistant,
                content: text,
            });
            self.chat_scroll = 0;
        }
    }

    fn update_status_bar(&mut self) {
        let conn = if self.ws_connected { "Connected" } else { "Disconnected" };
        let model = if self.model.is_empty() { "—".to_string() } else { self.model.clone() };
        let backend = if self.backend_type.is_empty() { "—".to_string() } else { self.backend_type.clone() };
        let ctx = if self.context_used_percent > 0.0 {
            format!(" · {:.0}% ctx", self.context_used_percent)
        } else {
            String::new()
        };
        let host = self.server_url.replace("http://", "").replace("https://", "");
        self.status = format!("{conn} · {backend} · {model}{ctx} · {host}");
    }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

pub async fn run(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    server_url: String,
) -> anyhow::Result<()> {
    let mut app = App::new(server_url);

    // Channels
    let (event_tx, mut event_rx) = mpsc::channel::<AppEvent>(64);
    let (ws_event_tx, mut ws_event_rx) = mpsc::channel::<WsEvent>(64);

    // Start crossterm event poller
    spawn_event_task(event_tx, 250);

    // Load sessions immediately
    match app.api.list_sessions().await {
        Ok(sessions) => {
            app.sessions = sessions;
            app.status = if app.sessions.is_empty() {
                "No sessions — press [n] to create one.".to_string()
            } else {
                format!("{} session(s) — ↑↓ to navigate, Enter to open", app.sessions.len())
            };
        }
        Err(e) => {
            app.status = format!("Failed to load sessions: {e}");
        }
    }

    let mut tick_interval = tokio::time::interval(std::time::Duration::from_millis(250));

    loop {
        terminal.draw(|f| ui::render(f, &app))?;

        tokio::select! {
            Some(ev) = event_rx.recv() => {
                handle_key_event(&mut app, ev, &ws_event_tx).await?;
            }
            Some(ws_ev) = ws_event_rx.recv() => {
                app.handle_ws_event(ws_ev);
            }
            _ = tick_interval.tick() => {
                // periodic redraw — also a good place to refresh sessions in Normal mode
            }
        }

        if app.should_quit {
            break;
        }
    }

    Ok(())
}

// ─── Keyboard handler ─────────────────────────────────────────────────────────

async fn handle_key_event(
    app: &mut App,
    event: AppEvent,
    ws_event_tx: &mpsc::Sender<WsEvent>,
) -> anyhow::Result<()> {
    let AppEvent::Key(key) = event else { return Ok(()); };

    // Ctrl+C always quits
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        app.should_quit = true;
        return Ok(());
    }

    match app.mode.clone() {
        Mode::PermissionPrompt => handle_permission_keys(app, key),

        Mode::NewSession => handle_new_session_keys(app, key, ws_event_tx).await?,

        Mode::Insert => {
            match key.code {
                KeyCode::Esc => app.mode = Mode::Normal,
                KeyCode::Enter => {
                    app.send_message();
                    app.mode = Mode::Normal;
                }
                KeyCode::Char(c) => app.input_char(c),
                KeyCode::Backspace => app.input_backspace(),
                _ => {}
            }
        }

        Mode::Normal => {
            match key.code {
                KeyCode::Char('q') => app.should_quit = true,
                KeyCode::Char('i') => {
                    if app.active_session.is_some() {
                        app.mode = Mode::Insert;
                    } else {
                        app.status = "Select a session first (Enter)".to_string();
                    }
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    if app.active_session.is_some() {
                        app.scroll_up();
                    } else {
                        app.cursor_up();
                    }
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    if app.active_session.is_some() {
                        app.scroll_down();
                    } else {
                        app.cursor_down();
                    }
                }
                KeyCode::Enter => {
                    if let Some(id) = app.selected_session_id().map(|s| s.to_string()) {
                        connect_to_session(app, id, ws_event_tx).await?;
                    }
                }
                KeyCode::Esc => {
                    // Go back to session list from chat view
                    app.active_session = None;
                    app.ws_tx = None;
                    app.messages.clear();
                    app.streaming_text.clear();
                    app.status = format!("{} session(s) — ↑↓ to navigate, Enter to open", app.sessions.len());
                }
                KeyCode::Char('n') => {
                    // Open new-session picker
                    match app.api.list_backends().await {
                        Ok(backends) => {
                            app.backends = backends.into_iter().filter(|b| b.available).collect();
                            if app.backends.is_empty() {
                                app.status = "No available backends found.".to_string();
                            } else {
                                app.backend_cursor = 0;
                                app.mode = Mode::NewSession;
                            }
                        }
                        Err(e) => app.status = format!("Could not load backends: {e}"),
                    }
                }
                KeyCode::Char('r') => {
                    // Refresh session list
                    match app.api.list_sessions().await {
                        Ok(sessions) => {
                            app.sessions = sessions;
                            app.status = format!("{} session(s) refreshed", app.sessions.len());
                        }
                        Err(e) => app.status = format!("Refresh failed: {e}"),
                    }
                }
                _ => {}
            }
        }
    }

    Ok(())
}

fn handle_permission_keys(app: &mut App, key: crossterm::event::KeyEvent) {
    match key.code {
        KeyCode::Char('y') | KeyCode::Enter => app.approve_permission("allow_once"),
        KeyCode::Char('a') => app.approve_permission("allow_always"),
        KeyCode::Char('n') | KeyCode::Esc => app.approve_permission("reject_once"),
        _ => {}
    }
}

async fn handle_new_session_keys(
    app: &mut App,
    key: crossterm::event::KeyEvent,
    ws_event_tx: &mpsc::Sender<WsEvent>,
) -> anyhow::Result<()> {
    match key.code {
        KeyCode::Esc => {
            app.mode = Mode::Normal;
        }
        KeyCode::Up | KeyCode::Char('k') => {
            if app.backend_cursor > 0 {
                app.backend_cursor -= 1;
            }
        }
        KeyCode::Down | KeyCode::Char('j') => {
            if app.backend_cursor < app.backends.len().saturating_sub(1) {
                app.backend_cursor += 1;
            }
        }
        KeyCode::Enter => {
            if let Some(backend) = app.backends.get(app.backend_cursor).cloned() {
                app.mode = Mode::Normal;
                app.status = format!("Creating {} session…", backend.name);
                let cwd = std::env::current_dir()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                match app.api.create_session(&backend.id, &cwd).await {
                    Ok(session_id) => {
                        // Refresh session list
                        if let Ok(sessions) = app.api.list_sessions().await {
                            app.sessions = sessions;
                        }
                        connect_to_session(app, session_id, ws_event_tx).await?;
                    }
                    Err(e) => {
                        app.status = format!("Create failed: {e}");
                    }
                }
            }
        }
        _ => {}
    }
    Ok(())
}

async fn connect_to_session(
    app: &mut App,
    session_id: String,
    ws_event_tx: &mpsc::Sender<WsEvent>,
) -> anyhow::Result<()> {
    let ws_url = app.api.ws_url(&session_id);
    app.active_session = Some(session_id.clone());
    app.messages.clear();
    app.streaming_text.clear();
    app.chat_scroll = 0;
    app.backend_type.clear();
    app.model.clear();
    app.context_used_percent = 0.0;
    app.status = format!("Connecting to {session_id}…");

    let (out_tx, out_rx) = mpsc::channel::<String>(32);
    app.ws_tx = Some(out_tx);

    let tx = ws_event_tx.clone();
    tokio::spawn(async move {
        run_ws_task(ws_url, session_id, tx, out_rx).await;
    });

    Ok(())
}
