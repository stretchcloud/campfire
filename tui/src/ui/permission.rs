/// Permission overlay — rendered as a centered modal over everything else.
use crate::protocol::PermissionRequest;
use serde_json;
use ratatui::{
    layout::{Alignment, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
    Frame,
};

/// Render a permission request as a centered pop-up.
/// The caller is responsible for only calling this when a permission is pending.
pub fn render(f: &mut Frame, perm: &PermissionRequest, area: Rect) {
    // Compute a centred box: 60% wide, up to 12 lines tall
    let popup_w = (area.width * 6 / 10).max(40).min(area.width.saturating_sub(4));
    let popup_h = 12u16.min(area.height.saturating_sub(4));
    let x = area.x + (area.width.saturating_sub(popup_w)) / 2;
    let y = area.y + (area.height.saturating_sub(popup_h)) / 2;
    let popup_area = Rect { x, y, width: popup_w, height: popup_h };

    // Clear the background area first
    f.render_widget(Clear, popup_area);

    let block = Block::default()
        .title(" Permission Request ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD));

    // Build content
    let tool_line = Line::from(vec![
        Span::styled("Tool:  ", Style::default().fg(Color::DarkGray)),
        Span::styled(perm.tool_name.clone(), Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
    ]);

    let input_text = perm
        .tool_input
        .as_ref()
        .map(|v| {
            let s = serde_json::to_string_pretty(v).unwrap_or_default();
            if s.len() > 200 { format!("{}…", &s[..200]) } else { s }
        })
        .unwrap_or_default();

    let desc_text = perm.description.as_deref().unwrap_or("").to_string();

    let mut lines = vec![
        Line::from(""),
        tool_line,
        Line::from(""),
    ];

    if !desc_text.is_empty() {
        lines.push(Line::from(vec![
            Span::styled("Desc:  ", Style::default().fg(Color::DarkGray)),
            Span::styled(desc_text, Style::default().fg(Color::White)),
        ]));
        lines.push(Line::from(""));
    }

    if !input_text.is_empty() {
        for (i, il) in input_text.lines().take(4).enumerate() {
            if i == 0 {
                lines.push(Line::from(vec![
                    Span::styled("Input: ", Style::default().fg(Color::DarkGray)),
                    Span::styled(il.to_string(), Style::default().fg(Color::White)),
                ]));
            } else {
                lines.push(Line::from(vec![
                    Span::raw("       "),
                    Span::styled(il.to_string(), Style::default().fg(Color::White)),
                ]));
            }
        }
        lines.push(Line::from(""));
    }

    lines.push(Line::from(vec![
        Span::styled("[y] Allow once", Style::default().fg(Color::Green)),
        Span::raw("   "),
        Span::styled("[a] Always", Style::default().fg(Color::Cyan)),
        Span::raw("   "),
        Span::styled("[n] Deny", Style::default().fg(Color::Red)),
    ]));

    // Split popup area: inner content (subtract block borders)
    let inner = Rect {
        x: popup_area.x + 1,
        y: popup_area.y + 1,
        width: popup_area.width.saturating_sub(2),
        height: popup_area.height.saturating_sub(2),
    };

    f.render_widget(block, popup_area);

    let content = Paragraph::new(lines)
        .wrap(Wrap { trim: true })
        .alignment(Alignment::Left);
    f.render_widget(content, inner);
}
