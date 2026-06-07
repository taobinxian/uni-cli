mod api;
mod app;
mod types;
mod ui;

use std::io;
use std::thread;
use std::time::Duration;

use anyhow::Result;
use clap::Parser;
use crossterm::event::{self, Event};
use crossterm::execute;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::interval;

use crate::api::WorkbenchApi;
use crate::app::TuiApp;
use crate::types::{CommandRunResult, DashboardSnapshot, TerminalFrame, TokenUsageResult};

#[derive(Debug, Parser)]
#[command(name = "unicli-tui", about = "Focus Console terminal UI for unicli")]
struct Args {
    #[arg(long, env = "UNICLI_API", default_value = "http://127.0.0.1:8788")]
    api: String,

    #[arg(long, env = "UNICLI_REFRESH_MS", default_value_t = 2500)]
    refresh_ms: u64,

    #[arg(long)]
    check_api: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let api = WorkbenchApi::new(args.api);
    if args.check_api {
        let snapshot = api.dashboard().await?;
        println!(
            "connected: {} apps, {} sessions, {} confirmations",
            snapshot.apps.len(),
            snapshot.sessions.len(),
            snapshot.confirmations.len()
        );
        return Ok(());
    }

    let mut app = TuiApp::new(api);
    app.refresh().await;

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let result = run(&mut terminal, &mut app, Duration::from_millis(args.refresh_ms)).await;

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    result
}

async fn run(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut TuiApp,
    refresh_every: Duration,
) -> Result<()> {
    let mut ticker = interval(refresh_every);
    let (refresh_tx, mut refresh_rx) = mpsc::channel::<anyhow::Result<RefreshResult>>(1);
    let (send_tx, mut send_rx) = mpsc::channel::<anyhow::Result<CommandRunResult>>(4);
    let (frame_tx, mut frame_rx) = mpsc::channel::<TerminalFrame>(256);
    let mut event_rx = spawn_event_reader();
    let mut refresh_in_flight = false;
    let mut send_in_flight = false;
    let mut streamed_session_id: Option<String> = None;
    let mut stream_task: Option<JoinHandle<()>> = None;
    loop {
        terminal.draw(|frame| ui::draw(frame, app))?;
        if app.should_quit {
            break;
        }

        let selected_session_id = app.selected_session_id.clone();
        if streamed_session_id != selected_session_id {
            if let Some(task) = stream_task.take() {
                task.abort();
            }
            streamed_session_id = selected_session_id.clone();
            if let Some(session_id) = selected_session_id {
                stream_task = Some(spawn_session_stream(app.api.clone(), session_id, frame_tx.clone()));
            }
        }

        if app.refresh_requested && !refresh_in_flight {
            app.refresh_requested = false;
            refresh_in_flight = true;
            spawn_refresh(app.api.clone(), app.scope.as_api(), app.selected_session_id.clone(), refresh_tx.clone());
        }

        if let Some((session_id, prompt)) = app.pending_prompt.take() {
            if send_in_flight {
                app.pending_prompt = Some((session_id, prompt));
            } else {
                send_in_flight = true;
                spawn_send_prompt(app.api.clone(), session_id, prompt, send_tx.clone());
            }
        }

        tokio::select! {
            Some(frame) = frame_rx.recv() => {
                app.push_frame(frame);
            }
            Some(result) = send_rx.recv() => {
                send_in_flight = false;
                match result {
                    Ok(result) => {
                        app.status = if result.confirmation.is_some() {
                            "指令已提交，等待确认队列处理".to_string()
                        } else {
                            "指令已发送到当前会话".to_string()
                        };
                        app.refresh_requested = true;
                    }
                    Err(error) => app.status = format!("发送指令失败：{error}"),
                }
            }
            Some(result) = refresh_rx.recv() => {
                refresh_in_flight = false;
                app.refresh_requested = false;
                match result {
                    Ok(result) => app.apply_refresh_result(result.snapshot, result.usage, result.frames),
                    Err(error) => app.status = format!("后端连接失败：{error}"),
                }
            }
            _ = ticker.tick() => {
                if !refresh_in_flight {
                    refresh_in_flight = true;
                    spawn_refresh(app.api.clone(), app.scope.as_api(), app.selected_session_id.clone(), refresh_tx.clone());
                }
            },
            Some(event) = event_rx.recv() => {
                match event {
                    Ok(Event::Key(key)) => app.handle_key(key).await,
                    Ok(_) => {}
                    Err(error) => app.status = format!("读取键盘事件失败：{error}"),
                }
            }
        }
    }
    Ok(())
}

#[derive(Debug)]
struct RefreshResult {
    snapshot: DashboardSnapshot,
    usage: Option<TokenUsageResult>,
    frames: Option<Vec<TerminalFrame>>,
}

fn spawn_refresh(
    api: WorkbenchApi,
    scope: &'static str,
    session_id: Option<String>,
    tx: mpsc::Sender<anyhow::Result<RefreshResult>>,
) {
    tokio::spawn(async move {
        let result = async {
            let snapshot = api.dashboard().await?;
            let usage = api.token_usage(scope).await.ok();
            let frames = if let Some(session_id) = session_id {
                api.session_history(&session_id, 80).await.ok().map(|history| history.frames)
            } else {
                None
            };
            Ok(RefreshResult { snapshot, usage, frames })
        }
        .await;
        let _ = tx.send(result).await;
    });
}

fn spawn_send_prompt(
    api: WorkbenchApi,
    session_id: String,
    prompt: String,
    tx: mpsc::Sender<anyhow::Result<CommandRunResult>>,
) {
    tokio::spawn(async move {
        let result = api.send_prompt(&session_id, prompt).await;
        let _ = tx.send(result).await;
    });
}

fn spawn_session_stream(
    api: WorkbenchApi,
    session_id: String,
    tx: mpsc::Sender<TerminalFrame>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let Ok(mut response) = reqwest::get(api.session_stream_url(&session_id)).await else {
            return;
        };
        let mut buffer = String::new();
        loop {
            let Ok(next) = response.chunk().await else {
                return;
            };
            let Some(chunk) = next else {
                return;
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(index) = buffer.find("\n\n") {
                let event = buffer[..index].to_string();
                buffer.drain(..index + 2);
                for line in event.lines() {
                    let Some(data) = line.strip_prefix("data: ") else {
                        continue;
                    };
                    if let Ok(frame) = serde_json::from_str::<TerminalFrame>(data) {
                        if tx.send(frame).await.is_err() {
                            return;
                        }
                    }
                }
            }
        }
    })
}

fn spawn_event_reader() -> mpsc::Receiver<io::Result<Event>> {
    let (tx, rx) = mpsc::channel(128);
    thread::spawn(move || {
        while let Ok(event) = event::read() {
            if tx.blocking_send(Ok(event)).is_err() {
                break;
            }
        }
    });
    rx
}
