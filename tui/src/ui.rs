use chrono::DateTime;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::prelude::{Color, Line, Modifier, Span, Style};
use ratatui::widgets::{Block, BorderType, Borders, Clear, List, ListItem, Paragraph, Wrap};
use ratatui::Frame;

use crate::api::app_label;
use crate::app::{
    format_token_count, scope_label, session_short, status_label, FocusPane, SessionFilter, TuiApp,
    APP_ORDER,
};
use crate::types::{Session, TerminalFrame};

pub fn draw(frame: &mut Frame, app: &TuiApp) {
    let root = frame.area();
    if root.width < 82 {
        draw_compact(frame, root, app);
    } else if root.width < 128 {
        let shell = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Length(adaptive_width(root.width, 26, 34, 30)),
                Constraint::Min(48),
            ])
            .split(root);
        draw_sidebar(frame, shell[0], app);
        draw_stage(frame, shell[1], app);
    } else {
        let left = adaptive_width(root.width, 28, 38, 24);
        let right = adaptive_width(root.width, 30, 42, 24);
        let shell = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Length(left),
                Constraint::Min(58),
                Constraint::Length(right),
            ])
            .split(root);
        draw_sidebar(frame, shell[0], app);
        draw_stage(frame, shell[1], app);
        draw_inspector(frame, shell[2], app);
    }

    if root.width < 100 || root.height < 24 {
        draw_small_warning(frame, root);
    }
}

fn draw_compact(frame: &mut Frame, area: Rect, app: &TuiApp) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(compact_sidebar_height(area.height)),
            Constraint::Min(16),
        ])
        .split(area);
    draw_sidebar(frame, chunks[0], app);
    draw_stage(frame, chunks[1], app);
}

fn draw_sidebar(frame: &mut Frame, area: Rect, app: &TuiApp) {
    let token_height = if area.height >= 24 { 7 } else if area.height >= 18 { 5 } else { 0 };
    let footer_height = if area.height >= 16 { 2 } else { 0 };
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Min(4),
            Constraint::Length(token_height),
            Constraint::Length(footer_height),
        ])
        .split(area);

    let brand = Paragraph::new(vec![
        Line::from(vec![Span::styled("[AM] ", Style::default().fg(Color::Black).add_modifier(Modifier::BOLD)), Span::raw("Focus Console")]),
        Line::from(Span::styled("整合工作台                         +", Color::DarkGray)),
    ])
    .block(seamless_panel(app.focus == FocusPane::Sidebar));
    frame.render_widget(brand, chunks[0]);

    let search = Paragraph::new(format!("⌕ {}{}", app.query, if app.query.is_empty() { "搜索会话...  ⌘K" } else { "" }))
        .style(Style::default().fg(if app.query.is_empty() { Color::Gray } else { Color::Black }))
        .block(seamless_panel(app.focus == FocusPane::Sidebar));
    frame.render_widget(search, chunks[1]);

    let filters = [
        (SessionFilter::All, "全部"),
        (SessionFilter::Running, "进行中"),
        (SessionFilter::History, "历史"),
    ];
    let filter_line = filters
        .into_iter()
        .map(|(filter, label)| {
            if app.filter == filter {
                Span::styled(format!(" {label} "), Style::default().fg(Color::White).bg(Color::Black).add_modifier(Modifier::BOLD))
            } else {
                Span::styled(format!(" {label} "), Color::DarkGray)
            }
        })
        .collect::<Vec<_>>();
    frame.render_widget(
        Paragraph::new(Line::from(filter_line)).block(seamless_panel(app.focus == FocusPane::Sidebar)),
        chunks[2],
    );

    let mut items = Vec::new();
    for app_id in APP_ORDER {
        let count = app.snapshot.apps.iter().find(|item| item.app_id == app_id).map(|item| item.sessions).unwrap_or_else(|| app.snapshot.sessions.iter().filter(|session| session.app_id == app_id).count() as u64);
        let title_style = if app.selected_app == app_id {
            Style::default().fg(app_color(app_id)).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::DarkGray).add_modifier(Modifier::BOLD)
        };
        items.push(ListItem::new(Line::from(vec![
            Span::styled("● ", Style::default().fg(app_color(app_id))),
            Span::styled(app_label(app_id), title_style),
            Span::styled(format!("  {count}"), Color::Gray),
        ])));

        for session in app.visible_sessions_for_app(app_id) {
            let active = app.selected_session_id.as_deref() == Some(session.id.as_str());
            let prefix = if active { "┃" } else { " " };
            let style = if active {
                Style::default().fg(Color::Black).bg(Color::White).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::DarkGray)
            };
            items.push(ListItem::new(vec![
                Line::from(vec![
                    Span::styled(prefix, Style::default().fg(app_color(app_id))),
                    Span::styled(format!(" {}", clip(&session.title, 21)), style),
                ]),
                Line::from(Span::styled(
                    format!("   {} {} · {}", status_label(&session.status, session.live), session_short(&session.id), format_token_count(session.total_tokens)),
                    Color::Gray,
                )),
            ]));
        }
        let total = app.matching_sessions_for_app(app_id).len();
        let visible = app.visible_sessions_for_app(app_id).len();
        if total > visible {
            items.push(ListItem::new(Line::from(Span::styled(format!("   继续显示剩余{}条↓  Enter", (total - visible).min(10)), app_color(app_id)))));
        }
    }

    frame.render_widget(
        List::new(items).block(focused_panel("会话", app.focus == FocusPane::Sidebar)),
        chunks[3],
    );

    let total_tokens = app.snapshot.token_usage.iter().map(|usage| usage.total_tokens).sum();
    let token = Paragraph::new(vec![
        Line::from(Span::styled(format!("{} TOKEN · 全部 APP 展开 >", scope_label(app.scope)), Color::DarkGray)),
        Line::from(Span::styled(format_token_count(total_tokens), Style::default().fg(Color::Black).add_modifier(Modifier::BOLD))),
        Line::from(vec![
            Span::styled("━━", app_color("codex")),
            Span::styled("━━", app_color("claude")),
            Span::styled("━━", app_color("antigravity")),
            Span::styled("━━", app_color("oh-my-pi")),
            Span::styled("━━", app_color("opencode")),
        ]),
        Line::from("今日  本周  本月"),
    ])
    .block(seamless_panel(app.focus == FocusPane::Sidebar));
    if token_height > 0 {
        frame.render_widget(token, chunks[4]);
    }

    let connected = app.snapshot.apps.iter().filter(|item| item.status == "connected").count();
    let footer = Paragraph::new(format!("● {connected}/{} CLI · {} 会话   F5刷新", APP_ORDER.len(), app.snapshot.sessions.len()))
        .style(muted_style());
    if footer_height > 0 {
        frame.render_widget(footer, chunks[5]);
    }
}

