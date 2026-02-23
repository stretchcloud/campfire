/// Composer widget — single-line input box at the bottom of the chat panel.
use crate::app::{App, Mode};
use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

pub fn render(f: &mut Frame, app: &App, area: Rect) {
    let is_active = app.mode == Mode::Insert;

    let border_style = if is_active {
        Style::default().fg(Color::Cyan)
    } else {
        Style::default().fg(Color::DarkGray)
    };

    let hint = if is_active {
        "Enter to send · Esc to cancel"
    } else {
        "[i] to type · [Enter] to open session"
    };

    let block = Block::default()
        .title(format!(" {hint} "))
        .borders(Borders::ALL)
        .border_style(border_style);

    let content = if app.input.is_empty() && !is_active {
        Span::styled("Type a message…", Style::default().fg(Color::DarkGray))
    } else if is_active {
        // Show cursor at the end
        Span::styled(
            format!("{}_", app.input),
            Style::default().fg(Color::White).add_modifier(Modifier::BOLD),
        )
    } else {
        Span::styled(app.input.clone(), Style::default().fg(Color::White))
    };

    let paragraph = Paragraph::new(Line::from(vec![content])).block(block);
    f.render_widget(paragraph, area);
}
