import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from 'react';
import {
  appInitials,
  appLabel,
  continueSession,
  deleteSession,
  eventsStream,
  getDashboard,
  getSessionHistory,
  getSessions,
  getTokenUsage,
  resolveConfirmation,
  sessionStream,
  sendPrompt,
  startSession,
  stopSession
} from './api.js';
import { formatDuration, formatTokenCount } from '../shared/format.js';
import { APP_ORDER, type AppId, type AppInfo, type Confirmation, type EventRecord, type Session, type TerminalFrame, type TimeScope, type TokenUsage, type UsagePoint } from '../shared/types.js';

const appOrder = APP_ORDER;
const TOKEN_ALERT_THRESHOLD = 2_000_000;
const HISTORY_PAGE_SIZE = 12;
const SESSION_PAGE_SIZE = 20;
const LIVE_TERMINAL_FRAME_LIMIT = 80;
const TERMINAL_DISPLAY_LINE_LIMIT = 360;
const WORKSPACE_SPLIT_STORAGE_KEY = 'ai-workbench.workspace-split.v1';
const DEFAULT_WORKSPACE_LEFT_PERCENT = 46;
const FOCUS_LAYOUT_STORAGE_KEY = 'ai-workbench.focus-layout.v1';
const DEFAULT_FOCUS_LEFT_WIDTH = 138;
const DEFAULT_FOCUS_RIGHT_WIDTH = 176;
const FOCUS_RESIZER_WIDTH = 6;
const FOCUS_MIN_LEFT_WIDTH = 112;
const FOCUS_MAX_LEFT_WIDTH = 340;
const FOCUS_MIN_RIGHT_WIDTH = 132;
const FOCUS_MAX_RIGHT_WIDTH = 380;
const FOCUS_MIN_CENTER_WIDTH = 420;
const THEME_STORAGE_KEY = 'ai-workbench.theme.v1';
type NavKey = 'overview' | 'sessions' | 'confirmations' | AppId;
type FocusResizeSide = 'left' | 'right';
type ThemeMode = 'light' | 'dark';
interface FocusLayout {
  left: number;
  right: number;
}