fn draw_stage(frame: &mut Frame, area: Rect, app: &TuiApp) {
    let composer_height = adaptive_composer_height(area.height);
    let header_height = if area.height >= 18 { 4 } else { 3 };
    let status_height = if area.height >= 14 { 2 } else { 1 };
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(header_height),
            Constraint::Min(6),
            Constraint::Length(composer_height),
            Constraint::Length(status_height),
        ])
        .split(area);

    draw_tabs(frame, chunks[0], app);
    draw_header(frame, chunks[1], app);
    draw_conversation(frame, chunks[2], app);
    draw_composer(frame, chunks[3], app);
    draw_status(frame, chunks[4], app);
}

fn draw_tabs(frame: &mut Frame, area: Rect, app: &TuiApp) {
    let mut spans = Vec::new();
    for session in app.open_tabs() {
        let active = app.selected_session_id.as_deref() == Some(session.id.as_str());
        let label = format!(" ● {} {} × ", clip(&session.title, 18), session_short(&session.id));
        let style = if active {
            Style::default().fg(Color::White).bg(app_color(&session.app_id)).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::DarkGray)
        };
        spans.push(Span::styled(label, style));
    }
    spans.push(Span::styled(" + 新会话 ", Color::Gray));
    frame.render_widget(Paragraph::new(Line::from(spans)).block(panel("Tabs")), area);
}

