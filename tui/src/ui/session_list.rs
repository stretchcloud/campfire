/// Sessions sidebar widget — renders the list of sessions on the left panel.
use crate::app::App;
use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState},
    Frame,
};

pub fn render(f: &mut Frame, app: &App, area: Rect) {
    let active_id = app.active_session.as_deref();

    let items: Vec<ListItem> = app
        .sessions
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let is_cursor = i == app.session_cursor;
            let is_active = active_id == Some(s.id.as_str());

            let bullet = if is_active { "●" } else { " " };
            let name = s.display_name();
            let backend = s.backend_type.as_deref().unwrap_or("");
            // Show backend tag when available to distinguish sessions by type
            let label = if backend.is_empty() {
                format!("{bullet} {name}")
            } else {
                format!("{bullet} {name} [{backend}]")
            };

            let style = if is_cursor {
                Style::default().fg(Color::Black).bg(Color::Cyan).add_modifier(Modifier::BOLD)
            } else if is_active {
                Style::default().fg(Color::Cyan)
            } else {
                Style::default().fg(Color::White)
            };

            let spans = vec![
                Span::styled(label, style),
            ];

            ListItem::new(Line::from(spans))
        })
        .collect();

    let title = format!(" Sessions ({}) ", app.sessions.len());
    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::DarkGray));

    let mut list_state = ListState::default();
    if !app.sessions.is_empty() {
        list_state.select(Some(app.session_cursor));
    }

    f.render_stateful_widget(
        List::new(items)
            .block(block)
            .highlight_style(Style::default().fg(Color::Black).bg(Color::Cyan)),
        area,
        &mut list_state,
    );

    // Footer hint inside the sidebar
    let hint_area = Rect {
        x: area.x + 1,
        y: area.y + area.height.saturating_sub(2),
        width: area.width.saturating_sub(2),
        height: 1,
    };
    let hint = ratatui::widgets::Paragraph::new("[n] new  [r] refresh  [q] quit")
        .style(Style::default().fg(Color::DarkGray));
    f.render_widget(hint, hint_area);
}
