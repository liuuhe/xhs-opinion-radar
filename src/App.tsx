import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  BarChart3,
  Camera,
  CheckCircle2,
  Database,
  Download,
  FileJson,
  FileText,
  KeyRound,
  Loader2,
  MessageCircle,
  Radar,
  RefreshCcw,
  Search,
  ShieldAlert,
  Sparkles
} from "lucide-react";
import { Bar, BarChart, Cell, Pie, PieChart, Tooltip, XAxis, YAxis } from "recharts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip as UiTooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  AnalysisDiagnostics,
  AnalysisEngine,
  AnalysisResponse,
  AnalysisStage,
  AnalysisStreamEvent,
  ApiErrorResponse,
  LabeledSample,
  RemoteLoginActionResponse,
  RemoteLoginStage,
  RemoteLoginStreamEvent,
  SessionStatusResponse,
  SentimentBucket,
  SentimentLabel
} from "./shared/types";

const LABEL_META: Record<
  SentimentLabel,
  { name: string; description: string; color: string; badgeClass: string }
> = {
  positive: {
    name: "正向",
    description: "支持、满意、鼓励",
    color: "var(--chart-1)",
    badgeClass: "bg-emerald-100 text-emerald-800 border-emerald-200"
  },
  neutral: {
    name: "中性",
    description: "陈述、观望、无法确定",
    color: "var(--chart-2)",
    badgeClass: "bg-amber-100 text-amber-900 border-amber-200"
  },
  negative: {
    name: "负向",
    description: "不满、质疑、批评",
    color: "var(--chart-3)",
    badgeClass: "bg-red-100 text-red-800 border-red-200"
  }
};

const STAGE_META: Record<AnalysisStage, { label: string; progress: number }> = {
  started: { label: "准备任务", progress: 5 },
  searching: { label: "搜索帖子", progress: 18 },
  posts_captured: { label: "提取帖子", progress: 46 },
  comments_captured: { label: "抓取评论", progress: 62 },
  labeling: { label: "情绪分析", progress: 78 },
  completed: { label: "生成报告", progress: 100 },
  failed: { label: "任务失败", progress: 100 }
};

const REMOTE_LOGIN_STAGES: RemoteLoginStage[] = [
  "login_started",
  "login_screenshot",
  "login_action",
  "login_authenticated",
  "login_expired",
  "login_error"
];