fn draw_header(frame: &mut Frame, area: Rect, app: &TuiApp) {
    let session = app.selected_session();
    let app_id = session.map(|item| item.app_id.as_str()).unwrap_or(app.selected_app.as_str());
    let title = session.map(|item| item.title.as_str()).unwrap_or("未选择会话");
    let subtitle = session
        .map(|item| format!("{} {} · {} · {}", app_label(&item.app_id), session_short(&item.id), item.model.as_deref().unwrap_or("model pending"), item.cwd.as_deref().unwrap_or("未记录目录")))
        .unwrap_or_else(|| "从左侧选择一个会话继续".to_string());
    let live = if session.map(|item| item.live).unwrap_or(false) { "● Live" } else { session.map(|item| status_label(&item.status, false)).unwrap_or("-") };
    let text = vec![
        Line::from(vec![
            Span::styled(format!(" {} ", app_initials(app_id)), Style::default().fg(Color::White).bg(app_color(app_id)).add_modifier(Modifier::BOLD)),
            Span::raw("  "),
            Span::styled(title, Style::default().fg(Color::Black).add_modifier(Modifier::BOLD)),
            Span::raw("   "),
            Span::styled(live, Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)),
        ]),
        Line::from(Span::styled(subtitle, Color::DarkGray)),
    ];
    frame.render_widget(Paragraph::new(text).block(panel("Session")), area);
}

fn draw_conversation(frame: &mut Frame, area: Rect, app: &TuiApp) {
    let turns = conversation_lines(&app.frames, app.selected_app.as_str(), false);
    let content = if turns.is_empty() {
        vec![Line::from(Span::styled("等待当前会话输出...", Color::Gray))]
    } else {
        turns
    };
    frame.render_widget(
        Paragraph::new(content)
            .wrap(Wrap { trim: false })
            .block(focused_panel("会话流", app.focus == FocusPane::Conversation)),
        area,
    );
}

fn draw_composer(frame: &mut Frame, area: Rect, app: &TuiApp) {
    let inner = panel("Composer").inner(area);
    frame.render_widget(focused_panel("Composer", app.focus == FocusPane::Composer), area);
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(3),
            Constraint::Length(1),
        ])
        .split(inner);

    let actions = Line::from(vec![
        chip("F1 继续"), Span::raw(" "), chip("F2 提交"), Span::raw(" "), chip("F3 创建MR"), Span::raw(" "), chip("F4 合并MR"), Span::raw(" "), chip("F5 部署"),
    ]);
    frame.render_widget(Paragraph::new(actions), chunks[0]);

    let is_empty = app.prompt.is_empty();
    let prompt = if is_empty {
        "向当前会话发送指令..."
    } else {
        app.prompt.as_str()
    };
    frame.render_widget(
        Paragraph::new(prompt)
            .style(if is_empty { Color::Gray } else { Color::Black })
            .wrap(Wrap { trim: false }),
        chunks[1],
    );

    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(" Enter发送 ", Style::default().fg(Color::White).bg(Color::Black)),
            Span::styled("  Tab切换焦点  y确认 u拒绝  n新会话 c继续 s停止 x删除日志", muted_style()),
        ])),
        chunks[2],
    );
}

fn draw_status(frame: &mut Frame, area: Rect, app: &TuiApp) {
    let text = format!("{}  |  q二次确认退出 / Tab切换焦点 / 1-5切换 App / F1-F5快捷指令 / /搜索 / p输入 / x删除日志", app.status);
    frame.render_widget(Paragraph::new(text).style(muted_style()), area);
}

fn draw_inspector(frame: &mut Frame, area: Rect, app: &TuiApp) {
    let session = app.selected_session();
    let app_info = app.selected_app_info();
    let usage = app.selected_usage();
    let files = changed_files(&app.frames);
    let confirmations = app.selected_confirmations();
    let mut lines = vec![
        section("会话信息"),
        row("App", session.map(|s| app_label(&s.app_id)).or_else(|| app_info.map(|info| info.label.as_str())).unwrap_or("-")),
        row("模型", session.and_then(|s| s.model.as_deref()).unwrap_or("model pending")),
        row("计费", billing_mode(app_info.map(|info| info.billing_mode.as_str()).unwrap_or(""))),
        row("状态", session.map(|s| status_label(&s.status, s.live)).unwrap_or("-")),
        row("耗时", &session.map(format_duration).unwrap_or_else(|| "-".to_string())),
        row("Token", &format_token_count(session.map(|s| s.total_tokens).unwrap_or_else(|| usage.map(|u| u.total_tokens).unwrap_or(0)))),
        Line::from(""),
        section("连接状态"),
        row("命令", app_info.and_then(|info| info.command.as_deref()).or_else(|| app_info.map(|info| info.message.as_str())).unwrap_or("-")),
        row("输入", &format_token_count(session.map(|s| s.input_tokens).unwrap_or_else(|| usage.map(|u| u.input_tokens).unwrap_or(0)))),
        row("输出", &format_token_count(session.map(|s| s.output_tokens).unwrap_or_else(|| usage.map(|u| u.output_tokens).unwrap_or(0)))),
        Line::from(""),
        section(&format!("改动文件 · {}", files.len())),
    ];
    if files.is_empty() {
        lines.push(Line::from(Span::styled("最近历史中没有文件改动记录", Color::Gray)));
    } else {
        for file in files.into_iter().take(8) {
            lines.push(Line::from(Span::styled(file, Color::DarkGray)));
        }
    }
    if !confirmations.is_empty() {
        lines.push(Line::from(""));
        lines.push(section("确认队列"));
        for confirmation in confirmations {
            lines.push(Line::from(Span::styled(clip(&confirmation.reason, 28), Color::Yellow)));
        }
    }
    frame.render_widget(
        Paragraph::new(lines).wrap(Wrap { trim: false }).block(focused_panel("Inspector", app.focus == FocusPane::Inspector)),
        area,
    );
}

