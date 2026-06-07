use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSnapshot {
    #[serde(default)]
    pub apps: Vec<AppInfo>,
    #[serde(default)]
    pub sessions: Vec<Session>,
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub token_usage: Vec<TokenUsage>,
    #[serde(default)]
    pub usage_series: Vec<UsagePoint>,
    #[serde(default)]
    pub events: Vec<EventRecord>,
    #[serde(default)]
    pub confirmations: Vec<Confirmation>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub app_id: String,
    pub label: String,
    #[serde(default)]
    pub command: Option<String>,
    pub status: String,
    pub message: String,
    #[serde(default)]
    pub sessions: u64,
    #[serde(default)]
    pub tasks: u64,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub billing_mode: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub app_id: String,
    #[serde(default)]
    pub native_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub cwd: Option<String>,
    pub status: String,
    #[serde(default)]
    pub model: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
    #[serde(default)]
    pub live: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub session_id: String,
    pub app_id: String,
    pub title: String,
    #[serde(default)]
    pub cwd: Option<String>,
    pub status: String,
    #[serde(default)]
    pub billing_mode: String,
    pub started_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub app_id: String,
    pub scope: String,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageResult {
    #[serde(default)]
    pub usage: Vec<TokenUsage>,
    #[serde(default)]
    pub series: Vec<UsagePoint>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct UsagePoint {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub codex: u64,
    #[serde(default)]
    pub claude: u64,
    #[serde(default)]
    pub antigravity: u64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub id: String,
    #[serde(default)]
    pub r#type: String,
    #[serde(default)]
    pub app_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    pub message: String,
    #[serde(default)]
    pub token_delta: Option<i64>,
    pub created_at: String,
    #[serde(default)]
    pub payload: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Confirmation {
    pub id: String,
    pub session_id: String,
    pub app_id: String,
    #[serde(default)]
    pub command_run_id: Option<String>,
    pub reason: String,
    pub status: String,
    pub created_at: String,
    #[serde(default)]
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalFrame {
    pub session_id: String,
    pub app_id: String,
    pub stream: String,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistory {
    pub session_id: String,
    #[serde(default)]
    pub frames: Vec<TerminalFrame>,
    #[serde(default)]
    pub has_more: bool,
    #[serde(default)]
    pub next_cursor: Option<u64>,
    #[serde(default)]
    pub total_frames: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSessionInput {
    pub app_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PromptInput {
    pub prompt: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRunResult {
    #[serde(default)]
    pub confirmation: Option<Confirmation>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OkResponse {
    pub ok: bool,
}
