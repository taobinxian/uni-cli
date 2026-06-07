use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use crate::api::{app_label, WorkbenchApi};
use crate::types::{AppInfo, Confirmation, DashboardSnapshot, Session, TerminalFrame, TokenUsage, TokenUsageResult};

pub const APP_ORDER: [&str; 5] = ["codex", "claude", "antigravity", "oh-my-pi", "opencode"];
const INITIAL_SESSION_LIMIT: usize = 6;
const SESSION_LIMIT_INCREMENT: usize = 10;
const QUIT_CONFIRM_DELAY: Duration = Duration::from_millis(350);
const QUICK_ACTIONS: [(&str, &str); 5] = [
    ("继续当前任务", "继续当前任务，先简要说明当前状态和下一步，然后只执行必要操作。"),
    ("提交代码", "检查当前改动并运行必要验证；如果没有问题，创建一条清晰的 commit 提交当前代码。"),
    ("创建 MR", "基于当前分支创建 Merge Request，补充标题、改动说明、测试结果和风险点。"),
    ("合并 MR", "检查当前 Merge Request 状态、CI 和评审情况；满足条件后合并 MR。"),
    ("部署服务器", "确认当前分支和环境信息，检查必要配置，然后按项目约定部署到服务器。"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionFilter {
    All,
    Running,
    History,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeScope {
    Day,
    Week,
    Month,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusPane {
    Sidebar,
    Conversation,
    Inspector,
    Composer,
}

#[derive(Debug, Clone)]
pub struct TuiApp {
    pub api: WorkbenchApi,
    pub snapshot: DashboardSnapshot,
    pub selected_app: String,
    pub selected_session_id: Option<String>,
    pub frames: Vec<TerminalFrame>,
    pub filter: SessionFilter,
    pub scope: TimeScope,
    pub focus: FocusPane,
    pub query: String,
    pub prompt: String,
    pub status: String,
    pub should_quit: bool,
    pub refresh_requested: bool,
    pub pending_prompt: Option<(String, String)>,
    pub last_refresh: Option<DateTime<Utc>>,
    pub pending_delete_session_id: Option<String>,
    pending_quit_at: Option<Instant>,
    session_limits: BTreeMap<String, usize>,
}

impl TuiApp {
    pub fn new(api: WorkbenchApi) -> Self {
        Self {
            api,
            snapshot: DashboardSnapshot::default(),
            selected_app: "claude".to_string(),
            selected_session_id: None,
            frames: Vec::new(),
            filter: SessionFilter::All,
            scope: TimeScope::Day,
            focus: FocusPane::Conversation,
            query: String::new(),
            prompt: String::new(),
            status: "正在连接 Web 后端...".to_string(),
            should_quit: false,
            refresh_requested: false,
            pending_prompt: None,
            last_refresh: None,
            pending_delete_session_id: None,
            pending_quit_at: None,
            session_limits: BTreeMap::new(),
        }
    }

    pub fn apply_refresh_result(
        &mut self,
        snapshot: DashboardSnapshot,
        usage: Option<TokenUsageResult>,
        frames: Option<Vec<TerminalFrame>>,
    ) {
        self.snapshot = snapshot;
        if let Some(usage) = usage {
            self.snapshot.token_usage = usage.usage;
            self.snapshot.usage_series = usage.series;
        }
        self.ensure_selection();
        if let Some(frames) = frames {
            for frame in frames {
                self.push_frame(frame);
            }
        }
        self.last_refresh = Some(Utc::now());
        self.status = "已同步 Web 后端状态".to_string();
    }

    pub fn push_frame(&mut self, frame: TerminalFrame) {
        if self.selected_session_id.as_deref() != Some(frame.session_id.as_str()) {
            return;
        }
        if self.frames.iter().rev().take(8).any(|existing| {
            existing.session_id == frame.session_id
                && existing.app_id == frame.app_id
                && existing.stream == frame.stream
                && existing.text == frame.text
        }) {
            return;
        }
        self.frames.push(frame);
        if self.frames.len() > 120 {
            self.frames.drain(0..self.frames.len() - 120);
        }
    }

    pub async fn refresh(&mut self) {
        match self.api.dashboard().await {
            Ok(snapshot) => {
                self.snapshot = snapshot;
                self.ensure_selection();
                self.last_refresh = Some(Utc::now());
                self.status = "已同步 Web 后端状态".to_string();
                self.refresh_token_usage().await;
                self.refresh_history().await;
            }
            Err(error) => {
                self.status = format!("后端连接失败：{error}");
            }
        }
    }

    pub async fn refresh_history(&mut self) {
        let Some(session_id) = self.selected_session_id.clone() else {
            self.frames.clear();
            return;
        };
        match self.api.session_history(&session_id, 80).await {
            Ok(history) => {
                self.frames = history.frames;
            }
            Err(error) => {
                self.status = format!("读取会话历史失败：{error}");
            }
        }
    }

    pub async fn refresh_token_usage(&mut self) {
        match self.api.token_usage(self.scope.as_api()).await {
            Ok(result) => {
                self.snapshot.token_usage = result.usage;
                self.snapshot.usage_series = result.series;
            }
            Err(error) => {
                self.status = format!("读取 token 用量失败：{error}");
            }
        }
    }

    pub async fn handle_key(&mut self, key: KeyEvent) {
        if key.kind != KeyEventKind::Press {
            return;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            self.should_quit = true;
            return;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('r') {
            self.request_refresh();
            return;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('k') {
            self.focus = FocusPane::Sidebar;
            return;
        }
        if (key.modifiers.contains(KeyModifiers::CONTROL) || key.modifiers.contains(KeyModifiers::SUPER)) && key.code == KeyCode::Enter {
            self.queue_prompt();
            return;
        }
        if self.pending_quit_at.is_some() && !matches!(key.code, KeyCode::Char('q') | KeyCode::Esc) {
            self.pending_quit_at = None;
        }

        match key.code {
            KeyCode::Esc => {
                self.pending_delete_session_id = None;
                self.pending_quit_at = None;
                self.focus = FocusPane::Conversation;
            }
            KeyCode::Tab => {
                self.pending_quit_at = None;
                self.next_focus();
            }
            KeyCode::BackTab => {
                self.pending_quit_at = None;
                self.previous_focus();
            }
            KeyCode::Char('q') => self.confirm_quit(),
            KeyCode::F(1) => self.apply_quick_action(0),
            KeyCode::F(2) => self.apply_quick_action(1),
            KeyCode::F(3) => self.apply_quick_action(2),
            KeyCode::F(4) => self.apply_quick_action(3),
            KeyCode::F(5) if self.focus == FocusPane::Composer => self.apply_quick_action(4),
            KeyCode::F(5) => self.request_refresh(),
            KeyCode::Char('1') if self.focus != FocusPane::Composer => self.select_app("codex"),
            KeyCode::Char('2') if self.focus != FocusPane::Composer => self.select_app("claude"),
            KeyCode::Char('3') if self.focus != FocusPane::Composer => self.select_app("antigravity"),
            KeyCode::Char('4') if self.focus != FocusPane::Composer => self.select_app("oh-my-pi"),
            KeyCode::Char('5') if self.focus != FocusPane::Composer => self.select_app("opencode"),
            KeyCode::Char('a') if self.focus != FocusPane::Composer => self.filter = SessionFilter::All,
            KeyCode::Char('r') if self.focus != FocusPane::Composer => self.filter = SessionFilter::Running,
            KeyCode::Char('h') if self.focus != FocusPane::Composer => self.filter = SessionFilter::History,
            KeyCode::Char('d') if self.focus != FocusPane::Composer => self.set_scope(TimeScope::Day).await,
            KeyCode::Char('w') if self.focus != FocusPane::Composer => self.set_scope(TimeScope::Week).await,
            KeyCode::Char('m') if self.focus != FocusPane::Composer => self.set_scope(TimeScope::Month).await,
            KeyCode::Char('y') if self.focus != FocusPane::Composer => self.resolve_first_confirmation(true).await,
            KeyCode::Char('u') if self.focus != FocusPane::Composer => self.resolve_first_confirmation(false).await,
            KeyCode::Char('n') if self.focus != FocusPane::Composer => self.new_session().await,
            KeyCode::Char('c') if self.focus != FocusPane::Composer => self.continue_session().await,
            KeyCode::Char('s') if self.focus != FocusPane::Composer => self.stop_session().await,
            KeyCode::Char('x') if self.focus != FocusPane::Composer => self.delete_session().await,
            KeyCode::Char('/') if self.focus != FocusPane::Composer => {
                self.focus = FocusPane::Sidebar;
                self.query.clear();
            }
            KeyCode::Char('p') if self.focus != FocusPane::Composer => self.focus = FocusPane::Composer,
            KeyCode::Down if self.focus == FocusPane::Sidebar => self.move_session(1),
            KeyCode::Up if self.focus == FocusPane::Sidebar => self.move_session(-1),
            KeyCode::Enter if self.focus == FocusPane::Sidebar => self.show_more_sessions(),
            KeyCode::Enter if self.focus == FocusPane::Composer => self.queue_prompt(),
            KeyCode::Backspace if self.focus == FocusPane::Composer => {
                self.prompt.pop();
            }
            KeyCode::Backspace if self.focus == FocusPane::Sidebar => {
                self.query.pop();
            }
            KeyCode::Char(ch) if self.focus == FocusPane::Composer => self.prompt.push(ch),
            KeyCode::Char(ch) if self.focus == FocusPane::Sidebar => self.query.push(ch),
            _ => {}
        }
    }

    pub fn selected_session(&self) -> Option<&Session> {
        self.selected_session_id
            .as_ref()
            .and_then(|id| self.snapshot.sessions.iter().find(|session| &session.id == id))
    }

    pub fn selected_app_info(&self) -> Option<&AppInfo> {
        self.snapshot.apps.iter().find(|app| app.app_id == self.selected_app)
    }

    pub fn selected_usage(&self) -> Option<&TokenUsage> {
        self.snapshot
            .token_usage
            .iter()
            .find(|usage| usage.app_id == self.selected_app)
    }

    pub fn selected_confirmations(&self) -> Vec<&Confirmation> {
        let session_id = self.selected_session_id.as_deref();
        self.snapshot
            .confirmations
            .iter()
            .filter(|confirmation| Some(confirmation.session_id.as_str()) == session_id)
            .collect()
    }

    pub fn visible_sessions(&self) -> Vec<&Session> {
        self.visible_sessions_for_app(&self.selected_app)
    }

    pub fn matching_sessions_for_app(&self, app_id: &str) -> Vec<&Session> {
        let query = self.query.trim().to_lowercase();
        self.snapshot
            .sessions
            .iter()
            .filter(|session| session.app_id == app_id)
            .filter(|session| match self.filter {
                SessionFilter::All => true,
                SessionFilter::Running => session.live || session.status == "running",
                SessionFilter::History => !session.live && session.status != "running",
            })
            .filter(|session| {
                query.is_empty()
                    || session.title.to_lowercase().contains(&query)
                    || session.id.to_lowercase().contains(&query)
                    || session.cwd.as_deref().unwrap_or_default().to_lowercase().contains(&query)
                    || session.model.as_deref().unwrap_or_default().to_lowercase().contains(&query)
            })
            .collect()
    }

    pub fn visible_sessions_for_app(&self, app_id: &str) -> Vec<&Session> {
        self.matching_sessions_for_app(app_id)
            .into_iter()
            .take(self.session_limit(app_id))
            .collect()
    }

    fn session_limit(&self, app_id: &str) -> usize {
        self.session_limits.get(app_id).copied().unwrap_or(INITIAL_SESSION_LIMIT)
    }

    pub fn open_tabs(&self) -> Vec<&Session> {
        let mut picked: Vec<&Session> = Vec::new();
        if let Some(selected) = self.selected_session() {
            picked.push(selected);
        }
        for session in self
            .snapshot
            .sessions
            .iter()
            .filter(|session| session.live || session.status == "running")
        {
            if picked.len() >= 4 {
                break;
            }
            if !picked.iter().any(|item| item.id == session.id) {
                picked.push(session);
            }
        }
        for app_id in APP_ORDER {
            if picked.len() >= 4 {
                break;
            }
            if let Some(session) = self.snapshot.sessions.iter().find(|session| session.app_id == app_id) {
                if !picked.iter().any(|item| item.id == session.id) {
                    picked.push(session);
                }
            }
        }
        picked
    }

    fn ensure_selection(&mut self) {
        if self
            .selected_session_id
            .as_ref()
            .map(|id| self.snapshot.sessions.iter().any(|session| &session.id == id))
            .unwrap_or(false)
        {
            return;
        }
        let preferred = self
            .snapshot
            .sessions
            .iter()
            .find(|session| session.app_id == self.selected_app)
            .or_else(|| self.snapshot.sessions.first());
        if let Some(session) = preferred {
            self.selected_app = session.app_id.clone();
            self.selected_session_id = Some(session.id.clone());
        }
    }

    fn select_app(&mut self, app_id: &str) {
        self.selected_app = app_id.to_string();
        self.selected_session_id = self
            .snapshot
            .sessions
            .iter()
            .find(|session| session.app_id == app_id)
            .map(|session| session.id.clone());
        self.frames.clear();
        self.status = "已切换 App，正在后台加载会话历史".to_string();
    }

    fn move_session(&mut self, delta: isize) {
        let sessions = self.visible_sessions();
        if sessions.is_empty() {
            return;
        }
        let current = self
            .selected_session_id
            .as_ref()
            .and_then(|id| sessions.iter().position(|session| &session.id == id))
            .unwrap_or(0);
        if delta > 0 && current + 1 >= sessions.len() && self.has_more_sessions(&self.selected_app) {
            self.show_more_sessions();
        }
        let sessions = self.visible_sessions();
        let next = (current as isize + delta).clamp(0, sessions.len() as isize - 1) as usize;
        let next_id = sessions[next].id.clone();
        if self.selected_session_id.as_deref() != Some(next_id.as_str()) {
            self.selected_session_id = Some(next_id);
            self.frames.clear();
            self.status = "已切换会话，正在后台加载历史".to_string();
        }
    }

    fn show_more_sessions(&mut self) {
        let app_id = self.selected_app.clone();
        let total = self.matching_sessions_for_app(&app_id).len();
        let current = self.session_limit(&app_id);
        if total <= current {
            self.status = "当前 App 没有更多会话".to_string();
            return;
        }
        let next = (current + SESSION_LIMIT_INCREMENT).min(total);
        self.session_limits.insert(app_id, next);
        self.status = format!("已继续显示会话：{next}/{total}");
    }

    fn has_more_sessions(&self, app_id: &str) -> bool {
        self.matching_sessions_for_app(app_id).len() > self.session_limit(app_id)
    }

    fn request_refresh(&mut self) {
        self.refresh_requested = true;
        self.status = "正在后台刷新 Web 后端状态".to_string();
    }

    fn apply_quick_action(&mut self, index: usize) {
        let Some((label, prompt)) = QUICK_ACTIONS.get(index) else {
            return;
        };
        self.pending_quit_at = None;
        self.prompt = (*prompt).to_string();
        self.focus = FocusPane::Composer;
        self.status = format!("已填入快捷指令：{label}");
    }

    fn confirm_quit(&mut self) {
        let now = Instant::now();
        if self
            .pending_quit_at
            .is_some_and(|started| now.duration_since(started) >= QUIT_CONFIRM_DELAY)
        {
            self.should_quit = true;
            return;
        }
        self.pending_quit_at = Some(now);
        self.status = "再次按 q 退出 TUI；Esc 取消".to_string();
    }

    async fn set_scope(&mut self, scope: TimeScope) {
        self.scope = scope;
        self.refresh_token_usage().await;
        self.status = format!("已切换到 {} token 视图", scope_label(scope));
    }

    async fn resolve_first_confirmation(&mut self, approved: bool) {
        let Some(id) = self.selected_confirmations().first().map(|item| item.id.clone()) else {
            self.status = "当前会话没有待确认动作".to_string();
            return;
        };
        match self.api.resolve_confirmation(&id, approved).await {
            Ok(_) => {
                self.status = if approved { "已确认队列中的第一个动作" } else { "已拒绝队列中的第一个动作" }.to_string();
                self.refresh().await;
            }
            Err(error) => self.status = format!("处理确认队列失败：{error}"),
        }
    }

    async fn new_session(&mut self) {
        match self.api.start_session(&self.selected_app).await {
            Ok(session) => {
                self.status = format!("已创建 {} {}", app_label(&session.app_id), session_short(&session.id));
                self.selected_session_id = Some(session.id);
                self.refresh().await;
            }
            Err(error) => self.status = format!("创建会话失败：{error}"),
        }
    }

    async fn continue_session(&mut self) {
        let Some(session_id) = self.selected_session_id.clone() else {
            return;
        };
        match self.api.continue_session(&session_id).await {
            Ok(_) => {
                self.status = "已请求继续当前任务".to_string();
                self.refresh().await;
            }
            Err(error) => self.status = format!("继续会话失败：{error}"),
        }
    }

    async fn stop_session(&mut self) {
        let Some(session_id) = self.selected_session_id.clone() else {
            return;
        };
        match self.api.stop_session(&session_id).await {
            Ok(_) => {
                self.status = "已请求停止当前会话".to_string();
                self.refresh().await;
            }
            Err(error) => self.status = format!("停止会话失败：{error}"),
        }
    }

    async fn delete_session(&mut self) {
        let Some(session_id) = self.selected_session_id.clone() else {
            return;
        };
        let Some(session) = self.selected_session().cloned() else {
            self.status = "当前没有可删除的会话".to_string();
            return;
        };
        if session.live || session.status == "running" {
            self.status = "当前会话仍在运行，请先按 s 停止，再按 x 删除原始日志".to_string();
            return;
        }
        if self.pending_delete_session_id.as_deref() != Some(session_id.as_str()) {
            self.pending_delete_session_id = Some(session_id.clone());
            self.status = format!("再次按 x 确认删除 {} 的 CLI 原始日志；Esc 取消", session_short(&session_id));
            return;
        }
        self.pending_delete_session_id = None;
        match self.api.delete_session(&session_id).await {
            Ok(_) => {
                self.status = "已删除当前会话的 CLI 原始日志".to_string();
                self.selected_session_id = None;
                self.refresh().await;
            }
            Err(error) => self.status = format_delete_error(&error.to_string()),
        }
    }

    fn queue_prompt(&mut self) {
        let Some(session_id) = self.selected_session_id.clone() else {
            return;
        };
        let prompt = self.prompt.trim().to_string();
        if prompt.is_empty() {
            return;
        }
        self.prompt.clear();
        self.frames.push(TerminalFrame {
            session_id: session_id.clone(),
            app_id: self.selected_app.clone(),
            stream: "user".to_string(),
            text: prompt.clone(),
            created_at: Utc::now().to_rfc3339(),
        });
        self.pending_prompt = Some((session_id, prompt));
        self.status = "正在后台发送指令...".to_string();
    }

    fn next_focus(&mut self) {
        self.focus = match self.focus {
            FocusPane::Sidebar => FocusPane::Conversation,
            FocusPane::Conversation => FocusPane::Inspector,
            FocusPane::Inspector => FocusPane::Composer,
            FocusPane::Composer => FocusPane::Sidebar,
        };
    }

    fn previous_focus(&mut self) {
        self.focus = match self.focus {
            FocusPane::Sidebar => FocusPane::Composer,
            FocusPane::Conversation => FocusPane::Sidebar,
            FocusPane::Inspector => FocusPane::Conversation,
            FocusPane::Composer => FocusPane::Inspector,
        };
    }
}

impl TimeScope {
    pub fn as_api(self) -> &'static str {
        match self {
            TimeScope::Day => "day",
            TimeScope::Week => "week",
            TimeScope::Month => "month",
        }
    }
}

pub fn format_token_count(value: u64) -> String {
    if value >= 1_000_000_000 {
        trim_number(value as f64 / 1_000_000_000.0, "B")
    } else if value >= 1_000_000 {
        trim_number(value as f64 / 1_000_000.0, "M")
    } else if value >= 1_000 {
        trim_number(value as f64 / 1_000.0, "K")
    } else {
        value.to_string()
    }
}

pub fn session_short(id: &str) -> String {
    format!("#{}", id.chars().rev().take(6).collect::<String>().chars().rev().collect::<String>())
}

pub fn status_label(status: &str, live: bool) -> &'static str {
    if live {
        "live"
    } else {
        match status {
            "running" => "进行中",
            "completed" => "完成",
            "stopped" => "停止",
            "pending" => "队列",
            _ => "中断",
        }
    }
}

pub fn scope_label(scope: TimeScope) -> &'static str {
    match scope {
        TimeScope::Day => "今日",
        TimeScope::Week => "本周",
        TimeScope::Month => "本月",
    }
}

fn format_delete_error(error: &str) -> String {
    if error.contains("没有找到对应的 CLI 原始日志文件") {
        "删除失败：左侧记录存在，但没有找到对应的 CLI 原始日志文件；该记录不能通过 x 删除源日志".to_string()
    } else if error.contains("404") || error.contains("Session not found") {
        "删除失败：后端没有找到这个会话，按 F5 刷新列表后重试".to_string()
    } else if error.contains("409") {
        "删除失败：后端拒绝删除当前会话，请先停止或稍后刷新后重试".to_string()
    } else {
        format!("删除会话失败：{error}")
    }
}

fn trim_number(value: f64, suffix: &str) -> String {
    let mut text = format!("{value:.2}");
    while text.contains('.') && text.ends_with('0') {
        text.pop();
    }
    if text.ends_with('.') {
        text.pop();
    }
    format!("{text}{suffix}")
}
