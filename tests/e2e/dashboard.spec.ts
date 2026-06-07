import { expect, test, type Page } from '@playwright/test';

test('focus console shows token counts without token percentages', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('focus-console')).toBeVisible();
  await expect(page.getByText('Focus Console')).toBeVisible();
  const tokenCard = page.getByTestId('token-count-card');
  await expect(tokenCard).toBeVisible();
  await expect(tokenCard).toContainText('TOKEN');
  await tokenCard.getByRole('button').first().click();
  await expect(tokenCard).toContainText('Codex');
  await expect(tokenCard).toContainText('Claude');
  await expect(tokenCard).toContainText('Antigravity');
  await expect(tokenCard).toContainText('tokens');
  await expect(tokenCard).not.toContainText('%');
  await expect(page.getByText('73%')).toHaveCount(0);
});

test('focus sidebar app sources switch the active workbench', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('focus-console')).toBeVisible();
  await expect(page.getByTestId('task-table')).toHaveCount(0);
  await expect(page.getByTestId('nav-running')).toHaveCount(0);
  await expect(page.getByTestId('nav-completed')).toHaveCount(0);

  await page.getByTestId('nav-codex').click();
  await expect(page).toHaveURL(/#codex$/);
  await expect(page.getByTestId('session-switcher')).toBeVisible();
  await expect(page.getByTestId('control-panel')).toContainText('Codex');

  await page.getByTestId('nav-claude').click();
  await expect(page).toHaveURL(/#claude$/);
  await expect(page.getByTestId('control-panel')).toContainText('Claude');

  await page.getByTestId('nav-antigravity').click();
  await expect(page).toHaveURL(/#antigravity$/);
  await expect(page.getByTestId('control-panel')).toContainText('Antigravity');
});

test('focus console controls export real report', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'export is in the desktop inspector panel');

  await page.goto('/');
  await expect(page.getByTestId('control-panel')).toBeVisible();
  await expect(page.getByPlaceholder(/向当前会话发送指令/)).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('export-report').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^ai-coding-workbench-(day|week|month)-.+\.json$/);
});

test('session switcher rows select historical sessions for continuation', async ({ page }) => {
  const response = await page.request.get('/api/sessions');
  const sessions = (await response.json()) as Array<{ id: string; appId: string; status: string }>;
  if (sessions.length === 0) {
    test.skip(true, 'no historical sessions on this machine');
    return;
  }
  const target = sessions[0];

  const row = await openSessionInSwitcher(page, target);
  await expect(row).toHaveClass(/active/);
  await expect(row).toContainText(target.id.slice(-6));
  await expect(row.locator('.status')).toBeVisible();
  await expect(page.getByTestId('control-panel')).toContainText(appLabel(target.appId));
  await expect(page.getByTestId('control-panel')).toContainText(target.id.slice(-6));
  await expect(page.getByTestId('control-panel').getByRole('button', { name: '继续' })).toBeEnabled();
});

test('session switcher reveals additional sessions per app', async ({ page }) => {
  const response = await page.request.get('/api/sessions');
  const sessions = (await response.json()) as Array<{ id: string; appId: string }>;
  const grouped = appIds
    .map((appId) => ({ appId, sessions: sessions.filter((session) => session.appId === appId) }))
    .find((group) => group.sessions.length > 6);
  if (!grouped) {
    test.skip(true, 'no app has more than 6 sessions on this machine');
    return;
  }

  await page.goto(`/#${grouped.appId}`);
  await expect(page.getByTestId('session-switcher')).toContainText('显示其余');
  await page.getByRole('button', { name: /显示其余/ }).first().click();
  await expect(page.getByTestId(`session-row-${grouped.sessions[6].id}`)).toBeVisible();
});

test('focus console uses source list, workbench, and inspector columns', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'mobile stacks the focus console');

  await page.goto('/');
  const sessionSwitcher = page.getByTestId('session-switcher');
  const controlPanel = page.getByTestId('control-panel');
  await expect(sessionSwitcher).toBeVisible();
  await expect(controlPanel).toBeVisible();
  await expect(page.locator('.focus-inspector')).toBeVisible();

  const sidebarWidth = await sessionSwitcher.evaluate((element) => element.closest('.focus-sidebar')!.getBoundingClientRect().width);
  const workbenchWidth = await controlPanel.evaluate((element) => element.getBoundingClientRect().width);
  expect(sidebarWidth).toBeLessThan(workbenchWidth);
});

