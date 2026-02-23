/// Converts crossterm events into AppEvent values for the main loop.
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Debug, Clone)]
pub enum AppEvent {
    /// A key was pressed
    Key(KeyEvent),
    /// Terminal was resized
    Resize(u16, u16),
    /// Tick for periodic redraws
    Tick,
}

/// Spawn a task that polls crossterm events and forwards them to the given channel.
/// Events are polled every `tick_ms` milliseconds; if no event arrives, a Tick is sent.
pub fn spawn_event_task(tx: mpsc::Sender<AppEvent>, tick_ms: u64) {
    std::thread::spawn(move || {
        let tick = Duration::from_millis(tick_ms);
        loop {
            if event::poll(tick).unwrap_or(false) {
                match event::read() {
                    Ok(Event::Key(key)) => {
                        if tx.blocking_send(AppEvent::Key(key)).is_err() {
                            break;
                        }
                    }
                    Ok(Event::Resize(w, h)) => {
                        if tx.blocking_send(AppEvent::Resize(w, h)).is_err() {
                            break;
                        }
                    }
                    _ => {}
                }
            } else if tx.blocking_send(AppEvent::Tick).is_err() {
                break;
            }
        }
    });
}

/// Helper: is this a quit key (Ctrl+C)?
#[allow(dead_code)]
pub fn is_quit(key: &KeyEvent) -> bool {
    matches!(
        key,
        KeyEvent {
            code: KeyCode::Char('c'),
            modifiers: KeyModifiers::CONTROL,
            ..
        }
    )
}