function App() {
  const [keyword, setKeyword] = useState("咖啡");
  const [engine, setEngine] = useState<AnalysisEngine>("llm");
  const [maxPosts, setMaxPosts] = useState(10);
  const [commentsPerPost, setCommentsPerPost] = useState(20);
  const [useFixture, setUseFixture] = useState(false);
  const [fixtureEnabled, setFixtureEnabled] = useState(false);
  const [result, setResult] = useState<AnalysisResponse | null>(null);
  const [error, setError] = useState<string>("");
  const [diagnostics, setDiagnostics] = useState<AnalysisDiagnostics | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentMessage, setCurrentMessage] = useState("等待开始分析");
  const [events, setEvents] = useState<AnalysisStreamEvent[]>([]);
  const [sessionStatus, setSessionStatus] = useState<SessionStatusResponse | null>(null);
  const [isSessionLoading, setIsSessionLoading] = useState(false);
  const [remoteLoginConfigured, setRemoteLoginConfigured] = useState(false);
  const [adminToken, setAdminToken] = useState("");
  const [remoteLoginMessage, setRemoteLoginMessage] = useState("输入管理员口令后，可在网页内刷新 Cloudflare 远程登录态。");
  const [remoteLoginProgress, setRemoteLoginProgress] = useState(0);
  const [remoteLoginScreenshot, setRemoteLoginScreenshot] = useState("");
  const [remoteLoginQr, setRemoteLoginQr] = useState("");
  const [remoteLoginId, setRemoteLoginId] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [isLoginActionLoading, setIsLoginActionLoading] = useState(false);
  const [isRemoteLoginLoading, setIsRemoteLoginLoading] = useState(false);
  const analyzeEventsRef = useRef<EventSource | null>(null);
  const loginEventsRef = useRef<EventSource | null>(null);

  useEffect(() => {
    void fetch("/api/health")
      .then((response) => response.json())
      .then((payload: { fixtureEnabled?: boolean; remoteLoginConfigured?: boolean }) => {
        setFixtureEnabled(Boolean(payload.fixtureEnabled));
        setRemoteLoginConfigured(Boolean(payload.remoteLoginConfigured));
      })
      .catch(() => {
        setFixtureEnabled(false);
        setRemoteLoginConfigured(false);
      });
    void refreshSessionStatus();

    return () => {
      analyzeEventsRef.current?.close();
      loginEventsRef.current?.close();
    };
  }, []);

  async function refreshSessionStatus() {
    setIsSessionLoading(true);
    try {
      const response = await fetch("/api/session/status");
      const payload = (await response.json()) as SessionStatusResponse | ApiErrorResponse;
      if (!response.ok) {
        const errorPayload = payload as ApiErrorResponse;
        throw new Error([errorPayload.error, errorPayload.details].filter(Boolean).join("："));
      }
      setSessionStatus(payload as SessionStatusResponse);
    } catch (requestError) {
      setSessionStatus({
        hasSession: false,
        key: "xhs:storage_state",
        checkedAt: new Date().toISOString(),
        message: requestError instanceof Error ? requestError.message : "无法检查 KV 登录态"
      });
    } finally {
      setIsSessionLoading(false);
    }
  }

  function handleAnalyze(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setResult(null);
    setDiagnostics(undefined);
    setEvents([]);
    setProgress(1);
    setCurrentMessage("正在连接分析流...");
    setIsLoading(true);
    analyzeEventsRef.current?.close();

    const params = new URLSearchParams({
      keyword,
      engine,
      maxPosts: String(maxPosts),
      commentsPerPost: String(commentsPerPost),
      useFixture: useFixture ? "1" : "0"
    });
    const stream = new EventSource(`/api/analyze/stream?${params.toString()}`);
    analyzeEventsRef.current = stream;
    let completed = false;

    const handleStreamEvent = (payload: AnalysisStreamEvent) => {
      setEvents((items) => [...items, payload]);
      setProgress(payload.progress);
      setCurrentMessage(payload.message);
      if (payload.diagnostics) {
        setDiagnostics(payload.diagnostics);
      }
      if (payload.result) {
        setResult(payload.result);
        setDiagnostics(payload.result.diagnostics);
      }
      if (payload.stage === "completed") {
        completed = true;
        setIsLoading(false);
        stream.close();
      }
      if (payload.stage === "failed") {
        completed = true;
        setIsLoading(false);
        setError(formatStreamFailure(payload));
        setDiagnostics(payload.diagnostics);
        stream.close();
      }
    };

    (Object.keys(STAGE_META) as AnalysisStage[]).forEach((stage) => {
      stream.addEventListener(stage, (messageEvent) => {
        handleStreamEvent(JSON.parse(messageEvent.data) as AnalysisStreamEvent);
      });
    });

    stream.onerror = () => {
      setIsLoading(false);
      if (!completed) {
        setError("分析流连接中断。为避免重复启动 Cloudflare Browser Run，本次不会自动重发；请稍后再试。");
        stream.close();
      }
    };
  }

  function startRemoteLogin() {
    setError("");
    setIsRemoteLoginLoading(true);
    setRemoteLoginProgress(1);
    setRemoteLoginMessage("正在连接远程登录流...");
    setRemoteLoginScreenshot("");
    setRemoteLoginQr("");
    setRemoteLoginId("");
    setVerificationCode("");
    loginEventsRef.current?.close();

    const params = new URLSearchParams({ token: adminToken });
    const stream = new EventSource(`/api/login/stream?${params.toString()}`);
    loginEventsRef.current = stream;
    let completed = false;

    const handleLoginEvent = (payload: RemoteLoginStreamEvent) => {
      setRemoteLoginMessage(payload.message);
      setRemoteLoginProgress(payload.progress);
      if (payload.loginId) {
        setRemoteLoginId(payload.loginId);
      }
      if (payload.screenshotDataUrl) {
        setRemoteLoginScreenshot(payload.screenshotDataUrl);
      }
      if (payload.qrImageDataUrl) {
        setRemoteLoginQr(payload.qrImageDataUrl);
      }
      if (payload.stage === "login_authenticated") {
        completed = true;
        setIsRemoteLoginLoading(false);
        setRemoteLoginMessage(`${payload.message} 保存时间：${payload.savedAt ? new Date(payload.savedAt).toLocaleString("zh-CN") : "刚刚"}`);
        void refreshSessionStatus();
        stream.close();
      }
      if (payload.stage === "login_expired" || payload.stage === "login_error") {
        completed = true;
        setIsRemoteLoginLoading(false);
        setRemoteLoginMessage([payload.message, payload.error].filter(Boolean).join("："));
        stream.close();
      }
    };

    REMOTE_LOGIN_STAGES.forEach((stage) => {
      stream.addEventListener(stage, (messageEvent) => {
        handleLoginEvent(JSON.parse(messageEvent.data) as RemoteLoginStreamEvent);
      });
    });

    stream.onerror = () => {
      setIsRemoteLoginLoading(false);
      if (!completed) {
        setRemoteLoginMessage("远程登录连接已断开；请等待当前 Browser Run 会话释放后再试。");
      }
      stream.close();
    };
  }

  async function submitRemoteVerificationCode() {
    if (!remoteLoginId) {
      setRemoteLoginMessage("远程登录会话尚未就绪，请先点击“刷新远程登录态”。");
      return;
    }
    if (!/^\d{4,8}$/.test(verificationCode)) {
      setRemoteLoginMessage("请输入 4-8 位短信验证码。");
      return;
    }
    setIsLoginActionLoading(true);
    try {
      const response = await fetch("/api/login/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: adminToken,
          loginId: remoteLoginId,
          action: "submit_code",
          code: verificationCode
        })
      });
      const payload = (await response.json()) as RemoteLoginActionResponse | ApiErrorResponse;
      if (!response.ok) {
        const errorPayload = payload as ApiErrorResponse;
        throw new Error([errorPayload.error, errorPayload.details].filter(Boolean).join("："));
      }
      setRemoteLoginMessage((payload as RemoteLoginActionResponse).message);
    } catch (requestError) {
      setRemoteLoginMessage(requestError instanceof Error ? requestError.message : "验证码操作失败");
    } finally {
      setIsLoginActionLoading(false);
    }
  }

  function exportReport(format: "json" | "csv" | "markdown") {
    if (!result) {
      return;
    }
    const payload = {
      json: {
        content: JSON.stringify(result, null, 2),
        type: "application/json",
        filename: result.exports.jsonFilename
      },
      csv: {
        content: buildCsv(result),
        type: "text/csv",
        filename: result.exports.csvFilename
      },
      markdown: {
        content: buildMarkdown(result),
        type: "text/markdown",
        filename: result.exports.markdownFilename
      }
    }[format];
    downloadText(payload.content, payload.filename, payload.type);
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-5 px-4 py-5 md:px-8 md:py-7">
      <HeroCard />

      <AnalyzePanel
        keyword={keyword}
        setKeyword={setKeyword}
        engine={engine}
        setEngine={setEngine}
        maxPosts={maxPosts}
        setMaxPosts={setMaxPosts}
        commentsPerPost={commentsPerPost}
        setCommentsPerPost={setCommentsPerPost}
        useFixture={useFixture}
        setUseFixture={setUseFixture}
        fixtureEnabled={fixtureEnabled}
        isLoading={isLoading}
        onSubmit={handleAnalyze}
        sessionStatus={sessionStatus}
        isSessionLoading={isSessionLoading}
        onRefreshSession={() => void refreshSessionStatus()}
        remoteLoginConfigured={remoteLoginConfigured}
        adminToken={adminToken}
        setAdminToken={setAdminToken}
        isRemoteLoginLoading={isRemoteLoginLoading}
        remoteLoginMessage={remoteLoginMessage}
        remoteLoginProgress={remoteLoginProgress}
        remoteLoginScreenshot={remoteLoginScreenshot}
        remoteLoginQr={remoteLoginQr}
        remoteLoginId={remoteLoginId}
        verificationCode={verificationCode}
        setVerificationCode={setVerificationCode}
        isLoginActionLoading={isLoginActionLoading}
        onStartRemoteLogin={startRemoteLogin}
        onSubmitCode={() => void submitRemoteVerificationCode()}
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>分析失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {(isLoading || events.length > 0) && (
        <ProgressPanel progress={progress} message={currentMessage} events={events} />
      )}

      {!result && !isLoading && events.length === 0 && <EmptyReportPreview />}

      {result && (
        <ReportDashboard
          result={result}
          diagnostics={diagnostics}
          onExport={exportReport}
        />
      )}
    </main>
  );
}

