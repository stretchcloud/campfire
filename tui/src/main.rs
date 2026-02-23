use clap::Parser;
use std::io;

mod app;
mod api;
mod events;
mod protocol;
mod ui;
mod ws;

#[derive(Parser, Debug)]
#[command(name = "campfire-tui", about = "Terminal UI for Campfire")]
struct Args {
    /// Campfire server URL (also reads $CAMPFIRE_URL)
    #[arg(long, env = "CAMPFIRE_URL", default_value = "http://localhost:3456")]
    server: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    // Normalize: strip trailing slash
    let server_url = args.server.trim_end_matches('/').to_string();

    // Set up terminal
    crossterm::terminal::enable_raw_mode()?;
    let mut stdout = io::stdout();
    crossterm::execute!(
        stdout,
        crossterm::terminal::EnterAlternateScreen,
        crossterm::event::EnableMouseCapture
    )?;

    let backend = ratatui::backend::CrosstermBackend::new(stdout);
    let mut terminal = ratatui::Terminal::new(backend)?;

    // Run app
    let result = app::run(&mut terminal, server_url).await;

    // Restore terminal
    crossterm::terminal::disable_raw_mode()?;
    crossterm::execute!(
        terminal.backend_mut(),
        crossterm::terminal::LeaveAlternateScreen,
        crossterm::event::DisableMouseCapture
    )?;
    terminal.show_cursor()?;

    if let Err(e) = result {
        eprintln!("Error: {e}");
        std::process::exit(1);
    }

    Ok(())
}
