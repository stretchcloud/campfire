/// Top-level render function — wires layout and delegates to sub-widgets.
pub mod chat;
pub mod composer;
pub mod permission;
pub mod session_list;

use crate::app::{App, Mode};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, Paragraph},
    Frame,
};

pub fn render(f: &mut Frame, app: &App) {
    let area = f.area();

    if app.mode == Mode::NewSession {
        render_new_session(f, app, area);
        return;
    }

    // Main layout: sidebar | main content
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Length(25),   // sessions sidebar
            Constraint::Min(40),      // chat + composer
        ])
        .split(area);

    // Left: session list
    session_list::render(f, app, cols[0]);

    // Right: split into chat + composer + status
    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(5),       // chat messages
            Constraint::Length(3),    // composer
            Constraint::Length(1),    // status bar
        ])
        .split(cols[1]);

    chat::render(f, app, right[0]);
    composer::render(f, app, right[1]);
    render_status_bar(f, app, right[2]);

    // Permission overlay (drawn last so it's on top)
    if app.mode == Mode::PermissionPrompt {
        if let Some(perm) = &app.pending_permission {
            permission::render(f, perm, area);
        }
    }
}

fn render_status_bar(f: &mut Frame, app: &App, area: Rect) {
    let style = if app.ws_connected {
        Style::default().fg(Color::DarkGray)
    } else {
        Style::default().fg(Color::Red)
    };
    let para = Paragraph::new(Line::from(Span::styled(
        format!(" {}", app.status),
        style,
    )));
    f.render_widget(para, area);
}

fn render_new_session(f: &mut Frame, app: &App, area: Rect) {
    // Center a picker box
    let popup_w = 40u16.min(area.width.saturating_sub(4));
    let popup_h = (app.backends.len() as u16 + 4).min(area.height.saturating_sub(4));
    let x = area.x + (area.width.saturating_sub(popup_w)) / 2;
    let y = area.y + (area.height.saturating_sub(popup_h)) / 2;
    let popup_area = Rect { x, y, width: popup_w, height: popup_h };

    use ratatui::widgets::Clear;
    f.render_widget(Clear, popup_area);

    let block = Block::default()
        .title(" New Session — choose backend ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD));

    let items: Vec<ListItem> = app
        .backends
        .iter()
        .enumerate()
        .map(|(i, b)| {
            let style = if i == app.backend_cursor {
                Style::default().fg(Color::Black).bg(Color::Cyan)
            } else {
                Style::default().fg(Color::White)
            };
            ListItem::new(Line::from(Span::styled(format!("  {}", b.name), style)))
        })
        .collect();

    let inner = Rect {
        x: popup_area.x + 1,
        y: popup_area.y + 1,
        width: popup_area.width.saturating_sub(2),
        height: popup_area.height.saturating_sub(2),
    };
    f.render_widget(block, popup_area);

    // Split inner: list + hint
    let inner_layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .split(inner);

    use ratatui::widgets::ListState;
    let mut state = ListState::default();
    state.select(Some(app.backend_cursor));
    f.render_stateful_widget(List::new(items), inner_layout[0], &mut state);

    let hint = Paragraph::new(Line::from(Span::styled(
        "↑↓ navigate · Enter select · Esc cancel",
        Style::default().fg(Color::DarkGray),
    )));
    f.render_widget(hint, inner_layout[1]);
}