fn draw_small_warning(frame: &mut Frame, area: Rect) {
    let height = 3.min(area.height);
    let y = area.y + area.height.saturating_sub(height);
    let popup = Rect::new(area.x, y, area.width, height);
    frame.render_widget(Clear, popup);
    frame.render_widget(
        Paragraph::new("窗口较小：已切换为自适应布局；拉宽到 128 列以上可显示完整三栏 Inspector。")
            .style(muted_style())
            .wrap(Wrap { trim: true })
            .block(panel("提示")),
        popup,
    );
}

fn adaptive_width(total: u16, min: u16, max: u16, percent: u16) -> u16 {
    ((total as u32 * percent as u32 / 100) as u16).clamp(min, max)
}

fn adaptive_composer_height(total: u16) -> u16 {
    if total >= 42 {
        13
    } else if total >= 32 {
        11
    } else if total >= 24 {
        9
    } else {
        7
    }
}

fn compact_sidebar_height(total: u16) -> u16 {
    if total >= 36 {
        14
    } else if total >= 28 {
        11
    } else {
        9
    }
}

fn conversation_lines(frames: &[TerminalFrame], fallback_app_id: &str, show_process: bool) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let mut last_role = String::new();
    let mut folded_process = 0usize;
    for frame in frames.iter().rev().take(24).collect::<Vec<_>>().into_iter().rev() {
        for raw in frame.text.lines().flat_map(|line| display_line(line, frame)) {
            let (role, text) = split_role(&raw, &frame.stream);
            let normalized = normalize_role(role);
            let app_id = if frame.app_id.is_empty() { fallback_app_id } else { &frame.app_id };
            if is_process_role(normalized) && !show_process {
                folded_process += 1;
                continue;
            }
            if folded_process > 0 {
                lines.push(process_summary_line(folded_process));
                folded_process = 0;
            }
            if normalized != last_role && !lines.is_empty() {
                lines.push(Line::from(""));
            }
            lines.extend(message_block(app_id, role, &text));
            last_role = normalized.to_string();
        }
    }
    if folded_process > 0 {
        lines.push(process_summary_line(folded_process));
    }
    lines
}

fn is_process_role(role: &str) -> bool {
    matches!(role, "system" | "tool" | "output")
}

fn process_summary_line(count: usize) -> Line<'static> {
    Line::from(vec![
        Span::styled("  ▸ ", Color::DarkGray),
        Span::styled(format!("已折叠 {count} 条 SSE / 工具过程输出"), Color::DarkGray),
        Span::styled("  运行中会自动展开", Color::Gray),
    ])
}