function HeroCard() {
  return (
    <Card className="glass-panel overflow-hidden border-0">
      <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_420px] md:items-center md:p-6">
        <div>
          <Badge variant="outline" className="mb-4 w-fit border-primary/30 bg-background/60 text-primary">
            <Radar className="mr-1 size-3.5" />
            Xiaohongshu Opinion Radar
          </Badge>
          <CardTitle className="text-2xl leading-tight tracking-[-0.04em] md:text-3xl">
            关键词舆情分析，从抓取到情绪报告一屏完成。
          </CardTitle>
          <CardDescription className="mt-3 max-w-3xl text-sm leading-6">
            输入关键词后抓取小红书搜索结果，汇总评论情绪、样本证据和失败诊断。线上优先真实抓取，fixture 仅用于本地答辩彩排。
          </CardDescription>
        </div>
        <div className="grid gap-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <MetricPill label="平台" value="小红书" />
            <MetricPill label="部署" value="Cloudflare" />
            <MetricPill label="模式" value="真实抓取优先" />
          </div>
          <div className="rounded-xl border bg-background/55 p-3 text-xs leading-5 text-muted-foreground">
            流程：远程登录态、搜索帖子、抓取评论、情绪标注、导出报告。
          </div>
        </div>
      </div>
    </Card>
  );
}