export function App() {
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [confirmations, setConfirmations] = useState<Confirmation[]>([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage[]>([]);
  const [series, setSeries] = useState<UsagePoint[]>([]);
  const [historicalFrames, setHistoricalFrames] = useState<TerminalFrame[]>([]);
  const [liveTerminalFrames, setLiveTerminalFrames] = useState<TerminalFrame[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number>();
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyLoadingRef = useRef(false);
  const [scope, setScope] = useState<TimeScope>('day');
  const [selectedApp, setSelectedApp] = useState<AppId>('codex');
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [activeNav, setActiveNav] = useState<NavKey>(() => navFromHash());
  const [prompt, setPrompt] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Session>();
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    refreshAll().catch((err) => setError(String(err)));
    const stream = eventsStream((event) => {
      setEvents((current) => [event, ...current].slice(0, 40));
      if (event.type === 'confirmation.required') {
        setConfirmations((current) => mergeConfirmation(current, event.payload as Confirmation));
      }
      if (event.type === 'task.updated' || event.type === 'session.updated' || event.type === 'token.updated') {
        reloadLists().catch((err) => setError(String(err)));
        getTokenUsage(scope)
          .then((result) => {
            setTokenUsage(result.usage);
            setSeries(result.series);
          })
          .catch((err) => setError(String(err)));
      }
    });
    return () => stream.close();
  }, [scope]);

  useEffect(() => {
    getTokenUsage(scope)
      .then((result) => {
        setTokenUsage(result.usage);
        setSeries(result.series);
      })
      .catch((err) => setError(String(err)));
  }, [scope]);

  useEffect(() => {
    const onHashChange = () => setActiveNav(navFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (isAppId(activeNav)) {
      const current = sessions.find((session) => session.id === selectedSessionId && session.appId === activeNav);
      const first = current ?? sessions.find((session) => session.appId === activeNav);
      setSelectedApp(activeNav);
      if (first && selectedSessionId !== first.id) setSelectedSessionId(first.id);
      if (!first && selectedSessionId) setSelectedSessionId(undefined);
    }
    if (activeNav === 'confirmations') {
      const first = confirmations[0];
      if (first) {
        setSelectedApp(first.appId);
        if (selectedSessionId !== first.sessionId) setSelectedSessionId(first.sessionId);
      }
    }
  }, [activeNav, confirmations, selectedSessionId, sessions]);

  useEffect(() => {
    const first = sessions.find((session) => session.appId === selectedApp);
    const current = sessions.find((session) => session.id === selectedSessionId);
    if (first && (!selectedSessionId || current?.appId !== selectedApp)) {
      setSelectedSessionId(first.id);
    }
    if (!first && current?.appId !== selectedApp) {
      setSelectedSessionId(undefined);
    }
  }, [selectedApp, selectedSessionId, sessions]);

  useEffect(() => {
    let cancelled = false;
    setHistoricalFrames([]);
    setLiveTerminalFrames([]);
    setHistoryCursor(undefined);
    setHistoryHasMore(false);
    historyLoadingRef.current = Boolean(selectedSessionId);
    setHistoryLoading(Boolean(selectedSessionId));
    if (!selectedSessionId) {
      historyLoadingRef.current = false;
      return undefined;
    }

    getSessionHistory(selectedSessionId, { limit: HISTORY_PAGE_SIZE })
      .then((history) => {
        if (!cancelled) {
          setHistoricalFrames(history.frames);
          setHistoryCursor(history.nextCursor);
          setHistoryHasMore(history.hasMore);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) {
          historyLoadingRef.current = false;
          setHistoryLoading(false);
        }
      });

    const stream = sessionStream(selectedSessionId, (frame) => {
      setLiveTerminalFrames((current) => [...current, frame].slice(-LIVE_TERMINAL_FRAME_LIMIT));
    });
    return () => {
      cancelled = true;
      stream.close();
    };
  }, [selectedSessionId]);

  async function loadMoreHistory() {
    if (!selectedSessionId || !historyHasMore || historyLoadingRef.current) return;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    try {
      const history = await getSessionHistory(selectedSessionId, { limit: HISTORY_PAGE_SIZE, cursor: historyCursor });
      setHistoricalFrames((current) => [...history.frames, ...current]);
      setHistoryCursor(history.nextCursor);
      setHistoryHasMore(history.hasMore);
    } catch (err) {
      setError(String(err));
    } finally {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
    }
  }

  async function refreshAll() {
    const [snapshot, scopedUsage] = await Promise.all([getDashboard(), getTokenUsage(scope)]);
    setApps(snapshot.apps);
    setSessions(snapshot.sessions);
    setEvents(snapshot.events);
    setConfirmations(snapshot.confirmations);
    setTokenUsage(scopedUsage.usage);
    setSeries(scopedUsage.series);
    const first = snapshot.sessions.find((session) => session.appId === selectedApp) ?? snapshot.sessions[0];
    if (first) {
      setSelectedApp(first.appId);
      setSelectedSessionId(first.id);
    }
  }

  async function reloadLists(appId = selectedApp) {
    const nextSessions = await getSessions();
    setSessions(nextSessions);
    if (!nextSessions.find((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(nextSessions.find((session) => session.appId === appId)?.id);
    }
  }

  const selectedSession = sessions.find((session) => session.id === selectedSessionId && session.appId === selectedApp) ?? sessions.find((session) => session.appId === selectedApp);
  const totalTokens = tokenUsage.reduce((sum, row) => sum + row.totalTokens, 0);
  const runningSessions = sessions.filter((session) => session.status === 'running').length;
  const completedSessions = sessions.filter((session) => session.status === 'completed').length;
  const liveSessions = sessions.filter((session) => session.live).length;
  const stoppedOrInterrupted = sessions.filter((session) => session.status === 'stopped' || session.status === 'interrupted').length;
  const topUsage = topTokenUsage(tokenUsage);
  const costSummary = estimateCost(apps, tokenUsage);
  const riskItems = buildRiskItems(apps, tokenUsage, confirmations);
  const appPageId = isAppId(activeNav) ? activeNav : selectedApp;
  const appPageSessions = sessions.filter((session) => session.appId === appPageId);
  const appPageUsage = tokenUsage.find((row) => row.appId === appPageId);
  const terminalFrames = useMemo(() => [...historicalFrames, ...liveTerminalFrames], [historicalFrames, liveTerminalFrames]);

  function handleNavigate(key: NavKey) {
    setActiveNav(key);
    syncHash(key);
    if (key === 'overview') {
      return;
    }
    if (key === 'sessions') {
      return;
    }
    if (key === 'confirmations') {
      const first = confirmations[0];
      if (first) {
        setSelectedApp(first.appId);
        setSelectedSessionId(first.sessionId);
      }
      return;
    }
    setSelectedApp(key);
    const firstSession = sessions.find((session) => session.appId === key);
    if (firstSession) setSelectedSessionId(firstSession.id);
  }

  function handleSwitchApp(appId: AppId) {
    setSelectedApp(appId);
    const current = sessions.find((session) => session.id === selectedSessionId && session.appId === appId);
    setSelectedSessionId((current ?? sessions.find((session) => session.appId === appId))?.id);
  }

  function handleOpenAppPage(appId: AppId) {
    handleSwitchApp(appId);
    setActiveNav(appId);
    syncHash(appId);
  }

  function handleRiskAction() {
    const firstConfirmation = confirmations[0];
    if (firstConfirmation) {
      handleNavigate('confirmations');
      return;
    }
    const firstUnavailable = apps.find((app) => app.status !== 'connected');
    if (firstUnavailable) {
      handleOpenAppPage(firstUnavailable.appId);
      return;
    }
    const firstHighUsage = tokenUsage.find((row) => row.totalTokens >= TOKEN_ALERT_THRESHOLD);
    if (firstHighUsage) {
      handleOpenAppPage(firstHighUsage.appId);
      return;
    }
    handleNavigate('overview');
  }

  function handleExportReport() {
    const exportedAt = new Date().toISOString();
    const report = {
      exportedAt,
      scope,
      selected: {
        appId: selectedApp,
        sessionId: selectedSession?.id
      },
      summary: {
        runningSessions,
        completedSessions,
        liveSessions,
        stoppedOrInterrupted,
        totalTokens,
        estimatedCost: costSummary.value
      },
      apps,
      sessions,
      tokenUsage,
      usageSeries: series,
      events,
      confirmations
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ai-coding-workbench-${scope}-${fileSafeTimestamp(exportedAt)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function handlePrompt() {
    if (!selectedSession) return;
    try {
      const result = await sendPrompt(selectedSession.id, { prompt });
      if (result.confirmation) setConfirmations((current) => mergeConfirmation(current, result.confirmation!));
      await reloadLists();
    } catch (err) {
      setError(String(err));
    }
  }

  async function createNewSessionForApp(appId: AppId) {
    setError(undefined);
    setSelectedApp(appId);
    setActiveNav(appId);
    syncHash(appId);
    const session = await startSession({ appId, title: `${appLabel(appId)} session` });
    await reloadLists(appId);
    setSelectedSessionId(session.id);
    setPrompt('');
  }

  async function handleNewSession() {
    try {
      await createNewSessionForApp(selectedApp);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleNewSessionForApp(appId: AppId) {
    try {
      await createNewSessionForApp(appId);
    } catch (err) {
      setError(String(err));
      throw err;
    }
  }

  async function handleContinue() {
    if (!selectedSession) return;
    try {
      await continueSession(selectedSession.id);
      await reloadLists();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleStop() {
    if (!selectedSession) return;
    try {
      await stopSession(selectedSession.id);
      await reloadLists();
    } catch (err) {
      setError(String(err));
    }
  }

  function handleDeleteSession() {
    if (!selectedSession) return;
    setDeleteError(undefined);
    setDeleteTarget(selectedSession);
  }

  async function handleConfirmDeleteSession() {
    if (!deleteTarget) return;
    const session = deleteTarget;
    setDeleteBusy(true);
    setDeleteError(undefined);
    try {
      const deleted = await deleteSession(session.id);
      const [nextSessions, scopedUsage] = await Promise.all([getSessions(), getTokenUsage(scope)]);
      setSessions(nextSessions);
      setTokenUsage(scopedUsage.usage);
      setSeries(scopedUsage.series);
      const deleteEvent: EventRecord = {
        id: `delete-${deleted.session.id}-${Date.now()}`,
        type: 'session.updated',
        appId: deleted.session.appId,
        sessionId: deleted.session.id,
        message: `${appLabel(deleted.session.appId)} ${sessionShort(deleted.session.id)} 原始日志已删除：${deleted.deletedFiles.length} 个文件${deleted.modifiedFiles.length ? `，修改 ${deleted.modifiedFiles.length} 个共享日志` : ''}`,
        createdAt: new Date().toISOString(),
        payload: deleted
      };
      setEvents((current) => [deleteEvent, ...current].slice(0, 40));
      setHistoricalFrames([]);
      setLiveTerminalFrames([]);
      setHistoryCursor(undefined);
      setHistoryHasMore(false);
      historyLoadingRef.current = false;
      setHistoryLoading(false);
      const next = nextSessions.find((item) => item.appId === session.appId) ?? nextSessions[0];
      if (next) {
        setSelectedApp(next.appId);
        setSelectedSessionId(next.id);
      } else {
        setSelectedSessionId(undefined);
      }
      setDeleteTarget(undefined);
    } catch (err) {
      setDeleteError(errorText(err));
    } finally {
      setDeleteBusy(false);
    }
  }

  async function handleResolve(id: string, approved: boolean) {
    try {
      await resolveConfirmation(id, approved);
      setConfirmations((current) => current.filter((item) => item.id !== id));
    } catch (err) {
      setError(String(err));
    }
  }

  const pageBody = (() => {
    if (activeNav === 'overview') {
      return (
        <>
          <section className="kpis">
            <Kpi title="执行中会话" value={runningSessions.toString()} tag="Live" note={`${liveSessions} 个 live 会话 · ${connectedCount(apps)} 个 CLI 已连接`} />
            <Kpi title="已完成会话" value={completedSessions.toString()} tag="Done" note={`${stoppedOrInterrupted} 个停止/中断会话`} />
            <Kpi title={`${scopeLabel(scope)} Token`} value={formatTokenCount(totalTokens)} tag="输入 + 输出" note={topUsage ? `${appLabel(topUsage.appId)} ${formatTokenCount(topUsage.totalTokens)} 当前最高用量` : '暂无 token 记录'} />
            <Kpi title="预估成本" value={costSummary.value} tag="本地配置" note={costSummary.note} />
          </section>
          <div className="overview-grid">
            <section className="left-flow">
              <TokenTrend usage={tokenUsage} series={series} scope={scope} />
              <EventStream events={events} />
            </section>
            <aside className="right-flow">
              <AppConnectors apps={apps} tokenUsage={tokenUsage} scope={scope} activeApp={selectedApp} onApp={handleOpenAppPage} />
              <TokenCounts usage={tokenUsage} scope={scope} />
              <BillingModes apps={apps} tokenUsage={tokenUsage} />
              <RiskPanel risks={riskItems} onAction={handleRiskAction} />
            </aside>
          </div>
        </>
      );
    }

    if (activeNav === 'sessions') {
      return (
        <ResizableWorkspace
          left={(
            <>
              <SessionSwitcher sessions={sessions} selectedApp={selectedApp} selectedSessionId={selectedSession?.id} onApp={handleSwitchApp} onSession={setSelectedSessionId} />
              <EventStream events={events} />
            </>
          )}
          right={(
            <ControlPanel
              selectedApp={selectedApp}
              session={selectedSession}
              tokenUsage={tokenUsage}
              scope={scope}
              prompt={prompt}
              setPrompt={setPrompt}
              onPrompt={handlePrompt}
              onNewSession={handleNewSession}
              onContinue={handleContinue}
              onStop={handleStop}
              onDelete={handleDeleteSession}
              confirmations={confirmations.filter((item) => item.sessionId === selectedSession?.id)}
              onResolve={handleResolve}
              terminalFrames={terminalFrames}
              historyHasMore={historyHasMore}
              historyLoading={historyLoading}
              onLoadMoreHistory={loadMoreHistory}
              apps={apps}
              onApp={handleOpenAppPage}
            />
          )}
        />
      );
    }

    if (activeNav === 'confirmations') {
      return (
        <div className="page-grid">
          <section className="left-flow">
            <ConfirmationQueue confirmations={confirmations} onSelect={(item) => { setSelectedApp(item.appId); setSelectedSessionId(item.sessionId); }} onResolve={handleResolve} />
            <RiskPanel risks={riskItems} onAction={handleRiskAction} />
          </section>
          <aside className="right-flow">
            <ControlPanel
              selectedApp={selectedApp}
              session={selectedSession}
              tokenUsage={tokenUsage}
              scope={scope}
              prompt={prompt}
              setPrompt={setPrompt}
              onPrompt={handlePrompt}
              onNewSession={handleNewSession}
              onContinue={handleContinue}
              onStop={handleStop}
              onDelete={handleDeleteSession}
              confirmations={confirmations.filter((item) => item.sessionId === selectedSession?.id)}
              onResolve={handleResolve}
              terminalFrames={terminalFrames}
              historyHasMore={historyHasMore}
              historyLoading={historyLoading}
              onLoadMoreHistory={loadMoreHistory}
              apps={apps}
              onApp={handleOpenAppPage}
            />
            <EventStream events={events} />
          </aside>
        </div>
      );
    }

    return (
      <div className="page-stack">
        <AppSummary
          appId={appPageId}
          app={apps.find((item) => item.appId === appPageId)}
          usage={appPageUsage}
          sessions={appPageSessions}
          scope={scope}
        />
        <ResizableWorkspace
          left={(
            <>
              <SessionSwitcher sessions={sessions} selectedApp={appPageId} selectedSessionId={selectedSession?.id} onApp={handleOpenAppPage} onSession={setSelectedSessionId} />
              <EventStream events={events} />
            </>
          )}
          right={(
            <ControlPanel
              selectedApp={selectedApp}
              session={selectedSession}
              tokenUsage={tokenUsage}
              scope={scope}
              prompt={prompt}
              setPrompt={setPrompt}
              onPrompt={handlePrompt}
              onNewSession={handleNewSession}
              onContinue={handleContinue}
              onStop={handleStop}
              onDelete={handleDeleteSession}
              confirmations={confirmations.filter((item) => item.sessionId === selectedSession?.id)}
              onResolve={handleResolve}
              terminalFrames={terminalFrames}
              historyHasMore={historyHasMore}
              historyLoading={historyLoading}
              onLoadMoreHistory={loadMoreHistory}
              apps={apps}
              onApp={handleOpenAppPage}
            />
          )}
        />
      </div>
    );
  })();

  return (
    <>
      <FocusConsole
        apps={apps}
        sessions={sessions}
        events={events}
        confirmations={confirmations}
        tokenUsage={tokenUsage}
        scope={scope}
        setScope={setScope}
        selectedApp={selectedApp}
        selectedSession={selectedSession}
        selectedSessionId={selectedSession?.id}
        prompt={prompt}
        setPrompt={setPrompt}
        terminalFrames={terminalFrames}
        historyHasMore={historyHasMore}
        historyLoading={historyLoading}
        onLoadMoreHistory={loadMoreHistory}
        onSelectSession={(session) => {
          setSelectedApp(session.appId);
          setSelectedSessionId(session.id);
          setActiveNav(session.appId);
          syncHash(session.appId);
        }}
        onSelectApp={(appId) => {
          handleSwitchApp(appId);
          setActiveNav(appId);
          syncHash(appId);
        }}
        onPrompt={handlePrompt}
        onNewSession={handleNewSession}
        onNewSessionForApp={handleNewSessionForApp}
        onContinue={handleContinue}
        onStop={handleStop}
        onDelete={handleDeleteSession}
        onResolve={handleResolve}
        onRefresh={refreshAll}
        onExport={handleExportReport}
        error={error}
      />
      {deleteTarget && (
        <DeleteSessionDialog
          session={deleteTarget}
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => {
            if (deleteBusy) return;
            setDeleteError(undefined);
            setDeleteTarget(undefined);
          }}
          onConfirm={handleConfirmDeleteSession}
        />
      )}
    </>
  );
}

type SessionFilter = 'all' | 'running' | 'history';

function FocusConsole(props: {
  apps: AppInfo[];
  sessions: Session[];
  events: EventRecord[];
  confirmations: Confirmation[];
  tokenUsage: TokenUsage[];
  scope: TimeScope;
  setScope(scope: TimeScope): void;
  selectedApp: AppId;
  selectedSession?: Session;
  selectedSessionId?: string;
  prompt: string;
  setPrompt(value: string): void;
  terminalFrames: TerminalFrame[];
  historyHasMore: boolean;
  historyLoading: boolean;
  onLoadMoreHistory(): void;
  onSelectSession(session: Session): void;
  onSelectApp(appId: AppId): void;
  onPrompt(): void;
  onNewSession(): void;
  onNewSessionForApp(appId: AppId): Promise<void>;
  onContinue(): void;
  onStop(): void;
  onDelete(): void;
  onResolve(id: string, approved: boolean): void;
  onRefresh(): void;
  onExport(): void;
  error?: string;
}) {
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [tokenModalOpen, setTokenModalOpen] = useState(false);
  const [layout, setLayout] = useState<FocusLayout>(() => readFocusLayout());
  const [theme, setTheme] = useState<ThemeMode>(() => readThemeMode());
  const shellRef = useRef<HTMLDivElement>(null);
  const selectedAppInfo = props.apps.find((app) => app.appId === props.selectedApp);
  const openTabs = focusTabs(props.sessions, props.selectedSession);
  const sessionConfirmations = props.confirmations.filter((item) => item.sessionId === props.selectedSession?.id);
  const selectedEvents = props.events.filter((event) => event.sessionId === props.selectedSession?.id || event.appId === props.selectedApp).slice(0, 6);
  const requestNewSession = () => setNewSessionOpen(true);
  const shellStyle = {
    '--focus-left-width': `${layout.left}px`,
    '--focus-right-width': `${layout.right}px`
  } as CSSProperties;

  useEffect(() => {
    applyThemeMode(theme);
  }, [theme]);

  function toggleTheme() {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      writeThemeMode(next);
      return next;
    });
  }

  function updateFocusLayout(side: FocusResizeSide, clientX: number) {
    const node = shellRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setLayout((current) => {
      const maxLeft = Math.min(FOCUS_MAX_LEFT_WIDTH, rect.width - current.right - FOCUS_MIN_CENTER_WIDTH - FOCUS_RESIZER_WIDTH * 2);
      const maxRight = Math.min(FOCUS_MAX_RIGHT_WIDTH, rect.width - current.left - FOCUS_MIN_CENTER_WIDTH - FOCUS_RESIZER_WIDTH * 2);
      const next =
        side === 'left'
          ? { ...current, left: clamp(clientX - rect.left, FOCUS_MIN_LEFT_WIDTH, Math.max(FOCUS_MIN_LEFT_WIDTH, maxLeft)) }
          : { ...current, right: clamp(rect.right - clientX, FOCUS_MIN_RIGHT_WIDTH, Math.max(FOCUS_MIN_RIGHT_WIDTH, maxRight)) };
      writeFocusLayout(next);
      return next;
    });
  }

  function handleFocusResizeStart(side: FocusResizeSide, event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    document.body.classList.add('resizing-focus');

    const onMouseMove = (moveEvent: MouseEvent) => updateFocusLayout(side, moveEvent.clientX);
    const onMouseUp = () => {
      document.body.classList.remove('resizing-focus');
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  function handleFocusResizeKey(side: FocusResizeSide, event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    setLayout((current) => {
      const delta = 8;
      const next =
        side === 'left'
          ? { ...current, left: clamp(current.left + direction * delta, FOCUS_MIN_LEFT_WIDTH, FOCUS_MAX_LEFT_WIDTH) }
          : { ...current, right: clamp(current.right - direction * delta, FOCUS_MIN_RIGHT_WIDTH, FOCUS_MAX_RIGHT_WIDTH) };
      writeFocusLayout(next);
      return next;
    });
  }

  return (
    <>
      <div className="focus-shell" data-testid="focus-console" ref={shellRef} style={shellStyle}>
        <FocusSidebar
          apps={props.apps}
          sessions={props.sessions}
          tokenUsage={props.tokenUsage}
          scope={props.scope}
          setScope={props.setScope}
          selectedApp={props.selectedApp}
          selectedSessionId={props.selectedSessionId}
          confirmations={props.confirmations}
          onSelectApp={props.onSelectApp}
          onSelectSession={props.onSelectSession}
          onRequestNewSession={requestNewSession}
          onOpenTokenUsage={() => setTokenModalOpen(true)}
          onRefresh={props.onRefresh}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
        <button
          type="button"
          className="focus-resizer left"
          data-testid="focus-resizer-left"
          aria-label="调整左侧会话列表宽度"
          aria-valuemin={FOCUS_MIN_LEFT_WIDTH}
          aria-valuemax={FOCUS_MAX_LEFT_WIDTH}
          aria-valuenow={Math.round(layout.left)}
          onMouseDown={(event) => handleFocusResizeStart('left', event)}
          onKeyDown={(event) => handleFocusResizeKey('left', event)}
        />
        <main className="focus-stage" data-testid="control-panel">
          <FocusTabs tabs={openTabs} selectedSessionId={props.selectedSessionId} onSelectSession={props.onSelectSession} onNewSession={requestNewSession} />
          {props.error && <div className="focus-error">{props.error}</div>}
          <FocusSessionHeader app={selectedAppInfo} session={props.selectedSession} confirmations={sessionConfirmations.length} />
          <section className="focus-terminal-panel">
            <TerminalConversation
              session={props.selectedSession}
              frames={props.terminalFrames}
              hasMoreHistory={props.historyHasMore}
              historyLoading={props.historyLoading}
              onLoadMoreHistory={props.onLoadMoreHistory}
            />
          </section>
          <FocusComposer
            session={props.selectedSession}
            prompt={props.prompt}
            setPrompt={props.setPrompt}
            onPrompt={props.onPrompt}
            onNewSession={requestNewSession}
            onContinue={props.onContinue}
            onStop={props.onStop}
            onDelete={props.onDelete}
          />
        </main>
        <button
          type="button"
          className="focus-resizer right"
          data-testid="focus-resizer-right"
          aria-label="调整右侧详情栏宽度"
          aria-valuemin={FOCUS_MIN_RIGHT_WIDTH}
          aria-valuemax={FOCUS_MAX_RIGHT_WIDTH}
          aria-valuenow={Math.round(layout.right)}
          onMouseDown={(event) => handleFocusResizeStart('right', event)}
          onKeyDown={(event) => handleFocusResizeKey('right', event)}
        />
        <FocusInspector
          app={selectedAppInfo}
          session={props.selectedSession}
          usage={props.tokenUsage.find((row) => row.appId === props.selectedApp)}
          confirmations={sessionConfirmations}
          events={selectedEvents}
          frames={props.terminalFrames}
          onResolve={props.onResolve}
          onExport={props.onExport}
        />
      </div>
      {newSessionOpen && (
        <NewSessionDialog
          apps={props.apps}
          selectedApp={props.selectedApp}
          onClose={() => setNewSessionOpen(false)}
          onCreate={props.onNewSessionForApp}
        />
      )}
      {tokenModalOpen && (
        <TokenUsageDialog
          usage={props.tokenUsage}
          scope={props.scope}
          setScope={props.setScope}
          onClose={() => setTokenModalOpen(false)}
        />
      )}
    </>
  );
}

function FocusSidebar(props: {
  apps: AppInfo[];
  sessions: Session[];
  tokenUsage: TokenUsage[];
  scope: TimeScope;
  setScope(scope: TimeScope): void;
  selectedApp: AppId;
  selectedSessionId?: string;
  confirmations: Confirmation[];
  onSelectApp(appId: AppId): void;
  onSelectSession(session: Session): void;
  onRequestNewSession(): void;
  onOpenTokenUsage(): void;
  onRefresh(): void;
  theme: ThemeMode;
  onToggleTheme(): void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [expandedApps, setExpandedApps] = useState<Set<AppId>>(() => new Set());
  const totalTokens = props.tokenUsage.reduce((sum, row) => sum + row.totalTokens, 0);
  const connected = connectedCount(props.apps);

  function toggleExpanded(appId: AppId) {
    setExpandedApps((current) => {
      const next = new Set(current);
      if (next.has(appId)) next.delete(appId);
      else next.add(appId);
      return next;
    });
  }

  return (
    <aside className="focus-sidebar">
      <header className="focus-brand">
        <div className="brand-mark">AM</div>
        <div>
          <strong>Focus Console</strong>
          <span>整合工作台</span>
        </div>
        <button type="button" className="icon-button small" onClick={props.onRequestNewSession} aria-label="新建会话">+</button>
      </header>
      <label className="focus-search">
        <span>⌕</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话..." />
        <kbd>⌘K</kbd>
      </label>
      <div className="focus-filter" role="group" aria-label="会话过滤">
        {(['all', 'running', 'history'] as SessionFilter[]).map((item) => (
          <button key={item} type="button" className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>
            {item === 'all' ? '全部' : item === 'running' ? '进行中' : '历史'}
          </button>
        ))}
      </div>
      <div className="focus-session-groups" data-testid="session-switcher">
        {appOrder.map((appId) => {
          const app = props.apps.find((item) => item.appId === appId);
          const appSessions = filteredSessions(props.sessions, appId, filter, query);
          const expanded = expandedApps.has(appId);
          const visible = expanded ? appSessions : appSessions.slice(0, 6);
          return (
            <section className="focus-session-group" key={appId}>
              <button type="button" className={`focus-app-row ${props.selectedApp === appId ? 'active' : ''}`} data-testid={`nav-${appId}`} onClick={() => props.onSelectApp(appId)}>
                <span><i className={`dot ${appId}`} />{appLabel(appId)}</span>
                <b>{app?.sessions ?? appSessions.length}</b>
              </button>
              <div className="focus-session-list">
                {visible.map((session) => (
                  <button
                    type="button"
                    key={session.id}
                    data-testid={`session-row-${session.id}`}
                    className={`focus-session-row ${session.appId} ${props.selectedSessionId === session.id ? 'active' : ''}`}
                    onClick={() => props.onSelectSession(session)}
                  >
                    <strong>{session.title}</strong>
                    <span><FocusStatusText session={session} /> {sessionShort(session.id)} · {formatTokenCount(session.totalTokens)}</span>
                  </button>
                ))}
                {!visible.length && <div className="focus-empty">暂无匹配会话</div>}
                {appSessions.length > visible.length && (
                  <button type="button" className="focus-more" onClick={() => toggleExpanded(appId)}>
                    显示其余 {appSessions.length - visible.length} 个 ↓
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <FocusTokenDock usage={props.tokenUsage} scope={props.scope} setScope={props.setScope} totalTokens={totalTokens} onOpen={props.onOpenTokenUsage} />
      <footer className="focus-sidebar-foot">
        <span><i className="status-dot" />{connected}/{appOrder.length} CLI · {props.sessions.length} 会话</span>
        <button type="button" onClick={props.onToggleTheme} aria-label={props.theme === 'dark' ? '切换亮色模式' : '切换暗色模式'} title={props.theme === 'dark' ? '切换亮色模式' : '切换暗色模式'}>
          {props.theme === 'dark' ? '☀' : '◐'}
        </button>
        <button type="button" onClick={props.onRefresh} aria-label="刷新">↻</button>
      </footer>
    </aside>
  );
}

function FocusTokenDock({ scope, setScope, totalTokens, onOpen }: { usage: TokenUsage[]; scope: TimeScope; setScope(scope: TimeScope): void; totalTokens: number; onOpen(): void }) {
  return (
    <section className="focus-token-dock" data-testid="token-count-card">
      <button type="button" className="focus-token-head" onClick={onOpen} aria-haspopup="dialog">
        <span>{scopeLabel(scope)} TOKEN · 全部 APP 展开 ›</span>
        <strong>{formatTokenCount(totalTokens)}</strong>
      </button>
      <div className="focus-token-bars" aria-hidden="true">
        {appOrder.map((appId) => <span key={appId} className={appId} />)}
      </div>
      <div className="focus-token-scopes">
        {(['day', 'week', 'month'] as TimeScope[]).map((item) => (
          <button key={item} type="button" className={scope === item ? 'active' : ''} onClick={() => setScope(item)}>
            {item === 'day' ? '今日' : item === 'week' ? '本周' : '本月'}
          </button>
        ))}
      </div>
    </section>
  );
}

function FocusTabs({ tabs, selectedSessionId, onSelectSession, onNewSession }: { tabs: Session[]; selectedSessionId?: string; onSelectSession(session: Session): void; onNewSession(): void }) {
  return (
    <nav className="focus-tabs" aria-label="打开的会话">
      {tabs.map((session) => (
        <button key={session.id} type="button" className={`${session.appId} ${selectedSessionId === session.id ? 'active' : ''}`} onClick={() => onSelectSession(session)}>
          <i className={`dot ${session.appId}`} />
          <span>{session.title}</span>
          <em>{sessionShort(session.id)}</em>
          <b>×</b>
        </button>
      ))}
      <button type="button" className="new-tab" onClick={onNewSession}>新会话</button>
    </nav>
  );
}

function FocusStatusText({ session }: { session: Session }) {
  const label = session.live ? 'live' : statusLabel(session.status);
  return <em className={`focus-status-text ${session.status} ${session.live ? 'live' : ''}`}>{label}</em>;
}

function FocusSessionHeader({ app, session, confirmations }: { app?: AppInfo; session?: Session; confirmations: number }) {
  const appId = session?.appId ?? app?.appId ?? 'codex';
  return (
    <header className="focus-session-header">
      <div className={`logo ${appId}`}>{appInitials(appId)}</div>
      <div>
        <h1>{session?.title ?? '未选择会话'}</h1>
        <p>{session ? `${appLabel(session.appId)} ${sessionShort(session.id)} · ${session.model ?? 'model pending'} · ${session.cwd ?? '未记录目录'}` : app?.message ?? '从左侧选择一个会话继续'}</p>
      </div>
      <span className={`focus-live ${session?.live ? 'on' : ''}`}>{session?.live ? '● Live' : statusLabel(session?.status)}</span>
      {confirmations > 0 && <span className="focus-confirmation-pill">{confirmations} 个确认</span>}
    </header>
  );
}

function FocusComposer(props: {
  session?: Session;
  prompt: string;
  setPrompt(value: string): void;
  onPrompt(): void;
  onNewSession(): void;
  onContinue(): void;
  onStop(): void;
  onDelete(): void;
}) {
  const quickActions = [
    ['继续当前任务', '继续当前任务，先简要说明当前状态和下一步，然后只执行必要操作。'],
    ['提交代码', '检查当前改动并运行必要验证；如果没有问题，创建一条清晰的 commit 提交当前代码。'],
    ['创建 MR', '基于当前分支创建 Merge Request，补充标题、改动说明、测试结果和风险点。'],
    ['合并 MR', '检查当前 Merge Request 状态、CI 和评审情况；满足条件后合并 MR。'],
    ['部署服务器', '确认当前分支和环境信息，检查必要配置，然后按项目约定部署到服务器。']
  ] as const;

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (props.session) props.onPrompt();
    }
  }

  return (
    <footer className="focus-composer">
      <div className="focus-quick-actions">
        {quickActions.map(([label, value]) => <button key={label} type="button" onClick={() => props.setPrompt(value)}>{label}</button>)}
      </div>
      <div className="focus-input-wrap">
        <textarea
          value={props.prompt}
          onChange={(event) => props.setPrompt(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="向当前会话发送指令...  ⌘↵ 发送"
        />
        <button type="button" className="focus-send" onClick={props.onPrompt} disabled={!props.session || !props.prompt.trim()}>发送</button>
      </div>
      <div className="focus-command-hints">
        <span><kbd>⌘↵</kbd> 发送</span>
        <span><kbd>⇧⌘R</kbd> 只读</span>
        <span><kbd>⌘K</kbd> 命令</span>
        <strong>写文件 / 执行命令前会二次确认</strong>
        <button type="button" onClick={props.onNewSession}>新会话</button>
        <button type="button" onClick={props.onContinue} disabled={!props.session}>继续</button>
        <button type="button" className="danger" onClick={props.onStop} disabled={!props.session}>停止</button>
        <button type="button" data-testid="delete-session" className="danger solid" onClick={props.onDelete} disabled={!props.session}>删除</button>
      </div>
    </footer>
  );
}

function FocusInspector(props: {
  app?: AppInfo;
  session?: Session;
  usage?: TokenUsage;
  confirmations: Confirmation[];
  events: EventRecord[];
  frames: TerminalFrame[];
  onResolve(id: string, approved: boolean): void;
  onExport(): void;
}) {
  const session = props.session;
  const app = props.app;
  const files = changedFilesFromFrames(props.frames);
  return (
    <aside className="focus-inspector">
      <section>
        <h2>会话信息</h2>
        <InfoRow label="App" value={session ? appLabel(session.appId) : app?.label ?? '-'} />
        <InfoRow label="模型" value={session?.model ?? 'model pending'} />
        <InfoRow label="计费" value={app ? billingModeTitle(app.billingMode) : '-'} />
        <InfoRow label="状态" value={statusLabel(session?.status)} />
        <InfoRow label="耗时" value={session ? formatDuration(sessionDurationMs(session)) : '-'} />
        <InfoRow label="Token" value={session ? formatTokenCount(session.totalTokens) : formatTokenCount(props.usage?.totalTokens ?? 0)} />
      </section>
      <section>
        <h2>连接状态</h2>
        <InfoRow label="命令" value={app?.command ?? app?.message ?? '-'} />
        <InfoRow label="输入" value={formatTokenCount(session?.inputTokens ?? props.usage?.inputTokens ?? 0)} />
        <InfoRow label="输出" value={formatTokenCount(session?.outputTokens ?? props.usage?.outputTokens ?? 0)} />
      </section>
      <section>
        <h2>改动文件 · {files.length}</h2>
        <div className="focus-file-list">
          {files.slice(0, 6).map((file) => <span key={file}>{file}</span>)}
          {!files.length && <em>最近历史中没有文件改动记录</em>}
        </div>
      </section>
      {!!props.confirmations.length && (
        <section>
          <h2>确认队列</h2>
          <div className="focus-confirmations">
            {props.confirmations.map((item) => (
              <div key={item.id}>
                <strong>{item.reason}</strong>
                <span><button type="button" onClick={() => props.onResolve(item.id, true)}>确认</button><button type="button" onClick={() => props.onResolve(item.id, false)}>拒绝</button></span>
              </div>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <div className="focus-info-row"><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function focusTabs(sessions: Session[], selected?: Session): Session[] {
  const picked = new Map<string, Session>();
  if (selected) picked.set(selected.id, selected);
  for (const session of sessions.filter((item) => item.live || item.status === 'running')) {
    if (picked.size >= 3) break;
    picked.set(session.id, session);
  }
  for (const appId of appOrder) {
    const session = sessions.find((item) => item.appId === appId);
    if (session && picked.size < 4) picked.set(session.id, session);
  }
  return Array.from(picked.values()).slice(0, 4);
}

function filteredSessions(sessions: Session[], appId: AppId, filter: SessionFilter, query: string): Session[] {
  const normalizedQuery = query.trim().toLowerCase();
  return sessions
    .filter((session) => session.appId === appId)
    .filter((session) => {
      if (filter === 'running') return session.live || session.status === 'running';
      if (filter === 'history') return session.status !== 'running' && !session.live;
      return true;
    })
    .filter((session) => {
      if (!normalizedQuery) return true;
      return [session.title, session.cwd, session.model, session.id].some((value) => value?.toLowerCase().includes(normalizedQuery));
    });
}

function statusLabel(status?: string): string {
  if (!status) return '-';
  if (status === 'running') return '进行中';
  if (status === 'completed') return '完成';
  if (status === 'stopped') return '停止';
  if (status === 'pending') return '队列';
  return '中断';
}

function changedFilesFromFrames(frames: TerminalFrame[]): string[] {
  const text = frames.map((frame) => frame.text).join('\n');
  const matches = text.match(/(?:^|[\s"'`])((?:src|tests|test|app|server|client|packages|ui_kits)\/[^\s"'`:,;)\]]+)/g) ?? [];
  const files = matches
    .map((match) => match.trim().replace(/^["'`]/, ''))
    .map((path) => path.replace(/[.,;:)\]]+$/, ''))
    .filter((path) => path.includes('/'));
  return Array.from(new Set(files)).slice(0, 12);
}

function Sidebar({
  activeNav,
  apps,
  sessions,
  confirmations,
  onNavigate
}: {
  activeNav: NavKey;
  apps: AppInfo[];
  sessions: Session[];
  confirmations: Confirmation[];
  onNavigate(key: NavKey): void;
}) {
  const connected = connectedCount(apps);
  const missing = apps.filter((app) => app.status !== 'connected').length;
  return (
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">AM</div><div><strong>Agent Monitor</strong><span>AI Coding App 工作台</span></div></div>
      <nav>
        <SmallNav active={activeNav === 'overview'} label="总览" count={sessions.length.toString()} icon="▦" testId="nav-overview" onClick={() => onNavigate('overview')} />
        <SmallNav active={activeNav === 'sessions'} label="会话切换" count={sessions.length.toString()} icon="⌁" testId="nav-sessions" onClick={() => onNavigate('sessions')} />
        <SmallNav active={activeNav === 'confirmations'} label="确认队列" count={confirmations.length.toString()} icon="!" testId="nav-confirmations" onClick={() => onNavigate('confirmations')} />
      </nav>
      <nav>
        <div className="nav-title">APP 来源</div>
        {appOrder.map((appId) => {
          const app = apps.find((item) => item.appId === appId);
          return <SmallNav key={appId} active={activeNav === appId} label={appLabel(appId)} count={(app?.sessions ?? 0).toString()} iconClass={appId} testId={`nav-${appId}`} onClick={() => onNavigate(appId)} />;
        })}
      </nav>
      <div className="mini-status">
        <div><span className="status-dot" />CLI 连接<strong>{connected} / {apps.length}</strong></div>
        <div><span className="status-dot" />本机日志<strong>{sessions.length} 会话</strong></div>
        <div><span className={`status-dot ${missing || confirmations.length ? 'warn' : ''}`} />待处理<strong>{missing + confirmations.length}</strong></div>
      </div>
    </aside>
  );
}

function SmallNav(props: { label: string; count: string; icon?: string; active?: boolean; iconClass?: AppId; testId: string; onClick(): void }) {
  return <button type="button" data-testid={props.testId} className={`nav-item ${props.active ? 'active' : ''}`} onClick={props.onClick}><span className="nav-main">{props.iconClass ? <i className={`dot ${props.iconClass}`} /> : <i>{props.icon}</i>}<span className="nav-text">{props.label}</span></span><b>{props.count}</b></button>;
}

function Kpi(props: { title: string; value: string; tag: string; note: string }) {
  return <div className="card kpi"><div className="kpi-label"><span>{props.title}</span><em>{props.tag}</em></div><strong>{props.value}</strong><p>{props.note}</p></div>;
}

function ResizableWorkspace({ left, right }: { left: ReactNode; right: ReactNode }) {
  const [leftPercent, setLeftPercent] = useState(() => readWorkspaceSplit());
  const gridRef = useRef<HTMLDivElement>(null);
  const style = {
    '--workspace-left-size': `${leftPercent}fr`,
    '--workspace-right-size': `${100 - leftPercent}fr`
  } as CSSProperties;

  function updateFromClientX(clientX: number) {
    const node = gridRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const next = clamp(((clientX - rect.left) / rect.width) * 100, 28, 64);
    setLeftPercent(next);
    writeWorkspaceSplit(next);
  }

  function handleResizeStart(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    document.body.classList.add('resizing-workspace');

    const onMouseMove = (moveEvent: MouseEvent) => updateFromClientX(moveEvent.clientX);
    const onMouseUp = () => {
      document.body.classList.remove('resizing-workspace');
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  function handleResizeKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 3 : -3;
    setLeftPercent((current) => {
      const next = clamp(current + delta, 28, 64);
      writeWorkspaceSplit(next);
      return next;
    });
  }

  return (
    <div className="page-grid resizable-page-grid" data-testid="workspace-split" ref={gridRef} style={style}>
      <section className="left-flow">{left}</section>
      <button
        type="button"
        className="workspace-resizer"
        data-testid="workspace-resizer"
        aria-label="调整会话列表和统一交互控制台宽度"
        aria-valuemin={28}
        aria-valuemax={64}
        aria-valuenow={Math.round(leftPercent)}
        onMouseDown={handleResizeStart}
        onKeyDown={handleResizeKey}
      />
      <aside className="right-flow">{right}</aside>
    </div>
  );
}

function readWorkspaceSplit(): number {
  if (typeof window === 'undefined') return DEFAULT_WORKSPACE_LEFT_PERCENT;
  try {
    const value = Number(window.localStorage.getItem(WORKSPACE_SPLIT_STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? clamp(value, 28, 64) : DEFAULT_WORKSPACE_LEFT_PERCENT;
  } catch {
    return DEFAULT_WORKSPACE_LEFT_PERCENT;
  }
}

function writeWorkspaceSplit(leftPercent: number) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WORKSPACE_SPLIT_STORAGE_KEY, String(leftPercent));
  } catch {
    // Ignore storage failures; resizing should still work for the current render.
  }
}

function readFocusLayout(): FocusLayout {
  if (typeof window === 'undefined') return { left: DEFAULT_FOCUS_LEFT_WIDTH, right: DEFAULT_FOCUS_RIGHT_WIDTH };
  try {
    const raw = window.localStorage.getItem(FOCUS_LAYOUT_STORAGE_KEY);
    if (!raw) return { left: DEFAULT_FOCUS_LEFT_WIDTH, right: DEFAULT_FOCUS_RIGHT_WIDTH };
    const value = JSON.parse(raw) as Partial<FocusLayout>;
    return {
      left: clamp(Number(value.left), FOCUS_MIN_LEFT_WIDTH, FOCUS_MAX_LEFT_WIDTH) || DEFAULT_FOCUS_LEFT_WIDTH,
      right: clamp(Number(value.right), FOCUS_MIN_RIGHT_WIDTH, FOCUS_MAX_RIGHT_WIDTH) || DEFAULT_FOCUS_RIGHT_WIDTH
    };
  } catch {
    return { left: DEFAULT_FOCUS_LEFT_WIDTH, right: DEFAULT_FOCUS_RIGHT_WIDTH };
  }
}

function writeFocusLayout(layout: FocusLayout): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(FOCUS_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Layout persistence is optional; dragging should keep working in memory.
  }
}

function readThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'dark' || value === 'light' ? value : 'light';
  } catch {
    return 'light';
  }
}

function writeThemeMode(theme: ThemeMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme persistence is optional; the in-memory toggle still applies.
  }
}

function applyThemeMode(theme: ThemeMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function TokenTrend({ usage, series, scope }: { usage: TokenUsage[]; series: UsagePoint[]; scope: TimeScope }) {
  const max = Math.max(1, ...series.flatMap((point) => appOrder.map((appId) => point[appId] ?? 0)));
  const paths = useMemo(() => appOrder.map((appId) => makePath(series.map((point) => point[appId]), max)), [series, max]);
  return (
    <section className="card panel">
      <PanelHead title="Token 用量趋势" note="按 App、模型、输入/输出拆分" extra={<Legend />} />
      <div className="chart-meta">
        {appOrder.map((appId) => {
          const row = usage.find((item) => item.appId === appId);
          return <div className="metric-strip" key={appId}><strong>{formatTokenCount(row?.totalTokens ?? 0)}</strong><span>{appLabel(appId)} · {scopeLabel(scope)}</span></div>;
        })}
      </div>
      <svg className="chart" viewBox="0 0 760 190" role="img" aria-label="Token 用量趋势图">
        <g stroke="#e8edf2">{[32, 70, 108, 146].map((y) => <line key={y} x1="24" x2="736" y1={y} y2={y} />)}</g>
        {paths.map((path, index) => <path key={appOrder[index]} d={path} className={`line ${appOrder[index]}`} />)}
        <g fill="#7a8495" fontSize="12" fontWeight="650">
          {series.map((point, index) => <text key={point.label} x={24 + index * (712 / Math.max(1, series.length - 1))} y="184">{point.label}</text>)}
        </g>
      </svg>
    </section>
  );
}

function EventStream({ events }: { events: EventRecord[] }) {
  return (
    <section className="card panel">
      <PanelHead title="实时事件流" note="会话启动、指令发送、工具调用、token 峰值、完成事件" />
      <div className="timeline">
        {events.slice(0, 5).map((event) => (
          <div className="event" key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><strong>{event.message}</strong><span>{event.tokenDelta ? `${event.tokenDelta > 0 ? '+' : ''}${formatTokenCount(event.tokenDelta)} token` : ''}</span></div>
        ))}
      </div>
    </section>
  );
}

function SessionSwitcher(props: { sessions: Session[]; selectedApp: AppId; selectedSessionId?: string; onApp(appId: AppId): void; onSession(id: string): void }) {
  const [page, setPage] = useState(0);
  const appSessions = useMemo(() => props.sessions.filter((session) => session.appId === props.selectedApp), [props.sessions, props.selectedApp]);
  const totalPages = Math.max(1, Math.ceil(appSessions.length / SESSION_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageStart = currentPage * SESSION_PAGE_SIZE;
  const visible = appSessions.slice(pageStart, pageStart + SESSION_PAGE_SIZE);
  const firstVisible = appSessions.length ? pageStart + 1 : 0;
  const lastVisible = Math.min(appSessions.length, pageStart + visible.length);

  useEffect(() => {
    setPage(0);
  }, [props.selectedApp]);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages - 1));
  }, [totalPages]);

  useEffect(() => {
    if (!props.selectedSessionId) return;
    const selectedIndex = appSessions.findIndex((session) => session.id === props.selectedSessionId);
    if (selectedIndex === -1) return;
    const selectedPage = Math.floor(selectedIndex / SESSION_PAGE_SIZE);
    setPage((current) => (current === selectedPage ? current : selectedPage));
  }, [appSessions, props.selectedSessionId]);

  return (
    <section className="card panel" data-testid="session-switcher">
      <PanelHead
        title="会话切换器"
        note={`先选 App，再切换该 App 下的历史或当前会话 · ${firstVisible}-${lastVisible} / ${appSessions.length}`}
        extra={<span className="pill">{props.sessions.length} 会话</span>}
      />
      <div className="session-tabs">{appOrder.map((appId) => <button type="button" data-testid={`session-app-${appId}`} key={appId} className={props.selectedApp === appId ? 'active' : ''} onClick={() => props.onApp(appId)}><i className={`dot ${appId}`} /><strong>{appLabel(appId)}</strong><span>{props.sessions.filter((session) => session.appId === appId).length} 个会话</span></button>)}</div>
      <div className="session-list">
        {visible.length === 0 && <div className="empty-state">当前 App 还没有可切换会话。</div>}
        {visible.map((session) => (
          <button
            type="button"
            key={session.id}
            data-testid={`session-row-${session.id}`}
            className={props.selectedSessionId === session.id ? 'active' : ''}
            onClick={() => props.onSession(session.id)}
          >
            <div>
              <strong><i className={`dot ${session.appId}`} />{session.title}</strong>
              <span>{session.cwd ?? '-'}</span>
              <div className="session-meta">
                <Status status={session.status} />
                <small>耗时 {formatDuration(sessionDurationMs(session))}</small>
              </div>
            </div>
            <b>{formatTokenCount(session.totalTokens)}<small>tokens</small></b>
          </button>
        ))}
      </div>
      {totalPages > 1 && (
        <div className="session-pagination">
          <button type="button" onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={currentPage === 0}>上一页</button>
          <span>第 {currentPage + 1} / {totalPages} 页 · 20 条/页</span>
          <button type="button" onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))} disabled={currentPage >= totalPages - 1}>下一页</button>
        </div>
      )}
    </section>
  );
}

function ControlPanel(props: {
  selectedApp: AppId;
  session?: Session;
  tokenUsage: TokenUsage[];
  scope: TimeScope;
  prompt: string;
  setPrompt(value: string): void;
  onPrompt(): void;
  onNewSession(): void;
  onContinue(): void;
  onStop(): void;
  onDelete(): void;
  confirmations: Confirmation[];
  onResolve(id: string, approved: boolean): void;
  terminalFrames: TerminalFrame[];
  historyHasMore: boolean;
  historyLoading: boolean;
  onLoadMoreHistory(): void;
  apps: AppInfo[];
  onApp(appId: AppId): void;
}) {
  return (
    <section className="card panel control-panel" data-testid="control-panel">
      <PanelHead title="统一交互控制台" note="向当前 App 会话发送指令" extra={<span className="pill ok">可用</span>} />
      <div className="app-options">{appOrder.map((appId) => {
        const app = props.apps.find((item) => item.appId === appId);
        const detail = appId === props.session?.appId
          ? `${sessionShort(props.session.id)} · ${props.session.model ?? 'model pending'}`
          : app?.command ?? app?.message ?? '未发现命令';
        return <button type="button" key={appId} data-testid={`control-app-${appId}`} className={props.selectedApp === appId ? 'active' : ''} onClick={() => props.onApp(appId)}><i className={`dot ${appId}`} /><strong>{appLabel(appId)}</strong><span>{detail}</span></button>;
      })}</div>
      <div className="context-row">
        <div>
          <span>当前会话上下文</span>
          <strong>{props.session ? `${appLabel(props.session.appId)} ${sessionShort(props.session.id)} · ${props.session.cwd ?? props.session.title}` : '未选择会话'}</strong>
          {props.session && <small><Status status={props.session.status} />耗时 {formatDuration(sessionDurationMs(props.session))}</small>}
        </div>
      </div>
      <TokenCounts usage={props.tokenUsage} scope={props.scope} variant="inline" />
      <div className="permission-strip">! 涉及写文件、执行命令、访问网络或发送外部消息时，在控制台内显示二次确认。</div>
      {props.confirmations.map((item) => <div className="confirmation" key={item.id}><strong>需要确认：{item.reason}</strong><button onClick={() => props.onResolve(item.id, true)}>确认</button><button onClick={() => props.onResolve(item.id, false)}>拒绝</button></div>)}
      <TerminalConversation
        session={props.session}
        frames={props.terminalFrames}
        hasMoreHistory={props.historyHasMore}
        historyLoading={props.historyLoading}
        onLoadMoreHistory={props.onLoadMoreHistory}
      />
      <div className="prompt-composer">
        <label className="prompt-box"><span>Prompt · {props.session ? `${appLabel(props.session.appId)} ${sessionShort(props.session.id)}` : '未选择'}</span><textarea placeholder="解释当前任务的失败原因，并给出最小修复方案..." value={props.prompt} onChange={(event) => props.setPrompt(event.target.value)} /></label>
        <div className="template-row"><button onClick={() => props.setPrompt('解释当前任务状态，并列出下一步计划。')}>解释当前任务</button><button onClick={() => props.setPrompt('为当前改动补充必要测试。')}>补测试</button><button onClick={() => props.setPrompt('生成 PR 摘要，包含改动、测试和风险。')}>生成 PR 摘要</button><button onClick={() => props.setPrompt('切到只读模式，只分析不修改文件。')}>切到只读模式</button></div>
        <div className="control-actions"><button className="send" onClick={props.onPrompt} disabled={!props.session}>发送指令</button><button onClick={props.onNewSession}>新会话</button><button onClick={props.onContinue} disabled={!props.session}>继续</button><button className="danger" onClick={props.onStop} disabled={!props.session}>停止</button><button data-testid="delete-session" className="danger solid" onClick={props.onDelete} disabled={!props.session}>删除</button></div>
      </div>
    </section>
  );
}

type ConversationRole = 'user' | 'assistant' | 'tool' | 'system' | 'error' | 'output';

interface ConversationTurn {
  id: string;
  appId: AppId;
  role: ConversationRole;
  text: string;
  createdAt: string;
  live: boolean;
  cwd?: string;
}

function TerminalConversation(props: {
  session?: Session;
  frames: TerminalFrame[];
  hasMoreHistory: boolean;
  historyLoading: boolean;
  onLoadMoreHistory(): void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollSnapshotRef = useRef({ firstKey: '', frameCount: 0, scrollHeight: 0 });
  const [expandedToolTurns, setExpandedToolTurns] = useState<Set<string>>(() => new Set());
  const [expandedConversationTurns, setExpandedConversationTurns] = useState<Set<string>>(() => new Set());
  const appId = props.session?.appId ?? props.frames[0]?.appId ?? 'codex';
  const turns = useMemo(() => framesToConversationTurns(props.frames, appId, props.session?.cwd), [appId, props.frames, props.session?.cwd]);
  const hasUserTurn = turns.some((turn) => turn.role === 'user');
  const displayTurns = hasUserTurn || !turns.length ? turns : [syntheticUserContextTurn(props.session, appId), ...turns];
  const firstFrameKey = props.frames[0] ? frameKey(props.frames[0]) : '';

  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    const previous = scrollSnapshotRef.current;
    const prependedHistory = previous.frameCount > 0 && props.frames.length > previous.frameCount && firstFrameKey !== previous.firstKey;

    if (prependedHistory) {
      node.scrollTop += node.scrollHeight - previous.scrollHeight;
    } else if (!previous.frameCount || props.frames.length !== previous.frameCount) {
      node.scrollTop = node.scrollHeight;
    }

    scrollSnapshotRef.current = {
      firstKey: firstFrameKey,
      frameCount: props.frames.length,
      scrollHeight: node.scrollHeight
    };
  }, [displayTurns.length, firstFrameKey, props.frames.length]);

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!props.hasMoreHistory || props.historyLoading) return;
    const target = event.currentTarget;
    const nearTop = target.scrollTop < 36;
    if (nearTop && event.deltaY < 0) props.onLoadMoreHistory();
  }

  function toggleToolTurn(id: string) {
    setExpandedToolTurns((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleConversationTurn(id: string) {
    setExpandedConversationTurns((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className={`terminal ${appId}`} data-testid="terminal-conversation">
      <div className="terminal-title">
        <span>{props.session ? `${props.session.appId} ${sessionShort(props.session.id)}` : 'session'} · tui conversation</span>
        <span>{props.session ? `${formatDuration(sessionDurationMs(props.session))} · ${formatTokenCount(props.session.totalTokens)} token` : ''}</span>
      </div>
      <div className="terminal-body" ref={bodyRef} onWheel={handleWheel}>
        {props.hasMoreHistory && (
          <button className="history-more" type="button" onClick={props.onLoadMoreHistory} disabled={props.historyLoading}>
            {props.historyLoading ? '加载中...' : '加载更早历史（上一屏）'}
          </button>
        )}
        {props.historyLoading && !turns.length && <div className="terminal-empty">加载最近一屏历史...</div>}
        {!props.historyLoading && !turns.length && <div className="terminal-empty">等待当前会话输出...</div>}
        {displayTurns.map((turn) => (
          <article className={`tui-turn ${turn.role} ${turn.live ? 'live' : ''}`} key={turn.id}>
            <div className="tui-marker">{roleMarker(turn.appId, turn.role)}</div>
            <div className="tui-bubble">
              <div className="tui-meta">
                <strong>{roleLabel(turn.appId, turn.role)}</strong>
                <time>{new Date(turn.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
                {turn.live && <span>live</span>}
              </div>
              {turn.role === 'tool' ? (
                <ToolTurn turn={turn} expanded={expandedToolTurns.has(turn.id)} onToggle={() => toggleToolTurn(turn.id)} />
              ) : turn.role === 'user' || turn.role === 'assistant' ? (
                <ConversationMessageTurn turn={turn} expanded={expandedConversationTurns.has(turn.id)} onToggle={() => toggleConversationTurn(turn.id)} />
              ) : (
                <pre>{turn.text}</pre>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function ToolTurn(props: { turn: ConversationTurn; expanded: boolean; onToggle(): void }) {
  const [showRaw, setShowRaw] = useState(false);
  const presentation = toolPresentation(props.turn.text);
  return (
    <div className="tool-turn">
      <button type="button" className="tool-summary" onClick={props.onToggle} aria-expanded={props.expanded}>
        <span>{props.expanded ? '▾' : '▸'}</span>
        <strong>{presentation.summary}</strong>
        <em>{props.expanded ? '收起详情' : '展开详情'}</em>
      </button>
      {props.expanded && (
        <div className="tool-detail">
          <pre>{showRaw ? presentation.rawText : presentation.cleanText}</pre>
          {presentation.hasFilteredNoise && (
            <button type="button" className="tool-raw-toggle" onClick={() => setShowRaw((value) => !value)}>
              {showRaw ? '查看清洗输出' : '显示原始输出'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ConversationMessageTurn(props: { turn: ConversationTurn; expanded: boolean; onToggle(): void }) {
  const presentation = conversationPresentation(props.turn);
  const showToggle = props.expanded || presentation.hasHiddenContext || presentation.long;
  const visibleText = props.expanded ? presentation.fullText : presentation.previewText;
  const structured = props.turn.role === 'assistant';
  return (
    <div className={`message-turn ${props.turn.role}`}>
      {presentation.badge && <div className="message-badge">{presentation.badge}</div>}
      <div className={`message-text ${structured ? 'agent-reply-body markdown-body' : ''}`}>
        {structured ? <AgentReplyContent text={visibleText} appId={props.turn.appId} cwd={props.turn.cwd} /> : <PlainMessageText text={visibleText} turnId={props.turn.id} cwd={props.turn.cwd} />}
      </div>
      {showToggle && (
        <button type="button" className="message-toggle" onClick={props.onToggle} aria-expanded={props.expanded}>
          {props.expanded ? '收起' : presentation.hasHiddenContext ? '展开浏览器上下文和原文' : '展开完整回复'}
        </button>
      )}
    </div>
  );
}

function AgentReplyContent({ text, appId, cwd }: { text: string; appId: AppId; cwd?: string }) {
  const segments = parseAgentReplySegments(text);
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === 'tag') return <AgentFormatCard key={index} tag={segment.tag} text={segment.text} appId={appId} cwd={cwd} />;
        return <MarkdownContent key={index} text={segment.text} cwd={cwd} />;
      })}
    </>
  );
}

type AgentReplySegment = { type: 'markdown'; text: string } | { type: 'tag'; tag: AgentReplyTag; text: string };

type AgentReplyTag =
  | 'summary'
  | 'task-notification'
  | 'command-message'
  | 'local-command-caveat'
  | 'system-reminder'
  | 'tool_use_error';

const agentReplyTags: AgentReplyTag[] = ['summary', 'task-notification', 'command-message', 'local-command-caveat', 'system-reminder', 'tool_use_error'];

function parseAgentReplySegments(text: string): AgentReplySegment[] {
  const pattern = new RegExp(`<(${agentReplyTags.join('|')})>([\\s\\S]*?)<\\/\\1>`, 'gi');
  const segments: AgentReplySegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    const before = text.slice(lastIndex, match.index).trim();
    if (before) segments.push({ type: 'markdown', text: before });
    segments.push({ type: 'tag', tag: match[1].toLowerCase() as AgentReplyTag, text: match[2].trim() });
    lastIndex = pattern.lastIndex;
  }

  const rest = text.slice(lastIndex).trim();
  if (rest) segments.push({ type: 'markdown', text: rest });
  return segments.length ? segments : [{ type: 'markdown', text }];
}

function AgentFormatCard({ tag, text, appId, cwd }: { tag: AgentReplyTag; text: string; appId: AppId; cwd?: string }) {
  const meta = agentFormatMeta(tag);
  return (
    <section className={`agent-format-card ${meta.tone} ${appId}`} data-testid={`agent-format-${tag}`}>
      <header>
        <span>{meta.icon}</span>
        <strong>{meta.label}</strong>
        <code>{`<${tag}>`}</code>
      </header>
      <div className="agent-format-body">
        <MarkdownContent text={text || meta.emptyText} cwd={cwd} />
      </div>
    </section>
  );
}

function agentFormatMeta(tag: AgentReplyTag): { label: string; icon: string; tone: string; emptyText: string } {
  if (tag === 'summary') return { label: '执行摘要', icon: 'Σ', tone: 'summary', emptyText: '暂无摘要内容。' };
  if (tag === 'task-notification') return { label: '任务通知', icon: '!', tone: 'notice', emptyText: '任务状态已更新。' };
  if (tag === 'command-message') return { label: '命令消息', icon: '$', tone: 'command', emptyText: '命令消息为空。' };
  if (tag === 'local-command-caveat') return { label: '本地命令提示', icon: '!', tone: 'warning', emptyText: '本地命令存在注意事项。' };
  if (tag === 'tool_use_error') return { label: '工具错误', icon: '×', tone: 'error', emptyText: '工具调用失败。' };
  return { label: '系统提醒', icon: '#', tone: 'system', emptyText: '系统提醒为空。' };
}

function PlainMessageText({ text, turnId, cwd }: { text: string; turnId: string; cwd?: string }) {
  return (
    <>
      {text.split('\n').map((line, index) => {
        const key = `${turnId}-${index}`;
        if (!line.trim()) return <span className="message-break" key={key} />;
        const images = extractLooseImageRefs(line, cwd);
        return (
          <div className="plain-message-line" key={key}>
            <p>{line}</p>
            <ImagePreviewList images={images} />
          </div>
        );
      })}
    </>
  );
}

function MarkdownContent({ text, cwd }: { text: string; cwd?: string }) {
  return <>{parseMarkdownBlocks(text).map((block, index) => renderMarkdownBlock(block, index, cwd))}</>;
}

type MarkdownBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'checklist'; items: Array<{ checked: boolean; text: string }> }
  | { type: 'quote'; text: string }
  | { type: 'code'; lang?: string; text: string }
  | { type: 'hr' }
  | { type: 'table'; headers: string[]; rows: string[][] };

function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = /^```([\w.+-]*)\s*$/.exec(trimmed);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index].trim())) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', lang: fence[1] || undefined, text: code.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (/^(?:---|\*\*\*|___)$/.test(trimmed)) {
      blocks.push({ type: 'hr' });
      index += 1;
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const headers = splitMarkdownTableRow(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        rows.push(splitMarkdownTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) {
      const items: Array<{ checked: boolean; text: string }> = [];
      while (index < lines.length && /^\s*[-*+]\s+\[[ xX]\]\s+/.test(lines[index])) {
        const item = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(lines[index]);
        if (item) items.push({ checked: item[1].toLowerCase() === 'x', text: item[2].trim() });
        index += 1;
      }
      blocks.push({ type: 'checklist', items });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, '').trim());
        index += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, '').trim());
        index += 1;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', text: quote.join('\n').trim() });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && shouldContinueMarkdownParagraph(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
  }

  return blocks;
}

function shouldContinueMarkdownParagraph(lines: string[], index: number): boolean {
  const line = lines[index];
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^```/.test(trimmed) || /^(#{1,6})\s+/.test(trimmed) || /^(?:---|\*\*\*|___)$/.test(trimmed)) return false;
  if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) return false;
  if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line) || /^\s*>\s?/.test(line)) return false;
  if (isMarkdownTableStart(lines, index)) return false;
  return true;
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  const header = lines[index]?.trim();
  const separator = lines[index + 1]?.trim();
  return Boolean(header?.startsWith('|') && header.endsWith('|') && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(separator ?? ''));
}

function splitMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function renderMarkdownBlock(block: MarkdownBlock, index: number, cwd?: string): ReactNode {
  if (block.type === 'paragraph') {
    const images = extractLooseImageRefs(block.text, cwd);
    return (
      <div className="markdown-paragraph" key={index}>
        <p>{renderInlineMarkdown(block.text, `${index}`, cwd)}</p>
        <ImagePreviewList images={images} />
      </div>
    );
  }
  if (block.type === 'heading') {
    return renderMarkdownHeading(block.level, block.text, index, cwd);
  }
  if (block.type === 'ul') {
    return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item, `${index}-${itemIndex}`, cwd)}</li>)}</ul>;
  }
  if (block.type === 'ol') {
    return <ol key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item, `${index}-${itemIndex}`, cwd)}</li>)}</ol>;
  }
  if (block.type === 'checklist') {
    return (
      <ul className="markdown-checklist" key={index}>
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex}>
            <input type="checkbox" checked={item.checked} readOnly aria-label={item.checked ? '已完成' : '未完成'} />
            <span>{renderInlineMarkdown(item.text, `${index}-${itemIndex}`, cwd)}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (block.type === 'quote') {
    return renderMarkdownQuote(block.text, index, cwd);
  }
  if (block.type === 'code') {
    return <CodeBlock key={index} lang={block.lang} text={block.text} />;
  }
  if (block.type === 'hr') {
    return <hr key={index} />;
  }
  return (
    <div className="markdown-table-scroll" key={index}>
      <table className="markdown-table">
        <thead><tr>{block.headers.map((header: string, headerIndex: number) => <th key={headerIndex}>{renderInlineMarkdown(header, `${index}-h-${headerIndex}`, cwd)}</th>)}</tr></thead>
        <tbody>{block.rows.map((row: string[], rowIndex: number) => <tr key={rowIndex}>{block.headers.map((_: string, cellIndex: number) => <td key={cellIndex}>{renderInlineMarkdown(row[cellIndex] ?? '', `${index}-${rowIndex}-${cellIndex}`, cwd)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function CodeBlock({ lang, text }: { lang?: string; text: string }) {
  return (
    <figure className="code-component">
      <figcaption><span>{lang || 'code'}</span><small>{text.split('\n').length} lines</small></figcaption>
      <pre className="markdown-code"><code>{text}</code></pre>
    </figure>
  );
}

function renderMarkdownQuote(text: string, index: number, cwd?: string): ReactNode {
  const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?([\s\S]*)$/i.exec(text.trim());
  if (alert) {
    const kind = alert[1].toLowerCase();
    const body = alert[2].trim();
    return (
      <aside className={`markdown-alert ${kind}`} key={index}>
        <strong>{markdownAlertLabel(kind)}</strong>
        <div>{parseMarkdownBlocks(body).map((child, childIndex) => renderMarkdownBlock(child, childIndex, cwd))}</div>
      </aside>
    );
  }
  return <blockquote key={index}>{parseMarkdownBlocks(text).map((child, childIndex) => renderMarkdownBlock(child, childIndex, cwd))}</blockquote>;
}

function markdownAlertLabel(kind: string): string {
  if (kind === 'tip') return '提示';
  if (kind === 'important') return '重点';
  if (kind === 'warning') return '警告';
  if (kind === 'caution') return '注意';
  return '说明';
}

function renderMarkdownHeading(level: number, text: string, key: number, cwd?: string): ReactNode {
  const children = renderInlineMarkdown(text, `${key}`, cwd);
  if (level === 1) return <h1 key={key}>{children}</h1>;
  if (level === 2) return <h2 key={key}>{children}</h2>;
  if (level === 3) return <h3 key={key}>{children}</h3>;
  if (level === 4) return <h4 key={key}>{children}</h4>;
  if (level === 5) return <h5 key={key}>{children}</h5>;
  return <h6 key={key}>{children}</h6>;
}

function renderInlineMarkdown(text: string, keyPrefix: string, cwd?: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(!\[[^\]\n]*\]\([^) \n]+(?:\s+"[^"]*")?\)|`[^`]+`|\*\*[\s\S]+?\*\*|__[\s\S]+?__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^) \n]+(?:\s+"[^"]*")?\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith('![')) {
      const image = markdownImageFromToken(token, cwd);
      nodes.push(image ? <MessageImage key={key} image={image} /> : token);
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key}>{renderInlineMarkdown(token.slice(2, -2), key, cwd)}</strong>);
    } else if (token.startsWith('*') || token.startsWith('_')) {
      nodes.push(<em key={key}>{renderInlineMarkdown(token.slice(1, -1), key, cwd)}</em>);
    } else {
      const link = /^\[([^\]\n]+)\]\(([^) \n]+)(?:\s+"[^"]*")?\)$/.exec(token);
      const href = link ? safeMarkdownHref(link[2]) : undefined;
      nodes.push(href ? <a key={key} href={href} target="_blank" rel="noreferrer">{renderInlineMarkdown(link![1], key, cwd)}</a> : token);
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function safeMarkdownHref(href: string): string | undefined {
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (/^#[\w-]+$/.test(href)) return href;
  return undefined;
}

interface MessageImageRef {
  raw: string;
  src: string;
  alt: string;
  label: string;
}

function ImagePreviewList({ images }: { images: MessageImageRef[] }) {
  if (!images.length) return null;
  return (
    <div className="message-image-list">
      {images.map((image) => <MessageImage key={`${image.raw}-${image.src}`} image={image} />)}
    </div>
  );
}

function MessageImage({ image }: { image: MessageImageRef }) {
  return (
    <span className="message-image-card">
      <a href={image.src} target="_blank" rel="noreferrer" title={image.raw}>
        <img src={image.src} alt={image.alt} loading="lazy" />
      </a>
      <span>{image.label}</span>
    </span>
  );
}

function markdownImageFromToken(token: string, cwd?: string): MessageImageRef | undefined {
  const match = /^!\[([^\]\n]*)\]\(([^) \n]+)(?:\s+"[^"]*")?\)$/.exec(token);
  if (!match) return undefined;
  return createMessageImageRef(match[2], cwd, match[1] || 'image');
}

function extractLooseImageRefs(text: string, cwd?: string): MessageImageRef[] {
  const candidates: string[] = [];
  const withoutMarkdownImages = text.replace(/!\[[^\]\n]*\]\([^)]+\)/g, ' ');
  const tagPattern = /<(?:output-file|input-file|image|image_path|imagePath|file_path|filePath|path|url)>\s*([^<>]+?)\s*<\/(?:output-file|input-file|image|image_path|imagePath|file_path|filePath|path|url)>/gi;
  const bracketPattern = /\[\[([^\]]+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#][^\]]*)?)\]\]/gi;
  const markdownLinkPathPattern = /\[[^\]\n]+\]\(([^) \n]+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#][^) \n]*)?)\)/gi;
  const loosePathPattern = /(?:file:\/\/\/[^\s<>"')\]]+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#][^\s<>"')\]]*)?|\/[^\s<>"')\]]+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#][^\s<>"')\]]*)?|(?:\.{1,2}\/|[\w\u3400-\u9fff][^\s<>"')\]]*\/)[^\s<>"')\]]+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#][^\s<>"')\]]*)?)/gi;

  collectPatternCandidates(withoutMarkdownImages, tagPattern, candidates);
  collectPatternCandidates(withoutMarkdownImages, bracketPattern, candidates);
  collectPatternCandidates(withoutMarkdownImages, markdownLinkPathPattern, candidates);
  collectPatternCandidates(withoutMarkdownImages, loosePathPattern, candidates);

  const unique = new Map<string, MessageImageRef>();
  for (const candidate of candidates) {
    const image = createMessageImageRef(candidate, cwd);
    if (image && !unique.has(image.raw)) unique.set(image.raw, image);
  }
  return [...unique.values()].slice(0, 6);
}

function collectPatternCandidates(text: string, pattern: RegExp, candidates: string[]): void {
  for (const match of text.matchAll(pattern)) {
    const value = match[1] ?? match[0];
    if (value) candidates.push(value);
  }
}

function createMessageImageRef(rawValue: string, cwd?: string, alt = 'image'): MessageImageRef | undefined {
  const raw = normalizeImageReference(rawValue);
  if (!raw || !looksLikeDisplayableImage(raw)) return undefined;
  const src = imageReferenceSrc(raw, cwd);
  if (!src) return undefined;
  return {
    raw,
    src,
    alt,
    label: imageReferenceLabel(raw)
  };
}

function imageReferenceSrc(raw: string, cwd?: string): string | undefined {
  if (/^data:image\//i.test(raw) || /^https?:\/\//i.test(raw)) return raw;
  const params = new URLSearchParams({ path: raw });
  if (cwd) params.set('cwd', cwd);
  return `/api/assets/image?${params.toString()}`;
}

function normalizeImageReference(value: string): string {
  return value
    .trim()
    .replace(/^["'`<]+|["'`>,，。；;:：]+$/g, '')
    .replace(/^\[\[|\]\]$/g, '')
    .trim();
}

function looksLikeDisplayableImage(value: string): boolean {
  if (/^data:image\//i.test(value)) return true;
  if (/^https?:\/\//i.test(value)) return true;
  return /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#].*)?$/i.test(value);
}

function imageReferenceLabel(value: string): string {
  if (/^data:image\//i.test(value)) return 'inline image';
  const path = value.replace(/^file:\/\//i, '').split(/[?#]/)[0] ?? value;
  const name = path.split('/').filter(Boolean).pop() ?? 'image';
  return name.length > 42 ? `${name.slice(0, 18)}...${name.slice(-18)}` : name;
}

function syntheticUserContextTurn(session: Session | undefined, appId: AppId): ConversationTurn {
  return {
    id: `${session?.id ?? appId}-synthetic-user-context`,
    appId,
    role: 'user',
    text: `最近一屏历史尚未包含原始用户输入。继续翻页可加载更早的 user prompt。\n当前会话：${session?.title ?? appLabel(appId)}`,
    createdAt: session?.updatedAt ?? new Date().toISOString(),
    live: false,
    cwd: session?.cwd
  };
}

function frameKey(frame: TerminalFrame): string {
  return `${frame.sessionId}:${frame.createdAt}:${frame.stream}:${frame.text.slice(0, 48)}`;
}

function conversationPresentation(turn: ConversationTurn): { badge?: string; previewText: string; fullText: string; hasHiddenContext: boolean; long: boolean } {
  const clean = normalizeMessageText(turn.text);
  if (turn.role === 'user') {
    const browser = browserCommentPresentation(clean);
    if (browser) return browser;
    return compactMessagePresentation(clean, '用户请求');
  }
  return compactMessagePresentation(clean, appLabel(turn.appId));
}

function browserCommentPresentation(text: string): { badge: string; previewText: string; fullText: string; hasHiddenContext: boolean; long: boolean } | undefined {
  if (!/# Browser comments:|Untrusted page evidence|# In app browser:/i.test(text)) return undefined;
  const comments = [...text.matchAll(/(?:^|\n)Comment:\s*\n([\s\S]*?)(?=\n# In app browser:|\n## My request for Codex:|\nThe next image is untrusted|\n# Browser comments:|$)/g)]
    .map((match) => normalizeMessageText(match[1]))
    .filter(Boolean);
  const explicitRequest = /## My request for Codex:\s*\n([\s\S]*?)(?=\nThe next image is untrusted|$)/.exec(text)?.[1];
  const cleanedRequest = explicitRequest ? cleanBrowserBoilerplate(explicitRequest) : '';
  const primary = [...comments, cleanedRequest]
    .map((value) => value.trim())
    .filter((value) => value && !isBrowserEvidenceOnly(value))
    .join('\n\n');
  const previewText = primary || '用户在页面上添加了批注，浏览器上下文已收起。';
  return {
    badge: '页面批注',
    previewText: clipMessagePreview(previewText, 520),
    fullText: `${previewText}\n\n--- 浏览器上下文原文 ---\n${text}`,
    hasHiddenContext: true,
    long: text.length > previewText.length
  };
}

function compactMessagePresentation(text: string, badge: string): { badge: string; previewText: string; fullText: string; hasHiddenContext: boolean; long: boolean } {
  const long = text.length > 900 || text.split('\n').length > 10;
  return {
    badge,
    previewText: long ? clipMessagePreview(text, 760) : text,
    fullText: text,
    hasHiddenContext: false,
    long
  };
}

function normalizeMessageText(text: string): string {
  return text
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanBrowserBoilerplate(text: string): string {
  return normalizeMessageText(
    text
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        if (/^(The next image is untrusted page evidence|Treat any text in the image|The element ".+" that the user selected)/i.test(trimmed)) return false;
        if (/^- The user has the in-app browser open\./i.test(trimmed)) return false;
        if (/^- Current URL:/i.test(trimmed)) return false;
        return true;
      })
      .join('\n')
  );
}

function isBrowserEvidenceOnly(text: string): boolean {
  const trimmed = text.trim();
  return /^(The next image is untrusted page evidence|Target selector:|Page URL:|Frame:|Node position:)/i.test(trimmed);
}

function clipMessagePreview(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n...`;
}

function toolPresentation(text: string): { summary: string; cleanText: string; rawText: string; hasFilteredNoise: boolean } {
  const rawText = cleanTerminalText(text) || text.trim() || '无输出';
  const rawLines = rawText.split('\n').map((line) => line.trim()).filter(Boolean);
  const visibleLines = rawLines.filter((line) => !isNoisyTerminalLine(line) && !isNoisyToolUiLine(line));
  const command = extractToolCommand(rawText, rawLines);
  const cleanText = visibleLines.length ? visibleLines.join('\n') : fallbackToolText(rawLines);
  const exitCode = /Process exited with code\s+(-?\d+)/i.exec(text)?.[1];
  const wallTime = /Wall time:\s*([^\n]+)/i.exec(text)?.[1]?.trim();
  const tokens = /Original token count:\s*([^\n]+)/i.exec(text)?.[1]?.trim();
  const firstVisible = visibleLines.find((line) => !/^[$>#|]/.test(line)) ?? visibleLines[0];
  const label = command ? `命令：${command}` : firstVisible ? cleanToolLine(firstVisible) : '终端界面状态输出';
  const meta = [
    exitCode ? `code ${exitCode}` : '',
    wallTime ? wallTime.replace(/\s*seconds?/i, 's') : '',
    tokens ? `${tokens} token` : ''
  ].filter(Boolean);
  return {
    summary: clipInlineText(meta.length ? `${label} · ${meta.join(' · ')}` : label, 118),
    cleanText,
    rawText,
    hasFilteredNoise: visibleLines.length !== rawLines.length
  };
}

function fallbackToolText(lines: string[]): string {
  if (lines.some((line) => /Claude Code v|Tips for getting started|Welcome back!/i.test(line))) {
    return '已隐藏 Claude Code TUI 状态栏和欢迎横幅。';
  }
  return lines.length ? lines.slice(0, 12).join('\n') : '无可展示的工具输出。';
}

function extractToolCommand(text: string, lines: string[]): string | undefined {
  const jsonLine = lines.find((line) => line.startsWith('{') && (line.includes('"cmd"') || line.includes('"command"')));
  if (jsonLine) {
    try {
      const parsed = JSON.parse(jsonLine) as { cmd?: string; command?: string };
      const command = parsed.cmd ?? parsed.command;
      if (command) return command;
    } catch {
      const match = /"(?:cmd|command)"\s*:\s*"([^"]+)"/.exec(jsonLine);
      if (match) return match[1];
    }
  }
  const outputCommand = /^>\s*(.+)$/.exec(lines.find((line) => line.startsWith('> ')) ?? '');
  if (outputCommand) return outputCommand[1];
  const explicit = /(?:cmd|command)["']?\s*[:=]\s*["']?([^"',}\n]+)/i.exec(text);
  return explicit?.[1]?.trim();
}

function cleanToolLine(line: string): string {
  return line
    .replace(/^Chunk ID:\s*/i, '输出 ')
    .replace(/^exec_command$/i, '执行命令')
    .replace(/^write_stdin$/i, '继续读取输出');
}

function isNoisyToolUiLine(line: string): boolean {
  const normalized = line.replace(/[─━│┃┌┐└┘╭╮╰╯═║╔╗╚╝┬┴├┤┼]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return true;
  return (
    /Claude Code v\d/i.test(normalized) ||
    /Tips for getting started/i.test(normalized) ||
    /Welcome back!/i.test(normalized) ||
    /Run \/init to create/i.test(normalized) ||
    /What's new/i.test(normalized) ||
    /Bug fixes and reliabilit/i.test(normalized) ||
    /fallbackModel/i.test(normalized) ||
    /Added glob pattern suppo/i.test(normalized) ||
    /API Usage Billing/i.test(normalized) ||
    /\/release-notes/i.test(normalized) ||
    /Try "fix lint errors"/i.test(normalized) ||
    /^for agents$/i.test(normalized) ||
    /tmux detected/i.test(normalized) ||
    /scroll with PgUp\/PgDn/i.test(normalized) ||
    /focus-events/i.test(normalized) ||
    /^# .+ @ .+ in .+ on git:/i.test(normalized)
  );
}

function clipInlineText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function framesToConversationTurns(frames: TerminalFrame[], fallbackAppId: AppId, cwd?: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  frames.forEach((frame, frameIndex) => {
    const items = frameToConversationItems(frame, fallbackAppId, cwd);
    items.forEach((item, itemIndex) => {
      const previous = turns[turns.length - 1];
      if (previous && previous.role === item.role && previous.live === item.live && previous.appId === item.appId) {
        previous.text = clipConversationText(`${previous.text}\n${item.text}`, previous.role);
        previous.createdAt = item.createdAt;
        return;
      }
      turns.push({ ...item, id: `${frame.sessionId}-${frame.createdAt}-${frameIndex}-${itemIndex}` });
    });
  });
  return turns;
}

function frameToConversationItems(frame: TerminalFrame, fallbackAppId: AppId, cwd?: string): Array<Omit<ConversationTurn, 'id'>> {
  const parsed = frame.text
    .split('\n')
    .flatMap((line) => conversationItemsFromJsonLine(line, frame, fallbackAppId, cwd));
  if (parsed.length) return parsed;

  const cleaned = cleanTerminalText(frame.text);
  if (!cleaned) return [];
  return prefixedLinesToConversationItems(cleaned.split('\n'), frame, fallbackAppId, frame.stream !== 'system', cwd);
}

function conversationItemsFromJsonLine(line: string, frame: TerminalFrame, fallbackAppId: AppId, cwd?: string): Array<Omit<ConversationTurn, 'id'>> {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    if (value.type === 'history.message') {
      const role = normalizeConversationRole(String(value.role ?? frame.stream));
      const text = clipConversationText(cleanTerminalText(String(value.text ?? '')), role);
      return text ? [{ appId: frame.appId ?? fallbackAppId, role, text, createdAt: frame.createdAt, live: false, cwd }] : [];
    }
    return prefixedLinesToConversationItems(displayFromJson(value), frame, fallbackAppId, true, cwd);
  } catch {
    return [];
  }
}

function prefixedLinesToConversationItems(lines: string[], frame: TerminalFrame, fallbackAppId: AppId, live: boolean, cwd?: string): Array<Omit<ConversationTurn, 'id'>> {
  const items: Array<Omit<ConversationTurn, 'id'>> = [];
  for (const line of lines) {
    if (isNoisyTerminalLine(line) || isNoisyToolUiLine(line)) continue;
    const match = /^(assistant|user|tool|system|error|output|token|event|stdout|stderr)> ?([\s\S]*)$/i.exec(line);
    const role = normalizeConversationRole(match?.[1] ?? frame.stream);
    const text = clipConversationText(cleanTerminalText(match?.[2] ?? line), role);
    if (text) items.push({ appId: frame.appId ?? fallbackAppId, role, text, createdAt: frame.createdAt, live, cwd });
  }
  return items;
}

function normalizeConversationRole(role: string): ConversationRole {
  const normalized = role.toLowerCase();
  if (normalized.includes('assistant') || normalized.includes('agent') || normalized.includes('model')) return 'assistant';
  if (normalized.includes('user') || normalized.includes('human')) return 'user';
  if (normalized.includes('error') || normalized.includes('stderr')) return 'error';
  if (normalized.includes('tool') || normalized.includes('command') || normalized.includes('stdout')) return 'tool';
  if (normalized.includes('system') || normalized.includes('event') || normalized.includes('token')) return 'system';
  return 'output';
}

function roleLabel(appId: AppId, role: ConversationRole): string {
  if (role === 'user') return appId === 'claude' ? 'Human' : 'User';
  if (role === 'assistant') return appLabel(appId);
  if (role === 'tool') return appId === 'claude' ? 'Tool use' : 'Tool';
  if (role === 'error') return 'Error';
  if (role === 'system') return 'System';
  return 'Output';
}

function roleMarker(appId: AppId, role: ConversationRole): string {
  if (role === 'user') return '>';
  if (role === 'assistant') {
    if (appId === 'codex') return 'codex';
    if (appId === 'claude') return 'claude';
    if (appId === 'antigravity') return 'agy';
    if (appId === 'oh-my-pi') return 'pi';
    return 'open';
  }
  if (role === 'tool') return '$';
  if (role === 'error') return '!';
  if (role === 'system') return '#';
  return '|';
}

function clipConversationText(text: string, role: ConversationRole): string {
  const limit = role === 'tool' || role === 'output' ? 1200 : 2200;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n... 已截断；继续翻页或查看原始 CLI 日志获取完整输出。`;
}

function NewSessionDialog(props: { apps: AppInfo[]; selectedApp: AppId; onClose(): void; onCreate(appId: AppId): Promise<void> }) {
  const [busyApp, setBusyApp] = useState<AppId>();
  const [error, setError] = useState<string>();

  async function handleCreate(appId: AppId) {
    setBusyApp(appId);
    setError(undefined);
    try {
      await props.onCreate(appId);
      props.onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyApp(undefined);
    }
  }

  return (
    <div className="focus-dialog-backdrop" role="presentation" onClick={props.onClose}>
      <section className="focus-dialog focus-new-session" role="dialog" aria-modal="true" aria-labelledby="new-session-title" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2 id="new-session-title">新建会话 · 选择 App</h2>
            <p>选择要启动的 CLI，工作台会通过本地 launcher 建立真实会话。</p>
          </div>
          <button type="button" className="focus-dialog-close" onClick={props.onClose} aria-label="关闭">×</button>
        </header>
        <div className="focus-app-choices">
          {appOrder.map((appId) => {
            const app = props.apps.find((item) => item.appId === appId);
            const connected = app?.status === 'connected';
            return (
              <button
                type="button"
                key={appId}
                className={`focus-app-choice ${props.selectedApp === appId ? 'active' : ''}`}
                onClick={() => handleCreate(appId)}
                disabled={Boolean(busyApp) || !connected}
              >
                <span className={`logo ${appId}`}>{appInitials(appId)}</span>
                <strong>{appLabel(appId)}</strong>
                <em>{app?.command ?? app?.message ?? '未配置命令'}</em>
                <b>{busyApp === appId ? '启动中' : connected ? '选择' : statusText(app?.status ?? 'missing')}</b>
              </button>
            );
          })}
        </div>
        {error && <p className="focus-dialog-error">{error}</p>}
        <footer>也可在 <kbd>⌘K</kbd> 命令面板中新建</footer>
      </section>
    </div>
  );
}

type TokenDialogScope = TimeScope | 'all';

function TokenUsageDialog(props: { usage: TokenUsage[]; scope: TimeScope; setScope(scope: TimeScope): void; onClose(): void }) {
  const [activeScope, setActiveScope] = useState<TokenDialogScope>(props.scope);
  const [usageByScope, setUsageByScope] = useState<Partial<Record<TimeScope, TokenUsage[]>>>({ [props.scope]: props.usage });

  useEffect(() => {
    let cancelled = false;
    setUsageByScope((current) => ({ ...current, [props.scope]: props.usage }));
    Promise.all((['day', 'week', 'month'] as TimeScope[]).map(async (scope) => [scope, await getTokenUsage(scope)] as const))
      .then((results) => {
        if (cancelled) return;
        const next: Partial<Record<TimeScope, TokenUsage[]>> = {};
        for (const [scope, result] of results) next[scope] = result.usage;
        setUsageByScope((current) => ({ ...current, ...next }));
      })
      .catch(() => {
        // The current scope remains visible even if one background aggregate fails.
      });
    return () => {
      cancelled = true;
    };
  }, [props.scope, props.usage]);

  function selectScope(scope: TokenDialogScope) {
    setActiveScope(scope);
    if (scope !== 'all') props.setScope(scope);
  }

  const total = appOrder.reduce((sum, appId) => sum + tokenDialogValue(appId, activeScope, usageByScope), 0);
  const totalsByApp = appOrder.map((appId) => ({ appId, total: tokenDialogValue(appId, activeScope, usageByScope) }));
  const maxTotal = Math.max(1, ...totalsByApp.map((item) => item.total));

  return (
    <div className="focus-dialog-backdrop" role="presentation" onClick={props.onClose}>
      <section className="focus-dialog focus-token-modal" role="dialog" aria-modal="true" aria-labelledby="token-usage-title" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2 id="token-usage-title">Token 用量</h2>
            <p>按 App 分时段统计 · 含全部 App 汇总</p>
          </div>
          <button type="button" className="focus-dialog-close" onClick={props.onClose} aria-label="关闭">×</button>
        </header>
        <div className="focus-token-segments" role="group" aria-label="Token 统计范围">
          {(['day', 'week', 'month', 'all'] as TokenDialogScope[]).map((scope) => (
            <button key={scope} type="button" className={activeScope === scope ? 'active' : ''} onClick={() => selectScope(scope)}>
              {scope === 'day' ? '今天' : scope === 'week' ? '本周' : scope === 'month' ? '本月' : '所有'}
            </button>
          ))}
        </div>
        <div className="focus-token-total">
          <span>{activeScope === 'all' ? '已加载最大范围总量' : `${scopeLabel(activeScope)} 总量`}</span>
          <strong>{formatTokenCount(total)}</strong>
        </div>
        <div className="focus-token-stack" aria-hidden="true">
          {totalsByApp.map(({ appId, total }) => (
            <span key={appId} className={appId} style={{ flexGrow: Math.max(1, total ? total / maxTotal : 0.08) }} />
          ))}
        </div>
        <div className="focus-token-table" role="table" aria-label="Token 用量明细">
          <div className="focus-token-table-head" role="row">
            <span>APP</span>
            <span>今天</span>
            <span>本周</span>
            <span>本月</span>
            <span>所有</span>
          </div>
          {appOrder.map((appId) => (
            <div className="focus-token-table-row" role="row" key={appId}>
              <strong><i className={`dot ${appId}`} />{appLabel(appId)}</strong>
              <span>{formatTokenCount(tokenDialogValue(appId, 'day', usageByScope))}</span>
              <span>{formatTokenCount(tokenDialogValue(appId, 'week', usageByScope))}</span>
              <span>{formatTokenCount(tokenDialogValue(appId, 'month', usageByScope))}</span>
              <span>{formatTokenCount(tokenDialogValue(appId, 'all', usageByScope))}</span>
            </div>
          ))}
          <div className="focus-token-table-row summary" role="row">
            <strong>全部 App 汇总</strong>
            <span>{formatTokenCount(tokenDialogScopeTotal('day', usageByScope))}</span>
            <span>{formatTokenCount(tokenDialogScopeTotal('week', usageByScope))}</span>
            <span>{formatTokenCount(tokenDialogScopeTotal('month', usageByScope))}</span>
            <span>{formatTokenCount(tokenDialogScopeTotal('all', usageByScope))}</span>
          </div>
        </div>
        <footer>数值为输入 + 输出 token 合计 · 来自本地 adapter 聚合</footer>
      </section>
    </div>
  );
}

function tokenDialogValue(appId: AppId, scope: TokenDialogScope, usageByScope: Partial<Record<TimeScope, TokenUsage[]>>): number {
  if (scope === 'all') {
    return Math.max(...(['day', 'week', 'month'] as TimeScope[]).map((item) => tokenDialogValue(appId, item, usageByScope)));
  }
  return usageByScope[scope]?.find((row) => row.appId === appId)?.totalTokens ?? 0;
}

function tokenDialogScopeTotal(scope: TokenDialogScope, usageByScope: Partial<Record<TimeScope, TokenUsage[]>>): number {
  return appOrder.reduce((sum, appId) => sum + tokenDialogValue(appId, scope, usageByScope), 0);
}

function DeleteSessionDialog(props: { session: Session; busy: boolean; error?: string; onCancel(): void; onConfirm(): void }) {
  return (
    <div className="modal-backdrop" data-testid="delete-session-dialog" role="presentation" onClick={props.onCancel}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-session-title" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2 id="delete-session-title">删除选中会话</h2>
            <p>删除该会话的 CLI 原始日志，并从工作台移除。</p>
          </div>
          <span className={`modal-app ${props.session.appId}`}>{appLabel(props.session.appId)}</span>
        </header>
        <div className="modal-body">
          <strong>{appLabel(props.session.appId)} {sessionShort(props.session.id)}</strong>
          <span>{props.session.title}</span>
          <p>会删除该会话对应的 CLI 原始日志文件；如果该 App 使用共享 history 文件，则只移除当前会话记录。此操作不可恢复。</p>
          {props.error && <p className="modal-error" data-testid="delete-session-error">{props.error}</p>}
        </div>
        <footer>
          <button type="button" data-testid="delete-session-cancel" onClick={props.onCancel} disabled={props.busy}>取消</button>
          <button type="button" data-testid="delete-session-confirm" className="danger solid" onClick={props.onConfirm} disabled={props.busy}>{props.busy ? '删除原始日志中...' : '确认删除原始日志'}</button>
        </footer>
      </section>
    </div>
  );
}

function formatTerminalFrames(frames: TerminalFrame[]): string {
  if (!frames.length) return '等待当前会话输出...';
  const lines = frames.flatMap((frame) => frameToDisplayLines(frame));
  const compacted = compactDisplayLines(lines);
  return compacted.length ? compacted.join('\n') : '等待当前会话输出...';
}

function frameToDisplayLines(frame: TerminalFrame): string[] {
  const parsedLines = frame.text
    .split('\n')
    .flatMap((line) => displayFromJsonLine(line))
    .filter(Boolean);
  if (parsedLines.length) return parsedLines;
  const cleaned = cleanTerminalText(frame.text);
  if (!cleaned) return [];
  return cleaned
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `${frame.stream}> ${line}`);
}

function displayFromJsonLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    return displayFromJson(value);
  } catch {
    return [];
  }
}

function displayFromJson(value: Record<string, unknown>): string[] {
  const type = String(value.type ?? value.event ?? '');
  const lines: string[] = [];
  const message = value.message && typeof value.message === 'object' ? (value.message as Record<string, unknown>) : undefined;
  const delta = value.delta && typeof value.delta === 'object' ? (value.delta as Record<string, unknown>) : undefined;
  const item = value.item && typeof value.item === 'object' ? (value.item as Record<string, unknown>) : undefined;

  const text = firstText(
    value.text,
    value.content,
    value.result,
    value.response,
    value.summary,
    value.output,
    value.last_agent_message,
    delta?.text,
    delta?.content,
    message?.content,
    item?.text,
    item?.content,
    item?.message
  );
  if (text) lines.push(rolePrefix(String(value.role ?? message?.role ?? item?.role ?? item?.type ?? type), text));

  const content = message?.content ?? item?.content ?? value.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const itemText = firstText(record.text, record.content, record.input);
      if (itemText) lines.push(rolePrefix(String(value.role ?? message?.role ?? item?.role ?? item?.type ?? record.type ?? type), itemText));
    }
  }

  if (!lines.length && type) {
    const status = codexStatusLine(type, value);
    if (status) lines.push(status);
  }

  const usage = value.usage && typeof value.usage === 'object' ? (value.usage as Record<string, unknown>) : undefined;
  if (usage) {
    const input = numberValue(usage.input_tokens ?? usage.inputTokens ?? usage.cache_read_input_tokens);
    const output = numberValue(usage.output_tokens ?? usage.outputTokens);
    if (input || output) lines.push(`token> 输入 ${formatTokenCount(input)} · 输出 ${formatTokenCount(output)}`);
  }

  if (!lines.length && type && !['content_block_delta', 'message_delta', 'message_start', 'content_block_start', 'ping'].includes(type)) {
    const cleaned = cleanTerminalText(JSON.stringify(value));
    if (cleaned) lines.push(`event> ${cleaned}`);
  }
  return lines;
}

function codexStatusLine(type: string, value: Record<string, unknown>): string {
  if (type === 'thread.started') return `system> Codex 会话已启动 ${String(value.thread_id ?? '').slice(0, 8)}`;
  if (type === 'turn.started') return 'system> 回合开始';
  if (type === 'turn.completed') return 'system> 回合完成';
  if (type === 'turn.failed') return 'error> 回合失败';
  if (type === 'item.started') return `tool> ${itemLabel(value.item)} 开始`;
  if (type === 'item.completed') return `tool> ${itemLabel(value.item)} 完成`;
  return '';
}

function itemLabel(value: unknown): string {
  if (!value || typeof value !== 'object') return '步骤';
  const item = value as Record<string, unknown>;
  return String(item.title ?? item.name ?? item.command ?? item.type ?? '步骤');
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return cleanTerminalText(value);
  }
  return '';
}

function rolePrefix(role: string, text: string): string {
  const normalized = role.toLowerCase();
  if (normalized.includes('assistant') || normalized.includes('agent')) return `assistant> ${text}`;
  if (normalized.includes('user')) return `user> ${text}`;
  if (normalized.includes('error')) return `error> ${text}`;
  if (normalized.includes('tool')) return `tool> ${text}`;
  if (normalized.includes('system')) return `system> ${text}`;
  return `output> ${text}`;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function cleanTerminalText(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, ' ')
    .replace(/\u001b[()][A-Za-z0-9]/g, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function compactDisplayLines(lines: string[]): string[] {
  const result: string[] = [];
  for (const line of lines) {
    if (isNoisyTerminalLine(line)) continue;
    const previous = result[result.length - 1];
    if (!line || line === previous) continue;
    if (/^event> \{/.test(line) && result.some((item) => item === line)) continue;
    result.push(line);
  }
  return result.slice(-TERMINAL_DISPLAY_LINE_LIMIT);
}

function isNoisyTerminalLine(line: string): boolean {
  return (
    line.includes('Reading additional input from stdin') ||
    line.includes('codex_core_plugins::manifest') ||
    line.includes('codex_core_skills::loader') ||
    line.includes("icon path with '..' must resolve") ||
    line.includes('prompt must be at most 128 characters')
  );
}

function AppConnectors({ apps, tokenUsage, scope, activeApp, onApp }: { apps: AppInfo[]; tokenUsage: TokenUsage[]; scope: TimeScope; activeApp: AppId; onApp(appId: AppId): void }) {
  return <section className="card panel compact"><PanelHead title="App 连接器" note="会话数、Token、日志采集状态" />{appOrder.map((appId) => { const app = apps.find((item) => item.appId === appId); const usage = tokenUsage.find((item) => item.appId === appId); return <button type="button" className={`connector-row ${appId} ${activeApp === appId ? 'active' : ''}`} data-testid={`connector-${appId}`} key={appId} onClick={() => onApp(appId)}><div className={`logo ${appId}`}>{appInitials(appId)}</div><div><strong>{appLabel(appId)} <Status status={app?.status === 'connected' ? 'running' : app?.status === 'not_configured' ? 'pending' : 'interrupted'} /></strong><span>{app?.sessions ?? 0} 个会话 · {scopeLabel(scope)} {formatTokenCount(usage?.totalTokens ?? 0)} token · {app?.command ?? app?.message ?? '未发现命令'}</span></div><b>{app?.sessions ?? 0}<small>会话</small></b></button>; })}</section>;
}

function TokenCounts({ usage, scope, variant = 'stacked' }: { usage: TokenUsage[]; scope: TimeScope; variant?: 'stacked' | 'inline' }) {
  return (
    <section className={`${variant === 'stacked' ? 'card panel compact ' : ''}token-count-card ${variant}`} data-testid="token-count-card">
      <PanelHead title="Token 计数" note={`${scopeLabel(scope)} · 输入 / 输出 / 总量`} />
      <div className="token-list">
        {appOrder.map((appId) => {
          const row = usage.find((item) => item.appId === appId);
          return (
            <div className="token-row" key={appId}>
              <div>
                <strong><i className={`dot ${appId}`} />{appLabel(appId)}</strong>
                <span>输入 {formatTokenCount(row?.inputTokens ?? 0)} · 输出 {formatTokenCount(row?.outputTokens ?? 0)}</span>
              </div>
              <b>{formatTokenCount(row?.totalTokens ?? 0)}<small>tokens</small></b>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BillingModes({ apps, tokenUsage }: { apps: AppInfo[]; tokenUsage: TokenUsage[] }) {
  return <section className="card panel compact"><PanelHead title="计费模式" note="来自本地 adapter 与 token 聚合" />{apps.map((app) => { const usage = tokenUsage.find((row) => row.appId === app.appId); return <div className="billing-row" key={app.appId}><div><strong>{billingModeTitle(app.billingMode)}</strong><span>{appLabel(app.appId)} · {app.message} · {formatTokenCount(usage?.totalTokens ?? 0)} tokens</span></div><b>{statusText(app.status)}</b></div>; })}</section>;
}

function AppSummary({
  appId,
  app,
  usage,
  sessions,
  scope
}: {
  appId: AppId;
  app?: AppInfo;
  usage?: TokenUsage;
  sessions: Session[];
  scope: TimeScope;
}) {
  const running = sessions.filter((session) => session.status === 'running').length;
  const completed = sessions.filter((session) => session.status === 'completed').length;
  return (
    <section className="card app-summary" data-testid="app-summary">
      <div className={`logo ${appId}`}>{appInitials(appId)}</div>
      <div className="app-summary-main">
        <div>
          <h2>{appLabel(appId)} 工作台</h2>
          <p>{app?.command ?? app?.message ?? '未发现命令'} · {statusText(app?.status ?? 'missing')}</p>
        </div>
        <Status status={app?.status === 'connected' ? 'connected' : app?.status ?? 'missing'} />
      </div>
      <div className="summary-stat"><span>会话</span><strong>{sessions.length}</strong></div>
      <div className="summary-stat"><span>执行中</span><strong>{running}</strong></div>
      <div className="summary-stat"><span>已完成</span><strong>{completed}</strong></div>
      <div className="summary-stat"><span>{scopeLabel(scope)} Token</span><strong>{formatTokenCount(usage?.totalTokens ?? 0)}</strong></div>
    </section>
  );
}

function ConfirmationQueue({
  confirmations,
  onSelect,
  onResolve
}: {
  confirmations: Confirmation[];
  onSelect(item: Confirmation): void;
  onResolve(id: string, approved: boolean): void;
}) {
  return (
    <section className="card panel" data-testid="confirmation-queue">
      <PanelHead title="确认队列" note={`${confirmations.length} 个高风险动作等待处理`} />
      <div className="confirmation-list">
        {confirmations.length === 0 && <div className="empty-state">当前没有待确认动作。</div>}
        {confirmations.map((item) => (
          <article className="confirmation-card" key={item.id}>
            <button type="button" onClick={() => onSelect(item)}>
              <strong><i className={`dot ${item.appId}`} />{appLabel(item.appId)} {sessionShort(item.sessionId)}</strong>
              <span>{item.reason}</span>
              <time>{new Date(item.createdAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', month: '2-digit', day: '2-digit' })}</time>
            </button>
            <div>
              <button type="button" onClick={() => onResolve(item.id, true)}>确认</button>
              <button type="button" onClick={() => onResolve(item.id, false)}>拒绝</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function RiskPanel({ risks, onAction }: { risks: string[]; onAction(): void }) {
  return <section className="card panel risk"><PanelHead title="风险提示" note="费用与运行稳定性" /><strong>{risks.length}</strong><p>{risks[0] ?? '当前没有待确认动作、未连接 CLI 或 token 阈值风险。'}</p><button type="button" data-testid="risk-action" onClick={onAction}>{risks.length ? '查看风险' : '回到总览'}</button></section>;
}

function PanelHead({ title, note, extra }: { title: string; note: string; extra?: ReactNode }) {
  return <header className="panel-head"><div><h2>{title}</h2><p>{note}</p></div>{extra}</header>;
}

function Legend() {
  return <div className="legend">{appOrder.map((appId) => <span key={appId}><i className={`dot ${appId}`} />{appLabel(appId)}</span>)}</div>;
}

function Status({ status }: { status: string }) {
  const label = status === 'running' || status === 'connected' ? '执行中' : status === 'completed' ? '已完成' : status === 'pending' ? '待配置' : status === 'stopped' ? '已停止' : status === 'not_configured' ? '未配置' : status === 'missing' ? '未发现' : '中断';
  return <em className={`status ${status}`}>{label}</em>;
}

function isAppId(value: string): value is AppId {
  return appOrder.includes(value as AppId);
}

function navFromHash(): NavKey {
  if (typeof window === 'undefined') return 'overview';
  const value = window.location.hash.replace(/^#/, '');
  if (value === 'overview' || value === 'sessions' || value === 'confirmations' || isAppId(value)) return value;
  return 'overview';
}

function syncHash(key: NavKey): void {
  if (typeof window === 'undefined') return;
  const next = `#${key}`;
  if (window.location.hash !== next) window.location.hash = next;
}

function pageTitle(key: NavKey): string {
  if (key === 'overview') return 'AI Coding App 整合工作台';
  if (key === 'sessions') return '会话切换';
  if (key === 'confirmations') return '确认队列';
  return `${appLabel(key)} 工作台`;
}

function pageSubtitle(key: NavKey, scope: TimeScope): string {
  if (key === 'overview') return `统一监控 Codex、Claude、Antigravity 的会话与 ${scopeLabel(scope)} token`;
  if (key === 'sessions') return '选择 App 和会话，并向当前会话发送指令';
  if (key === 'confirmations') return '集中处理写文件、执行命令、访问网络等高风险动作';
  return `${appLabel(key)} 的真实本机会话、token 与交互控制`;
}

function makePath(values: number[], max: number): string {
  if (!values.length) return '';
  const width = 712;
  const step = width / Math.max(1, values.length - 1);
  return values.map((value, index) => `${index === 0 ? 'M' : 'L'}${24 + index * step} ${154 - (value / max) * 116}`).join(' ');
}

function sessionShort(id: string): string {
  const match = id.match(/([A-Z]+-\d+)$/i);
  if (match) return `#${match[1].toUpperCase()}`;
  return `#${id.slice(-6)}`;
}

function sessionDurationMs(session: Pick<Session, 'createdAt' | 'updatedAt'>): number {
  return Date.parse(session.updatedAt) - Date.parse(session.createdAt);
}

function mergeConfirmation(current: Confirmation[], next: Confirmation): Confirmation[] {
  if (current.some((item) => item.id === next.id)) return current;
  return [next, ...current];
}

function connectedCount(apps: AppInfo[]): number {
  return apps.filter((app) => app.status === 'connected').length;
}

function scopeLabel(scope: TimeScope): string {
  if (scope === 'day') return '今日';
  if (scope === 'week') return '本周';
  return '本月';
}

function topTokenUsage(usage: TokenUsage[]): TokenUsage | undefined {
  return usage.reduce<TokenUsage | undefined>((top, row) => (!top || row.totalTokens > top.totalTokens ? row : top), undefined);
}

function estimateCost(apps: AppInfo[], usage: TokenUsage[]): { value: string; note: string } {
  const usageApps = apps.filter((app) => app.billingMode === 'usage');
  const usageTokens = usageApps.reduce((sum, app) => sum + (usage.find((row) => row.appId === app.appId)?.totalTokens ?? 0), 0);
  if (usageTokens === 0) return { value: '¥0.00', note: '当前按量 token 为 0，订阅/内置额度不计入现金成本' };
  return { value: '未配置', note: `${formatTokenCount(usageTokens)} 按量 tokens · 设置本地价格表后计算金额` };
}

function buildRiskItems(apps: AppInfo[], usage: TokenUsage[], confirmations: Confirmation[]): string[] {
  const risks: string[] = [];
  if (confirmations.length) risks.push(`${confirmations.length} 个高风险动作等待确认。`);
  for (const app of apps.filter((item) => item.status !== 'connected')) {
    risks.push(`${app.label}：${app.message}`);
  }
  for (const row of usage.filter((item) => item.totalTokens >= TOKEN_ALERT_THRESHOLD)) {
    risks.push(`${appLabel(row.appId)} 当前用量 ${formatTokenCount(row.totalTokens)} token，已超过 ${formatTokenCount(TOKEN_ALERT_THRESHOLD)} 提醒阈值。`);
  }
  return risks;
}

function billingModeTitle(mode: AppInfo['billingMode']): string {
  if (mode === 'subscription') return '订阅 / 席位';
  if (mode === 'usage') return 'API Key 按量';
  return 'App 内置额度';
}

function statusText(status: AppInfo['status']): string {
  if (status === 'connected') return '已连接';
  if (status === 'not_configured') return '未配置';
  if (status === 'missing') return '未发现';
  return '异常';
}

function fileSafeTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