fn message_block(app_id: &str, role: &str, text: &str) -> Vec<Line<'static>> {
    let normalized = normalize_role(role);
    let label = role_label(app_id, role);
    let mut lines = Vec::new();
    match normalized {
        "user" => {
            lines.push(Line::from(vec![
                Span::styled("  ", Color::Blue),
                Span::styled(label, Style::default().fg(Color::Blue).add_modifier(Modifier::BOLD)),
                Span::styled("  用户输入", muted_style()),
            ]));
            for line in wrap_message(text, 104) {
                lines.push(Line::from(vec![
                    Span::styled("    │ ", Style::default().fg(Color::Rgb(147, 197, 253))),
                    Span::styled(line, Style::default().fg(Color::Black).add_modifier(Modifier::BOLD)),
                ]));
            }
        }
        "assistant" => {
            lines.push(Line::from(vec![
                Span::styled("  ", app_color(app_id)),
                Span::styled(label, Style::default().fg(app_color(app_id)).add_modifier(Modifier::BOLD)),
                Span::styled("  Agent 回复", muted_style()),
            ]));
            for line in wrap_message(text, 108) {
                lines.push(Line::from(vec![
                    Span::styled("    │ ", Style::default().fg(app_color(app_id))),
                    Span::styled(line, Style::default().fg(Color::Black)),
                ]));
            }
        }
        "tool" | "system" => {
            lines.push(Line::from(vec![
                Span::styled("  · ", Color::DarkGray),
                Span::styled(label, role_style(app_id, role)),
                Span::styled("  ", Color::DarkGray),
                Span::styled(clip(text, 132), body_style(role)),
            ]));
        }
        "error" => {
            lines.push(Line::from(vec![
                Span::styled("  ! ", Color::Red),
                Span::styled(label, role_style(app_id, role)),
                Span::styled("  ", Color::Red),
                Span::styled(clip(text, 132), body_style(role)),
            ]));
        }
        _ => {
            lines.push(Line::from(vec![
                Span::styled(format!("{:>7} │ ", label), role_style(app_id, role)),
                Span::styled(clip(text, 120), body_style(role)),
            ]));
        }
    }
    lines
}

fn display_line(line: &str, frame: &TerminalFrame) -> Vec<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if trimmed.starts_with('{') {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
            return display_json(value);
        }
    }
    clean_text(trimmed)
        .lines()
        .map(|line| format!("{}> {}", frame.stream, line))
        .collect()
}

fn display_json(value: serde_json::Value) -> Vec<String> {
    let mut lines = Vec::new();
    let role = value.get("role").and_then(|v| v.as_str()).unwrap_or_else(|| value.get("type").and_then(|v| v.as_str()).unwrap_or("system"));
    if let Some(text) = first_text(&value, &["text", "content", "message", "summary", "output", "result", "last_agent_message"]) {
        lines.push(format!("{}> {}", normalize_role(role), clean_text(&text)));
    }
    if let Some(content) = value.get("message").and_then(|v| v.get("content")).and_then(|v| v.as_str()) {
        lines.push(format!("{}> {}", normalize_role(role), clean_text(content)));
    }
    if lines.is_empty() {
        if let Some(kind) = value.get("type").and_then(|v| v.as_str()) {
            if !matches!(kind, "ping" | "message_start" | "message_delta" | "content_block_start" | "content_block_delta") {
                lines.push(format!("system> {}", clip(&value.to_string(), 160)));
            }
        }
    }
    lines
}

fn first_text(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn split_role<'a>(line: &'a str, fallback: &'a str) -> (&'a str, String) {
    if let Some((role, text)) = line.split_once('>') {
        (role.trim(), text.trim().to_string())
    } else {
        (fallback, line.to_string())
    }
}

fn normalize_role(role: &str) -> &'static str {
    let role = role.to_lowercase();
    if role.contains("assistant") || role.contains("agent") || role.contains("model") {
        "assistant"
    } else if role.contains("user") || role.contains("human") {
        "user"
    } else if role.contains("tool") || role.contains("command") || role.contains("stdout") {
        "tool"
    } else if role.contains("error") || role.contains("stderr") {
        "error"
    } else if role.contains("system") || role.contains("event") || role.contains("token") {
        "system"
    } else {
        "output"
    }
}

fn role_label(app_id: &str, role: &str) -> &'static str {
    match normalize_role(role) {
        "user" => if app_id == "claude" { "Human" } else { "User" },
        "assistant" => app_label(app_id),
        "tool" => if app_id == "claude" { "Tool" } else { "Tool" },
        "error" => "Error",
        "system" => "System",
        _ => "Output",
    }
}

fn role_style(app_id: &str, role: &str) -> Style {
    match normalize_role(role) {
        "user" => Style::default().fg(Color::Blue).add_modifier(Modifier::BOLD),
        "assistant" => Style::default().fg(app_color(app_id)).add_modifier(Modifier::BOLD),
        "tool" => Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
        "error" => Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        "system" => Style::default().fg(Color::DarkGray).add_modifier(Modifier::BOLD),
        _ => Style::default().fg(Color::Gray),
    }
}

fn body_style(role: &str) -> Style {
    match normalize_role(role) {
        "error" => Style::default().fg(Color::Red),
        "system" => Style::default().fg(Color::DarkGray),
        "tool" => Style::default().fg(Color::DarkGray),
        _ => Style::default().fg(Color::Black),
    }
}

