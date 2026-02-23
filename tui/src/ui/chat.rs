/// Chat message list widget — renders message history + live streaming text.
use crate::{
    app::App,
    protocol::MessageRole,
};
use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

pub fn render(f: &mut Frame, app: &App, area: Rect) {
    // Build lines from message history
    let mut lines: Vec<Line> = Vec::new();

    for msg in &app.messages {
        let (prefix, prefix_style, body_style) = match &msg.role {
            MessageRole::User => (
                " you  ",
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
                Style::default().fg(Color::White),
            ),
            MessageRole::Assistant => (
                "agent ",
                Style::default().fg(Color::Green).add_modifier(Modifier::BOLD),
                Style::default().fg(Color::White),
            ),
            MessageRole::Tool { name: _ } => (
                " tool ",
                Style::default().fg(Color::Yellow),
                Style::default().fg(Color::DarkGray),
            ),
            MessageRole::Error => (
                "error ",
                Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
                Style::default().fg(Color::Red),
            ),
            MessageRole::System => (
                "  sys ",
                Style::default().fg(Color::Magenta),
                Style::default().fg(Color::DarkGray),
            ),
        };

        // First line has the prefix
        let content_lines: Vec<&str> = msg.content.lines().collect();
        for (i, content_line) in content_lines.iter().enumerate() {
            if i == 0 {
                lines.push(Line::from(vec![
                    Span::styled(prefix, prefix_style),
                    Span::raw("│ "),
                    Span::styled(*content_line, body_style),
                ]));
            } else {
                lines.push(Line::from(vec![
                    Span::raw("       │ "),
                    Span::styled(*content_line, body_style),
                ]));
            }
        }

        // Visual separator after each message
        lines.push(Line::from(Span::raw("")));
    }

    // Streaming text at the bottom (if any)
    if !app.streaming_text.is_empty() {
        let stream_lines: Vec<&str> = app.streaming_text.lines().collect();
        for (i, sl) in stream_lines.iter().enumerate() {
            let suffix = if i == stream_lines.len() - 1 { "▋" } else { "" };
            if i == 0 {
                lines.push(Line::from(vec![
                    Span::styled("agent ", Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)),
                    Span::raw("│ "),
                    Span::styled(format!("{sl}{suffix}"), Style::default().fg(Color::White)),
                ]));
            } else {
                lines.push(Line::from(vec![
                    Span::raw("       │ "),
                    Span::styled(format!("{sl}{suffix}"), Style::default().fg(Color::White)),
                ]));
            }
        }
    }

    // Empty state
    if lines.is_empty() {
        lines.push(Line::from(Span::styled(
            "  No messages yet — press [i] to type",
            Style::default().fg(Color::DarkGray),
        )));
    }

    let total_lines = lines.len() as u16;
    let visible = area.height.saturating_sub(2); // subtract border
    // scroll: 0 = bottom, higher = scrolled up
    let max_scroll = total_lines.saturating_sub(visible);
    let scroll = app.chat_scroll.min(max_scroll);
    // Convert "lines from bottom" to "lines from top" for Paragraph
    let scroll_from_top = max_scroll.saturating_sub(scroll);

    let session_name = app
        .active_session
        .as_deref()
        .and_then(|id| {
            app.sessions.iter().find(|s| s.id == id)
        })
        .map(|s| s.display_name())
        .unwrap_or_else(|| "—".to_string());

    let title = format!(" {session_name} ");
    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::DarkGray));

    let paragraph = Paragraph::new(lines)
        .block(block)
        .wrap(Wrap { trim: false })
        .scroll((scroll_from_top, 0));

    f.render_widget(paragraph, area);
}