test('selected historical session loads transcript content', async ({ page }) => {
  const target = await firstVisibleSessionWithHistory(page, (history) => history.frames.some((frame) => historyFrameText(frame.text).length >= 8));
  if (!target) {
    test.skip(true, 'no visible session has transcript content');
    return;
  }

  await openSessionInSwitcher(page, target);
  await expect(page.getByTestId('terminal-conversation')).toContainText(target.id.slice(-6));
  await expect(page.locator('.tui-turn')).not.toHaveCount(0);
});

test('assistant markdown replies render rich markdown formatting', async ({ page }) => {
  const target = await firstVisibleSessionWithHistory(page, (history) => history.frames.some((frame) => {
    const message = historyFrameMessage(frame.text);
    return message.role === 'assistant' && /(^#{1,6}\s|\*\*[^*]+\*\*|`[^`]+`|^\s*[-*+]\s+)/m.test(message.text);
  }), 12);
  if (!target) {
    test.skip(true, 'no visible completed assistant reply contains markdown formatting');
    return;
  }

  await openSessionInSwitcher(page, target);
  await expect(page.locator('.message-turn.assistant .markdown-body')).not.toHaveCount(0);
  await expect(page.locator('.message-turn.assistant .markdown-body strong, .message-turn.assistant .markdown-body code, .message-turn.assistant .markdown-body li, .message-turn.assistant .markdown-body h1, .message-turn.assistant .markdown-body h2, .message-turn.assistant .markdown-body h3')).not.toHaveCount(0);
});

test('delete selected session uses in-app confirmation before removal', async ({ page }) => {
  const response = await page.request.get('/api/sessions');
  const sessions = (await response.json()) as Array<{ id: string }>;
  if (sessions.length === 0) {
    test.skip(true, 'no sessions on this machine');
    return;
  }
  page.on('dialog', () => {
    throw new Error('delete confirmation should not use a browser dialog');
  });

  await page.goto('/#sessions');
  await page.getByTestId('delete-session').click();
  await expect(page.getByTestId('delete-session-dialog')).toBeVisible();
  await expect(page.getByTestId('delete-session-dialog')).toContainText('删除选中会话');
  await expect(page.getByTestId('delete-session-dialog')).toContainText('会删除该会话对应的 CLI 原始日志文件');
  await page.getByTestId('delete-session-cancel').click();
  await expect(page.getByTestId('delete-session-dialog')).toHaveCount(0);
  const afterResponse = await page.request.get('/api/sessions');
  const afterSessions = (await afterResponse.json()) as Array<{ id: string }>;
  expect(afterSessions.length).toBe(sessions.length);
});

const appIds = ['codex', 'claude', 'antigravity'];

async function openSessionInSwitcher(page: Page, session: { id: string; appId: string }) {
  await page.goto(`/#${session.appId}`);
  const row = page.getByTestId(`session-row-${session.id}`);
  await expect(row).toBeVisible();
  await row.click();
  return row;
}

async function firstVisibleSessionWithHistory(
  page: Page,
  predicate: (history: { frames: Array<{ text: string }> }) => boolean,
  limit?: number
): Promise<{ id: string; appId: string } | undefined> {
  const response = await page.request.get('/api/sessions');
  const sessions = (await response.json()) as Array<{ id: string; appId: string }>;
  const candidates = appIds.flatMap((appId) => sessions.filter((session) => session.appId === appId).slice(0, 20));
  for (const session of candidates) {
    const historyResponse = await page.request.get(`/api/sessions/${encodeURIComponent(session.id)}/history${limit ? `?limit=${limit}` : ''}`);
    if (!historyResponse.ok()) continue;
    const history = (await historyResponse.json()) as { frames: Array<{ text: string }> };
    if (predicate(history)) return session;
  }
  return undefined;
}

function appLabel(appId: string): string {
  if (appId === 'codex') return 'Codex';
  if (appId === 'claude') return 'Claude';
  return 'Antigravity';
}

function historyFrameText(raw: string): string {
  return historyFrameMessage(raw).text;
}

function historyFrameMessage(raw: string): { role?: string; text: string } {
  try {
    const parsed = JSON.parse(raw) as { role?: string; text?: string };
    return { role: parsed.role, text: parsed.text ?? '' };
  } catch {
    return { text: raw };
  }
}