fn clean_text(text: &str) -> String {
    text.replace('\r', "\n")
        .lines()
        .map(|line| line.trim_end().to_string())
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn wrap_message(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for raw in clean_text(text).lines() {
        let chars = raw.chars().collect::<Vec<_>>();
        if chars.len() <= width {
            lines.push(raw.to_string());
            continue;
        }
        for chunk in chars.chunks(width) {
            lines.push(chunk.iter().collect());
        }
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn changed_files(frames: &[TerminalFrame]) -> Vec<String> {
    let mut files = Vec::new();
    for word in frames.iter().flat_map(|frame| frame.text.split_whitespace()) {
        let cleaned = word.trim_matches(|ch: char| matches!(ch, '"' | '\'' | '`' | ',' | ';' | ':' | ')' | ']' | '}'));
        if ["src/", "tests/", "test/", "app/", "server/", "client/", "packages/", "ui_kits/"].iter().any(|prefix| cleaned.starts_with(prefix)) && cleaned.contains('/') && !files.iter().any(|item| item == cleaned) {
            files.push(cleaned.to_string());
        }
    }
    files
}

fn format_duration(session: &Session) -> String {
    let Ok(start) = DateTime::parse_from_rfc3339(&session.created_at) else {
        return "-".to_string();
    };
    let Ok(end) = DateTime::parse_from_rfc3339(&session.updated_at) else {
        return "-".to_string();
    };
    let minutes = ((end - start).num_minutes()).max(1);
    if minutes < 60 {
        format!("{minutes}m")
    } else {
        let hours = minutes / 60;
        let rest = minutes % 60;
        if rest == 0 { format!("{hours}h") } else { format!("{hours}h {rest}m") }
    }
}

fn billing_mode(mode: &str) -> &'static str {
    match mode {
        "subscription" => "订阅 / 席位",
        "usage" => "API Key 按量",
        "included" => "App 内置额度",
        _ => "-",
    }
}

fn row(label: &str, value: &str) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("{label:<6}"), Color::Gray),
        Span::styled(clip(value, 22), Style::default().fg(Color::Black).add_modifier(Modifier::BOLD)),
    ])
}

fn section(title: &str) -> Line<'static> {
    Line::from(Span::styled(title.to_string(), Style::default().fg(Color::DarkGray).add_modifier(Modifier::BOLD)))
}

fn chip(text: &'static str) -> Span<'static> {
    Span::styled(
        format!(" {text} "),
        Style::default()
            .fg(Color::Rgb(13, 138, 114))
            .bg(Color::Rgb(235, 242, 239))
            .add_modifier(Modifier::BOLD),
    )
}

fn app_initials(app_id: &str) -> &'static str {
    match app_id {
        "codex" => "CX",
        "claude" => "CL",
        "antigravity" => "AG",
        "oh-my-pi" => "PI",
        "opencode" => "OC",
        _ => "AI",
    }
}

fn app_color(app_id: &str) -> Color {
    match app_id {
        "codex" => Color::Rgb(13, 138, 114),
        "claude" => Color::Rgb(189, 91, 47),
        "antigravity" => Color::Rgb(76, 111, 255),
        "oh-my-pi" => Color::Rgb(124, 58, 237),
        "opencode" => Color::Rgb(2, 132, 199),
        _ => Color::Gray,
    }
}

fn focus_style(active: bool) -> Style {
    if active {
        Style::default().fg(Color::Rgb(13, 138, 114))
    } else {
        subtle_border_style()
    }
}

fn panel(title: &'static str) -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(subtle_border_style())
        .title(Span::styled(format!(" {title} "), panel_title_style()))
}

fn focused_panel(title: &'static str, active: bool) -> Block<'static> {
    panel(title).border_style(focus_style(active))
}

fn seamless_panel(active: bool) -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(focus_style(active))
}

fn subtle_border_style() -> Style {
    Style::default().fg(Color::Rgb(180, 176, 169))
}

fn panel_title_style() -> Style {
    Style::default().fg(Color::Rgb(92, 86, 78)).add_modifier(Modifier::BOLD)
}

fn muted_style() -> Style {
    Style::default().fg(Color::Rgb(112, 108, 102))
}

fn clip(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut value = text.chars().take(limit.saturating_sub(1)).collect::<String>();
    value.push('…');
    value
}
