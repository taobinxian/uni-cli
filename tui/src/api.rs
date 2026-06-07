use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::Client;

use crate::types::{
    CommandRunResult, DashboardSnapshot, OkResponse, PromptInput, Session, SessionHistory,
    StartSessionInput, TokenUsageResult,
};

#[derive(Debug, Clone)]
pub struct WorkbenchApi {
    base_url: String,
    client: Client,
}

impl WorkbenchApi {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            client: Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .expect("build HTTP client"),
        }
    }

    pub async fn dashboard(&self) -> Result<DashboardSnapshot> {
        self.get("/api/dashboard").await
    }

    pub async fn token_usage(&self, scope: &str) -> Result<TokenUsageResult> {
        self.get(&format!("/api/token-usage?scope={scope}")).await
    }

    pub async fn session_history(&self, session_id: &str, limit: u64) -> Result<SessionHistory> {
        self.get(&format!("/api/sessions/{}/history?limit={}", url_part(session_id), limit))
            .await
    }

    pub async fn start_session(&self, app_id: &str) -> Result<Session> {
        self.post(
            "/api/sessions",
            &StartSessionInput {
                app_id: app_id.to_string(),
                prompt: None,
                cwd: None,
                title: Some(format!("{} session", app_label(app_id))),
            },
        )
        .await
    }

    pub async fn send_prompt(&self, session_id: &str, prompt: String) -> Result<CommandRunResult> {
        self.post(
            &format!("/api/sessions/{}/prompt", url_part(session_id)),
            &PromptInput { prompt },
        )
        .await
    }

    pub async fn continue_session(&self, session_id: &str) -> Result<OkResponse> {
        self.post_empty(&format!("/api/sessions/{}/continue", url_part(session_id)))
            .await
    }

    pub async fn stop_session(&self, session_id: &str) -> Result<OkResponse> {
        self.post_empty(&format!("/api/sessions/{}/stop", url_part(session_id)))
            .await
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<serde_json::Value> {
        let url = self.url(&format!("/api/sessions/{}", url_part(session_id)));
        let response = self.client.delete(url).send().await.context("delete session")?;
        self.decode(response).await
    }

    pub async fn resolve_confirmation(&self, id: &str, approved: bool) -> Result<serde_json::Value> {
        let action = if approved { "approve" } else { "reject" };
        self.post_empty_value(&format!("/api/confirmations/{}/{}", url_part(id), action))
            .await
    }

    async fn get<T>(&self, path: &str) -> Result<T>
    where
        T: serde::de::DeserializeOwned,
    {
        let response = self.client.get(self.url(path)).send().await.context("GET request")?;
        self.decode(response).await
    }

    async fn post<B, T>(&self, path: &str, body: &B) -> Result<T>
    where
        B: serde::Serialize + ?Sized,
        T: serde::de::DeserializeOwned,
    {
        let response = self
            .client
            .post(self.url(path))
            .json(body)
            .send()
            .await
            .context("POST request")?;
        self.decode(response).await
    }

    async fn post_empty(&self, path: &str) -> Result<OkResponse> {
        let response = self.client.post(self.url(path)).send().await.context("POST request")?;
        self.decode(response).await
    }

    async fn post_empty_value(&self, path: &str) -> Result<serde_json::Value> {
        let response = self.client.post(self.url(path)).send().await.context("POST request")?;
        self.decode(response).await
    }

    async fn decode<T>(&self, response: reqwest::Response) -> Result<T>
    where
        T: serde::de::DeserializeOwned,
    {
        let status = response.status();
        let text = response.text().await.context("read response body")?;
        if !status.is_success() {
            let message = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|value| value.get("error").and_then(|error| error.as_str()).map(str::to_string))
                .unwrap_or(text);
            anyhow::bail!("{} {}", status, message);
        }
        serde_json::from_str(&text).context("decode response json")
    }

    pub fn session_stream_url(&self, session_id: &str) -> String {
        self.url(&format!("/sse/sessions/{}", url_part(session_id)))
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }
}

pub fn app_label(app_id: &str) -> &'static str {
    match app_id {
        "codex" => "Codex",
        "claude" => "Claude",
        "antigravity" => "Antigravity",
        "oh-my-pi" => "Oh My Pi",
        "opencode" => "OpenCode",
        _ => "App",
    }
}

fn url_part(value: &str) -> String {
    value.replace('%', "%25").replace('/', "%2F").replace('#', "%23").replace(' ', "%20")
}