function AnalyzePanel(props: {
  keyword: string;
  setKeyword: (value: string) => void;
  engine: AnalysisEngine;
  setEngine: (value: AnalysisEngine) => void;
  maxPosts: number;
  setMaxPosts: (value: number) => void;
  commentsPerPost: number;
  setCommentsPerPost: (value: number) => void;
  useFixture: boolean;
  setUseFixture: (value: boolean) => void;
  fixtureEnabled: boolean;
  isLoading: boolean;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  sessionStatus: SessionStatusResponse | null;
  isSessionLoading: boolean;
  onRefreshSession: () => void;
  remoteLoginConfigured: boolean;
  adminToken: string;
  setAdminToken: (value: string) => void;
  isRemoteLoginLoading: boolean;
  remoteLoginMessage: string;
  remoteLoginProgress: number;
  remoteLoginScreenshot: string;
  remoteLoginQr: string;
  remoteLoginId: string;
  verificationCode: string;
  setVerificationCode: (value: string) => void;
  isLoginActionLoading: boolean;
  onStartRemoteLogin: () => void;
  onSubmitCode: () => void;
}) {
  return (
    <Card className="bg-card/90 backdrop-blur">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Search className="size-5 text-primary" />
          分析控制台
        </CardTitle>
        <CardDescription>输入关键词并选择分析规模。默认使用线上真实抓取。</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-5" onSubmit={props.onSubmit}>
          <SessionPanel
            isLoading={props.isSessionLoading}
            status={props.sessionStatus}
            onRefresh={props.onRefreshSession}
            remoteLoginConfigured={props.remoteLoginConfigured}
            adminToken={props.adminToken}
            setAdminToken={props.setAdminToken}
            isRemoteLoginLoading={props.isRemoteLoginLoading}
            remoteLoginMessage={props.remoteLoginMessage}
            remoteLoginProgress={props.remoteLoginProgress}
            remoteLoginScreenshot={props.remoteLoginScreenshot}
            remoteLoginQr={props.remoteLoginQr}
            remoteLoginId={props.remoteLoginId}
            verificationCode={props.verificationCode}
            setVerificationCode={props.setVerificationCode}
            isLoginActionLoading={props.isLoginActionLoading}
            onStartRemoteLogin={props.onStartRemoteLogin}
            onSubmitCode={props.onSubmitCode}
          />

          <div className="grid gap-2">
            <Label htmlFor="keyword">关键词</Label>
            <Input
              id="keyword"
              value={props.keyword}
              onChange={(event) => props.setKeyword(event.target.value)}
              placeholder="例如：咖啡、露营、防晒"
              maxLength={60}
              className="h-11"
            />
          </div>

          <Tabs value={props.engine} onValueChange={(value) => props.setEngine(value as AnalysisEngine)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="llm">LLM 实时标注</TabsTrigger>
              <TabsTrigger value="bert">BERT 外部推理</TabsTrigger>
            </TabsList>
          </Tabs>

          <ScaleSlider
            label={`帖子数 ${props.maxPosts}`}
            min={1}
            max={30}
            value={props.maxPosts}
            onChange={props.setMaxPosts}
          />
          <ScaleSlider
            label={`每帖评论 ${props.commentsPerPost}`}
            min={0}
            max={50}
            value={props.commentsPerPost}
            onChange={props.setCommentsPerPost}
          />

          {props.fixtureEnabled && (
            <div className="rounded-lg border border-dashed bg-muted/40 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">本地 fixture 演示模式</p>
                  <p className="text-muted-foreground text-xs">仅本地启用，线上不会自动使用演示数据。</p>
                </div>
                <Button
                  type="button"
                  variant={props.useFixture ? "default" : "outline"}
                  size="sm"
                  onClick={() => props.setUseFixture(!props.useFixture)}
                >
                  {props.useFixture ? "已启用" : "启用"}
                </Button>
              </div>
            </div>
          )}

          <Button className="h-11" disabled={props.isLoading || !props.keyword.trim()}>
            {props.isLoading ? (
              <>
                <Loader2 className="animate-spin" />
                分析中
              </>
            ) : (
              <>
                <Sparkles />
                开始分析
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function SessionPanel({
  isLoading,
  status,
  onRefresh,
  remoteLoginConfigured,
  adminToken,
  setAdminToken,
  isRemoteLoginLoading,
  remoteLoginMessage,
  remoteLoginProgress,
  remoteLoginScreenshot,
  remoteLoginQr,
  remoteLoginId,
  verificationCode,
  setVerificationCode,
  isLoginActionLoading,
  onStartRemoteLogin,
  onSubmitCode
}: {
  isLoading: boolean;
  status: SessionStatusResponse | null;
  onRefresh: () => void;
  remoteLoginConfigured: boolean;
  adminToken: string;
  setAdminToken: (value: string) => void;
  isRemoteLoginLoading: boolean;
  remoteLoginMessage: string;
  remoteLoginProgress: number;
  remoteLoginScreenshot: string;
  remoteLoginQr: string;
  remoteLoginId: string;
  verificationCode: string;
  setVerificationCode: (value: string) => void;
  isLoginActionLoading: boolean;
  onStartRemoteLogin: () => void;
  onSubmitCode: () => void;
}) {
  const hasSession = Boolean(status?.hasSession);
  const hasLoginError = status?.lastErrorCode === "login_required";
  const statusText = isLoading ? "检查中" : hasLoginError ? "登录失效" : hasSession ? "KV 已就绪" : "待上传";

  return (
    <Card className="border-dashed bg-muted/30 py-4 shadow-none">
      <CardContent className="grid gap-3 px-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">登录态管理</p>
            <p className="text-muted-foreground text-xs">优先使用 Cloudflare 远程扫码登录，确保登录态和抓取环境一致。</p>
          </div>
          <Badge variant={hasLoginError ? "destructive" : hasSession ? "default" : "outline"}>{statusText}</Badge>
        </div>
        <p className="text-muted-foreground text-xs leading-5">
          {status?.message || "正在检查 KV 中是否已有 xhs:storage_state 登录态。"}
        </p>
        {hasLoginError && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>登录态需要刷新</AlertTitle>
            <AlertDescription>
              {status?.lastAdvice || "Cloudflare 远程浏览器看到的是小红书登录页。请刷新远程登录态。"}
            </AlertDescription>
          </Alert>
        )}
        {status?.hasSession && (
          <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
            <SessionMetric label="Cookie" value={String(status.cookieCount ?? 0)} />
            <SessionMetric label="Origin" value={String(status.originCount ?? 0)} />
            <SessionMetric label="大小" value={formatBytes(status.storageBytes || 0)} />
            <SessionMetric
              label="最晚过期"
              value={status.latestCookieExpiry ? new Date(status.latestCookieExpiry).toLocaleDateString("zh-CN") : "未知"}
            />
          </div>
        )}
        <div className="grid gap-3 rounded-md border bg-background/70 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium">远程扫码刷新</p>
              <p className="text-muted-foreground mt-1 text-xs leading-5">
                启动 Cloudflare Browser Run 登录页，在这里扫码后直接保存远程浏览器登录态。
              </p>
            </div>
            <Badge variant={remoteLoginConfigured ? "secondary" : "outline"}>
              {remoteLoginConfigured ? "已配置口令" : "未配置口令"}
            </Badge>
          </div>
          {!remoteLoginConfigured && (
            <Alert>
              <KeyRound />
              <AlertTitle>需要配置管理员口令</AlertTitle>
              <AlertDescription>运行 `wrangler secret put LOGIN_ADMIN_TOKEN` 后重新部署，再使用网页登录。</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="admin-token">管理员口令</Label>
            <Input
              id="admin-token"
              type="password"
              value={adminToken}
              onChange={(event) => setAdminToken(event.target.value)}
              placeholder="输入 LOGIN_ADMIN_TOKEN"
              autoComplete="off"
              disabled={!remoteLoginConfigured || isRemoteLoginLoading}
            />
          </div>
          {(isRemoteLoginLoading || remoteLoginProgress > 0) && (
            <div className="grid gap-2">
              <Progress value={remoteLoginProgress} />
              <p className="text-muted-foreground text-xs leading-5">{remoteLoginMessage}</p>
            </div>
          )}
          {(remoteLoginScreenshot || remoteLoginQr) && (
            <div className="grid gap-3">
              {remoteLoginQr && (
                <div className="rounded-md border bg-muted/30 p-3">
                  <p className="mb-2 text-xs font-medium">二维码区域</p>
                  <img src={remoteLoginQr} alt="小红书远程登录二维码" className="mx-auto max-h-96 rounded-md object-contain" />
                </div>
              )}
              {remoteLoginScreenshot && (
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="mb-2 flex items-center gap-2 text-xs font-medium">
                    <Camera className="size-3.5" />
                    远程浏览器页面，大图可右键在新标签页打开
                  </div>
                  <a href={remoteLoginScreenshot} target="_blank" rel="noreferrer" className="block">
                    <img
                      src={remoteLoginScreenshot}
                      alt="Cloudflare 远程登录页截图"
                      className="max-h-[72vh] w-full rounded-md border object-contain"
                    />
                  </a>
                </div>
              )}
            </div>
          )}
          <Button
            type="button"
            size="sm"
            onClick={onStartRemoteLogin}
            disabled={!remoteLoginConfigured || !adminToken.trim() || isRemoteLoginLoading}
          >
            {isRemoteLoginLoading ? <Loader2 className="animate-spin" /> : <KeyRound />}
            {isRemoteLoginLoading ? "等待扫码" : "刷新远程登录态"}
          </Button>
          <div className="grid gap-2 rounded-md border bg-muted/20 p-3">
            <p className="text-xs font-medium">短信验证码</p>
            <p className="text-muted-foreground text-xs leading-5">
              验证码由小红书在扫码后自动发送。收到短信后填入验证码，系统会写入远程浏览器并尝试点击登录、确定或提交按钮。
            </p>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Input
                inputMode="numeric"
                pattern="[0-9]*"
                value={verificationCode}
                onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
                placeholder="输入短信验证码"
                disabled={!remoteLoginId || isLoginActionLoading}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={onSubmitCode}
                disabled={!remoteLoginId || !/^\d{4,8}$/.test(verificationCode) || isLoginActionLoading}
              >
                {isLoginActionLoading ? <Loader2 className="animate-spin" /> : null}
                填写并提交验证码
              </Button>
            </div>
          </div>
        </div>
        <div className="rounded-md border bg-background/70 p-3">
          <p className="text-xs font-medium">本地上传兜底</p>
          <p className="text-muted-foreground mt-1 text-xs leading-5">
            如果本地已经有 <code>sessions/xiaohongshu_storage_state.json</code>，只运行上传命令，不会打开浏览器窗口。
          </p>
          <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">npm run cf:upload-session</pre>
          <p className="text-muted-foreground mt-2 text-xs leading-5">
            只有本地文件不存在或登录态过期时，才需要手动运行 <code>python -m app login</code> 重新扫码。
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={isLoading}>
          {isLoading ? <Loader2 className="animate-spin" /> : <RefreshCcw />}
          {isLoading ? "检查中" : "检查 KV 状态"}
        </Button>
      </CardContent>
    </Card>
  );
}

function SessionMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background/70 p-2">
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-1 truncate font-medium">{value}</p>
    </div>
  );
}

function ScaleSlider({
  label,
  min,
  max,
  value,
  onChange
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="grid gap-3">
      <Label>{label}</Label>
      <Slider min={min} max={max} value={[value]} onValueChange={(items) => onChange(items[0] || min)} />
    </div>
  );
}

function ProgressPanel({
  progress,
  message,
  events
}: {
  progress: number;
  message: string;
  events: AnalysisStreamEvent[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Loader2 className="size-5 animate-spin text-primary" />
          分析进度
        </CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Progress value={progress} />
        <div className="grid gap-2 md:grid-cols-6">
          {(Object.keys(STAGE_META) as AnalysisStage[]).filter((stage) => stage !== "failed").map((stage) => {
            const active = events.some((event) => event.stage === stage);
            return (
              <div key={stage} className="rounded-lg border bg-muted/30 p-3">
                <CheckCircle2 className={active ? "mb-2 size-4 text-primary" : "text-muted-foreground mb-2 size-4"} />
                <p className="text-xs font-medium">{STAGE_META[stage].label}</p>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyReportPreview() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>报告预览</CardTitle>
        <CardDescription>开始分析后，这里会展示情绪分布、样本评论、帖子来源和诊断信息。</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </CardContent>
    </Card>
  );
}

function ReportDashboard({
  result,
  diagnostics,
  onExport
}: {
  result: AnalysisResponse;
  diagnostics?: AnalysisDiagnostics;
  onExport: (format: "json" | "csv" | "markdown") => void;
}) {
  const chartData = useMemo(
    () =>
      (["positive", "neutral", "negative"] as SentimentLabel[]).map((label) => ({
        label,
        name: LABEL_META[label].name,
        count: result.distribution[label].count,
        ratio: result.distribution[label].ratio,
        fill: LABEL_META[label].color
      })),
    [result]
  );
  const dominant = getDominantBucket(result.distribution);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="bg-card/70">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge>
                {result.sourceMode === "fixture"
                  ? "本地演示数据"
                  : result.sourceMode === "cache"
                    ? "缓存结果"
                    : result.sourceMode === "client"
                      ? "扩展采集"
                      : "实时抓取"}
              </Badge>
              <Badge variant="outline">{result.engine.toUpperCase()}</Badge>
              <Badge variant="outline">{new Date(result.capturedAt).toLocaleString("zh-CN")}</Badge>
            </div>
            <CardTitle className="text-3xl tracking-tight">
              “{result.keyword}”主要情绪：
              <span className="text-primary">{LABEL_META[dominant.label].name}</span>
            </CardTitle>
            <CardDescription className="max-w-4xl text-base leading-7">{result.summary}</CardDescription>
          </div>
          <ExportButtons onExport={onExport} />
        </div>
      </CardHeader>
      <CardContent className="grid gap-6 p-6">
        <div className="grid gap-4 md:grid-cols-3">
          <MetricCard label="帖子" value={result.totals.posts} icon={<FileText className="size-4" />} />
          <MetricCard label="评论" value={result.totals.comments} icon={<MessageCircle className="size-4" />} />
          <MetricCard label="有效样本" value={result.totals.validSamples} icon={<Database className="size-4" />} />
        </div>

        {result.warnings.length > 0 && (
          <Alert>
            <ShieldAlert />
            <AlertTitle>数据说明</AlertTitle>
            <AlertDescription>
              {result.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </AlertDescription>
          </Alert>
        )}

        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="overview">总览</TabsTrigger>
            <TabsTrigger value="samples">样本</TabsTrigger>
            <TabsTrigger value="posts">帖子</TabsTrigger>
            <TabsTrigger value="diagnostics">诊断</TabsTrigger>
            <TabsTrigger value="exports">导出</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)]">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="size-5 text-primary" />
                  情绪比例
                </CardTitle>
              </CardHeader>
              <CardContent>
                <SentimentPie data={chartData} />
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>情绪分布明细</CardTitle>
              </CardHeader>
              <CardContent>
                <SentimentBars data={chartData} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="samples" className="mt-4">
            <SampleList samples={result.samples} />
          </TabsContent>

          <TabsContent value="posts" className="mt-4">
            <PostTable posts={result.posts} />
          </TabsContent>

          <TabsContent value="diagnostics" className="mt-4">
            <DiagnosticsPanel diagnostics={diagnostics || result.diagnostics} />
          </TabsContent>

          <TabsContent value="exports" className="mt-4">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>导出报告</CardTitle>
                <CardDescription>用于论文附录、答辩记录或复现实验。</CardDescription>
              </CardHeader>
              <CardContent>
                <ExportButtons onExport={onExport} />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function SentimentPie({ data }: { data: Array<{ label: SentimentLabel; name: string; count: number; fill: string }> }) {
  const config = data.reduce((accumulator, item) => {
    accumulator[item.label] = { label: item.name, color: item.fill };
    return accumulator;
  }, {} as ChartConfig);

  return (
    <ChartContainer config={config} className="mx-auto h-72">
      <PieChart>
        <Tooltip content={<ChartTooltipContent />} />
        <Pie data={data} dataKey="count" nameKey="name" innerRadius={64} outerRadius={98} paddingAngle={4}>
          {data.map((entry) => (
            <Cell key={entry.label} fill={entry.fill} />
          ))}
        </Pie>
      </PieChart>
    </ChartContainer>
  );
}

function SentimentBars({ data }: { data: Array<{ label: SentimentLabel; name: string; count: number; ratio: number; fill: string }> }) {
  const config = data.reduce((accumulator, item) => {
    accumulator[item.label] = { label: item.name, color: item.fill };
    return accumulator;
  }, {} as ChartConfig);

  return (
    <div className="grid gap-4">
      <ChartContainer config={config} className="h-72">
        <BarChart data={data} layout="vertical" margin={{ left: 18, right: 20 }}>
          <XAxis type="number" hide />
          <YAxis dataKey="name" type="category" axisLine={false} tickLine={false} width={48} />
          <Tooltip content={<ChartTooltipContent />} />
          <Bar dataKey="count" radius={8}>
            {data.map((entry) => (
              <Cell key={entry.label} fill={entry.fill} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
      <div className="grid gap-3">
        {data.map((item) => (
          <div key={item.label} className="rounded-lg border p-3">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-medium">{item.name}</span>
              <span className="text-muted-foreground">{Math.round(item.ratio * 100)}%</span>
            </div>
            <Progress value={item.ratio * 100} />
            <p className="text-muted-foreground mt-2 text-xs">{LABEL_META[item.label].description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function SampleList({ samples }: { samples: LabeledSample[] }) {
  if (samples.length === 0) {
    return (
      <Alert>
        <AlertCircle />
        <AlertTitle>暂无样本</AlertTitle>
        <AlertDescription>本次没有可展示的代表评论。</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {(["positive", "neutral", "negative"] as SentimentLabel[]).map((label) => (
        <Card key={label} className="shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              {LABEL_META[label].name}
              <Badge variant="outline" className={LABEL_META[label].badgeClass}>
                {samples.filter((sample) => sample.label === label).length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-80 pr-3">
              <div className="grid gap-3">
                {samples
                  .filter((sample) => sample.label === label)
                  .map((sample) => (
                    <article key={sample.sampleId} className="rounded-lg border bg-background/70 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <Badge variant="outline" className={LABEL_META[sample.label].badgeClass}>
                          {Math.round(sample.confidence * 100)}%
                        </Badge>
                        <span className="text-muted-foreground truncate text-xs">{sample.captureSource}</span>
                      </div>
                      <p className="text-sm leading-6">{sample.text}</p>
                      <p className="text-muted-foreground mt-2 line-clamp-2 text-xs">
                        {sample.reasonShort} | {sample.postTitle}
                      </p>
                    </article>
                  ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function PostTable({ posts }: { posts: AnalysisResponse["posts"] }) {
  return (
    <Card className="shadow-none">
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>帖子</TableHead>
              <TableHead>评论数</TableHead>
              <TableHead>标签</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {posts.map((post) => (
              <TableRow key={post.postId}>
                <TableCell className="max-w-xl whitespace-normal">
                  <a href={post.url} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
                    {post.title || "未提取标题"}
                  </a>
                  <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">{post.description || "暂无正文摘要"}</p>
                </TableCell>
                <TableCell>{post.comments.length}</TableCell>
                <TableCell className="whitespace-normal">
                  <div className="flex flex-wrap gap-1">
                    {post.tags.slice(0, 4).map((tag) => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function DiagnosticsPanel({ diagnostics }: { diagnostics?: AnalysisDiagnostics }) {
  if (!diagnostics) {
    return (
      <Alert>
        <ShieldAlert />
        <AlertTitle>暂无诊断信息</AlertTitle>
        <AlertDescription>任务顺利完成或当前阶段尚未产生诊断数据。</AlertDescription>
      </Alert>
    );
  }

  const rows = [
    ["错误分类", diagnostics.errorCode || "无"],
    ["页面标题", diagnostics.pageTitle || "无"],
    ["页面 URL", diagnostics.pageUrl || "无"],
    ["是否登录门槛", diagnostics.hasLoginGate ? "是" : "否"],
    ["提取链接数", String(diagnostics.extractedLinkCount ?? "无")],
    ["Network Payload 数", String(diagnostics.networkPayloadCount ?? "无")],
    ["建议等待秒数", String(diagnostics.retryAfterSeconds ?? "无")],
    ["冷却截止时间", diagnostics.cooldownUntil ? new Date(diagnostics.cooldownUntil).toLocaleString("zh-CN") : "无"],
    ["建议", diagnostics.advice || "无"]
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle>抓取诊断</CardTitle>
          <CardDescription>用于定位登录态、页面结构、Browser Run 或评论提取问题。</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableBody>
              {rows.map(([label, value]) => (
                <TableRow key={label}>
                  <TableCell className="w-36 text-muted-foreground">{label}</TableCell>
                  <TableCell className="whitespace-normal break-all">{value}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle>页面摘要</CardTitle>
          <CardDescription>抓取失败时保留的页面文本证据。</CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-64 rounded-md border bg-muted/30 p-4">
            <pre className="whitespace-pre-wrap text-xs leading-5">{diagnostics.bodyExcerpt || "无页面摘要"}</pre>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

function ExportButtons({ onExport }: { onExport: (format: "json" | "csv" | "markdown") => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      <UiTooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" onClick={() => onExport("json")}>
            <FileJson />
            JSON
          </Button>
        </TooltipTrigger>
        <TooltipContent>完整结构化结果</TooltipContent>
      </UiTooltip>
      <Button variant="outline" size="sm" onClick={() => onExport("csv")}>
        <Download />
        CSV
      </Button>
      <Button variant="outline" size="sm" onClick={() => onExport("markdown")}>
        <FileText />
        Markdown
      </Button>
    </div>
  );
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-background/55 p-4">
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

function MetricCard({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <Card className="shadow-none">
      <CardContent className="flex items-center justify-between p-5">
        <div>
          <p className="text-muted-foreground text-sm">{label}</p>
          <p className="text-3xl font-semibold tracking-tight">{value}</p>
        </div>
        <div className="rounded-full bg-primary/10 p-3 text-primary">{icon}</div>
      </CardContent>
    </Card>
  );
}

function getDominantBucket(distribution: AnalysisResponse["distribution"]): SentimentBucket {
  return Object.values(distribution).sort((left, right) => right.count - left.count)[0];
}

function downloadText(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatStreamFailure(payload: AnalysisStreamEvent): string {
  if (payload.code === "browser_rate_limited") {
    return [payload.message, payload.diagnostics?.advice].filter(Boolean).join(" ");
  }
  const detail = payload.error && payload.error !== payload.message ? payload.error : "";
  return [payload.message, detail].filter(Boolean).join("：");
}

function buildCsv(result: AnalysisResponse): string {
  const rows = [
    ["sample_id", "post_id", "label", "confidence", "text", "reason", "post_title"],
    ...result.labeledSamples.map((sample) => [
      sample.sampleId,
      sample.postId,
      sample.label,
      String(sample.confidence),
      sample.text,
      sample.reasonShort,
      sample.postTitle
    ])
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function buildMarkdown(result: AnalysisResponse): string {
  const distributionRows = (["positive", "neutral", "negative"] as SentimentLabel[])
    .map((label) => {
      const bucket = result.distribution[label];
      return `| ${LABEL_META[label].name} | ${bucket.count} | ${Math.round(bucket.ratio * 100)}% | ${Math.round(
        bucket.averageConfidence * 100
      )}% |`;
    })
    .join("\n");
  const sampleRows = result.samples
    .map((sample) => `- **${LABEL_META[sample.label].name}** (${Math.round(sample.confidence * 100)}%): ${sample.text}`)
    .join("\n");
  return `# ${result.keyword} 舆情情绪报告

${result.summary}

## 情绪分布

| 情绪 | 数量 | 占比 | 平均置信度 |
| --- | ---: | ---: | ---: |
${distributionRows}

## 代表评论

${sampleRows || "暂无样本"}

## 数据说明

- 抓取时间：${new Date(result.capturedAt).toLocaleString("zh-CN")}
- 帖子数：${result.totals.posts}
- 评论数：${result.totals.comments}
- 模式：${result.sourceMode}
- 警告：${result.warnings.join("；") || "无"}
`;
}

export default App;
