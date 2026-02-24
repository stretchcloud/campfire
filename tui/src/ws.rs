/// WebSocket client task for a single Campfire session.
///
/// Spawned as `tokio::spawn`. Connects to `ws://host/ws/browser/:sessionId`,
/// sends `session_subscribe`, then relays:
/// - Incoming WS frames → decoded IncomingEvent → sent to `app_tx` (mpsc)
/// - Outgoing strings from `out_rx` (mpsc) → WS frame
use crate::protocol::{decode, IncomingEvent, OutgoingMessage};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;

/// Events the WS task sends to the app
pub enum WsEvent {
    /// A decoded incoming message
    Incoming(IncomingEvent),
    /// Connection was lost or failed
    Disconnected(String),
    /// Connection established
    Connected,
}

/// Connect to the Campfire WS and run until the connection closes or `shutdown` fires.
///
/// - `ws_url`: full WebSocket URL, e.g. `ws://localhost:3456/ws/browser/SESSION`
/// - `session_id`: used in `session_subscribe`
/// - `app_tx`: channel to send decoded events to the main app loop
/// - `out_rx`: channel to receive outgoing messages from the app
pub async fn run_ws_task(
    ws_url: String,
    session_id: String,
    app_tx: mpsc::Sender<WsEvent>,
    mut out_rx: mpsc::Receiver<String>,
) {
    eprintln!("[ws] Connecting to {ws_url}");
    let conn = match connect_async(&ws_url).await {
        Ok((stream, _)) => stream,
        Err(e) => {
            eprintln!("[ws] Connect failed: {e}");
            let _ = app_tx
                .send(WsEvent::Disconnected(format!("connect failed: {e}")))
                .await;
            return;
        }
    };

    eprintln!("[ws] Connected!");
    let _ = app_tx.send(WsEvent::Connected).await;

    let (mut write, mut read) = conn.split();

    // Send session_subscribe immediately
    let subscribe = OutgoingMessage::SessionSubscribe {
        last_seq: 0,
        client_msg_id: Uuid::new_v4().to_string(),
    };
    if let Ok(json) = serde_json::to_string(&subscribe) {
        eprintln!("[ws] Sending subscribe: {json}");
        let _ = write.send(Message::text(json)).await;
    }

    loop {
        tokio::select! {
            // Incoming WS frame
            frame = read.next() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        let raw = text.to_string();
                        let preview: String = raw.chars().take(200).collect();
                        eprintln!("[ws] ← {preview}");
                        let event = decode(&raw);
                        if app_tx.send(WsEvent::Incoming(event)).await.is_err() {
                            break; // app dropped receiver
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        eprintln!("[ws] Connection closed");
                        let _ = app_tx
                            .send(WsEvent::Disconnected("connection closed".to_string()))
                            .await;
                        break;
                    }
                    Some(Err(e)) => {
                        eprintln!("[ws] Error: {e}");
                        let _ = app_tx
                            .send(WsEvent::Disconnected(format!("ws error: {e}")))
                            .await;
                        break;
                    }
                    _ => {} // ping/pong/binary — ignore
                }
            }

            // Outgoing message from app
            Some(msg) = out_rx.recv() => {
                eprintln!("[ws] → {msg}");
                if write.send(Message::text(msg)).await.is_err() {
                    break;
                }
            }
        }
    }
}
