import { useEffect, useMemo, useState, type DragEvent } from "react";
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  Database,
  Download,
  FileDown,
  FileJson,
  FileText,
  Lightbulb,
  MessageCircle,
  Radar,
  Terminal,
  Upload
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AnalysisEngine, AnalysisResponse, ClientCapturedAnalyzeRequest, LabeledSample, SentimentBucket, SentimentLabel } from "./shared/types";

const LLM_CHUNK_SIZE = 20;
const LLM_CHUNK_CONCURRENCY = 3;
const ESTIMATED_WAVE_SECONDS = 8;
const BERT_CHUNK_SIZE = 64;
const BERT_ESTIMATED_CHUNK_SECONDS = 14;
const BEST_MODEL_TEST_MACRO_F1 = "0.8295";
const ANALYSIS_REQUEST_TIMEOUT_MS = 150_000;
const BERT_WARMUP_TIMEOUT_MS = 90_000;
type ExportFormat = "json" | "csv" | "markdown" | "pdf";

type MediaCrawlerStatus = {
  running: boolean;
  status: "idle" | "running" | "completed" | "failed";
  keyword?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  error?: string;
  capturePath?: string;
  summary?: {
    posts: number;
    comments: number;
  };
  logs: string[];
};

const LABEL_META: Record<SentimentLabel, { name: string; description: string; color: string; badgeClass: string }> = {
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

function App() {
  const [keyword, setKeyword] = useState("咖啡");
  const [engine, setEngine] = useState<AnalysisEngine>("bert");
  const [maxPosts, setMaxPosts] = useState(10);
  const [commentsPerPost, setCommentsPerPost] = useState(30);
  const [jsonText, setJsonText] = useState("");
  const [result, setResult] = useState<AnalysisResponse | null>(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [processingStatus, setProcessingStatus] = useState("");
  const [processingProgress, setProcessingProgress] = useState(0);

  async function handleFileUpload(file: File | undefined) {
    if (!file) {
      return;
    }
    setJsonText(await file.text());
    setError("");
    setProcessingProgress(0);
    setProcessingStatus(`已载入 ${file.name}，点击“生成/查看报告”开始处理。`);
  }

  async function handleJsonDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) {
      await handleFileUpload(file);
    }
  }

  async function analyzeJson() {
    setError("");
    setProcessingStatus("");
    setProcessingProgress(5);
    setIsLoading(true);
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    try {
      const payload = JSON.parse(jsonText || "{}") as Partial<ClientCapturedAnalyzeRequest & AnalysisResponse>;
      if (isAnalysisResponse(payload)) {
        setProcessingProgress(100);
        setProcessingStatus(`已识别为分析报告 JSON，包含 ${payload.totals?.validSamples || 0} 条有效样本，正在直接渲染。`);
        setResult(payload);
        return;
      }
      const stats = summarizeCapturePayload(payload);
      const selectedEngine = engine;
      const initialProgress = estimateAnalysisProgress(selectedEngine, stats.comments, 0);
      setProcessingProgress(initialProgress.percent);
      setProcessingStatus(buildAnalysisProgressMessage(selectedEngine, stats, initialProgress, 0, "start"));

      if (selectedEngine === "bert") {
        try {
          setProcessingProgress(12);
          setProcessingStatus(`已识别为采集 JSON：${stats.posts} 篇帖子、${stats.comments} 条评论。正在检查本地 BERT，首次加载模型可能需要几十秒...`);
          await fetchWithTimeout(`${apiBaseUrl()}/api/bert/health`, BERT_WARMUP_TIMEOUT_MS);
        } catch {
          setProcessingStatus("本地 BERT 健康检查未及时返回，继续提交分析请求；如果模型正在加载，本次可能会稍慢。");
        }
      }

      const startedAt = Date.now();
      progressTimer = setInterval(() => {
        const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        const progress = estimateAnalysisProgress(selectedEngine, stats.comments, elapsed);
        setProcessingProgress(progress.percent);
        setProcessingStatus(buildAnalysisProgressMessage(selectedEngine, stats, progress, elapsed, "running"));
      }, 1000);
      const requestPayload: ClientCapturedAnalyzeRequest = {
        keyword: String(payload.keyword || keyword),
        engine: selectedEngine,
        maxPosts,
        commentsPerPost,
        pageUrl: String(payload.pageUrl || ""),
        posts: Array.isArray(payload.posts) ? payload.posts : []
      };
      const response = await fetchWithTimeout(`${apiBaseUrl()}/api/analyze/captured`, ANALYSIS_REQUEST_TIMEOUT_MS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload)
      });
      const analysis = await response.json();
      if (!response.ok) {
        throw new Error([analysis.error, analysis.details].filter(Boolean).join("："));
      }
      setProcessingProgress(100);
      setProcessingStatus(`分析完成：${analysis.totals?.validSamples || 0} 条有效样本。`);
      setResult(analysis as AnalysisResponse);
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === "AbortError") {
        setError("分析请求超过 150 秒仍未返回。若使用 BERT，这通常是本地模型首次加载或单批推理耗时过长；建议确认本地 BERT 仍在运行，或减少本次评论数。");
      } else {
        setError(requestError instanceof Error ? requestError.message : "JSON 解析或分析失败");
      }
    } finally {
      if (progressTimer) {
        clearInterval(progressTimer);
      }
      setIsLoading(false);
    }
  }

  async function loadFixture() {
    setError("");
    setProcessingProgress(30);
    setProcessingStatus("正在加载演示报告...");
    setIsLoading(true);
    try {
      const response = await fetch(`${apiBaseUrl()}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword, engine, maxPosts, commentsPerPost, useFixture: true })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error([payload.error, payload.details].filter(Boolean).join("："));
      }
      setProcessingProgress(100);
      setProcessingStatus("演示报告加载完成。");
      setResult(payload as AnalysisResponse);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "演示数据加载失败");
    } finally {
      setIsLoading(false);
    }
  }

  function exportReport(format: ExportFormat) {
    if (!result) {
      return;
    }
    if (format === "pdf") {
      printPdfReport(result);
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

      <section className="grid gap-5 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <MediaCrawlerPanel
          keyword={keyword}
          setKeyword={setKeyword}
          maxPosts={maxPosts}
          setMaxPosts={setMaxPosts}
          commentsPerPost={commentsPerPost}
          setCommentsPerPost={setCommentsPerPost}
          onCaptureLoaded={(captureText) => {
            setJsonText(captureText);
            setProcessingProgress(0);
            setProcessingStatus("MediaCrawler capture JSON 已载入，点击“生成/查看报告”即可用本地模型分析。");
          }}
        />

        <Card onDragOver={(event) => event.preventDefault()} onDrop={(event) => void handleJsonDrop(event)}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="size-5 text-primary" />
              导入或分析数据
            </CardTitle>
            <CardDescription>支持 MediaCrawler 转换出的 capture JSON，也支持已经生成的 analysis JSON。可选择文件、拖拽文件或直接粘贴。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <TextInput label="分析关键词" value={keyword} onChange={setKeyword} />
              <div className="grid gap-2">
                <Label>标注引擎</Label>
                <Tabs value={engine} onValueChange={(value) => setEngine(value as AnalysisEngine)}>
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="bert">本地 BERT</TabsTrigger>
                    <TabsTrigger value="llm">本地 LLM</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
            </div>
            <Input type="file" accept="application/json,.json" onChange={(event) => void handleFileUpload(event.target.files?.[0])} />
            <textarea
              className="border-input bg-background min-h-64 rounded-md border p-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={jsonText}
              onChange={(event) => setJsonText(event.target.value)}
              placeholder="粘贴 MediaCrawler capture JSON，或完整 analysis JSON..."
            />
            <Button type="button" onClick={() => void analyzeJson()} disabled={isLoading || !jsonText.trim()}>
              {isLoading ? "处理中..." : "生成/查看报告"}
            </Button>
            <Button variant="outline" type="button" onClick={() => void loadFixture()} disabled={isLoading}>
              加载演示报告
            </Button>
            {processingStatus && <p className="text-muted-foreground text-sm leading-6">{processingStatus}</p>}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <LocalRuntimePanel />
        <ModelBaselinePanel />
      </section>

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>处理失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!result && !isLoading && <EmptyReportPreview />}
      {isLoading && (
        <Card>
          <CardContent className="grid gap-3 p-4">
            <Progress value={processingProgress || 10} />
            {processingStatus && <p className="text-muted-foreground text-sm leading-6">{processingStatus}</p>}
          </CardContent>
        </Card>
      )}
      {result && <ReportDashboard result={result} onExport={exportReport} />}
    </main>
  );
}

function HeroCard() {
  return (
    <Card className="glass-panel overflow-hidden border-0">
      <CardContent className="grid gap-4 p-6 md:grid-cols-[minmax(0,1fr)_360px] md:items-center">
        <div>
          <Badge variant="outline" className="mb-4 w-fit border-primary/30 bg-background/60 text-primary">
            Xiaohongshu Opinion Radar
          </Badge>
          <CardTitle className="text-2xl leading-tight tracking-[-0.04em] md:text-3xl">
            本地采集、本地推理，生成小红书舆情报告。
          </CardTitle>
          <CardDescription className="mt-3 max-w-3xl text-sm leading-6">
            MediaCrawler 负责小红书采集，本机 BERT/LLM 负责情绪标注和报告生成。整个流程通过本地 WebUI 完成。
          </CardDescription>
        </div>
        <div className="grid gap-2 sm:grid-cols-3 md:grid-cols-1">
          <MetricPill label="采集" value="MediaCrawler" />
          <MetricPill label="分析" value="本地 BERT" />
          <MetricPill label="沉淀" value="PDF / JSON / CSV" />
        </div>
      </CardContent>
    </Card>
  );
}

function LocalRuntimePanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Terminal className="size-5 text-primary" />
          本地运行入口
        </CardTitle>
        <CardDescription>产品路径已经切到本地 WebUI；采集、分析和导出都在本机完成。</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 text-xs leading-6">
          <code>npm run local</code>
        </pre>
        <p className="text-muted-foreground text-sm leading-6">
          一键启动会构建前端、启动本地 BERT、启动本地 WebUI，并打开 <code>http://127.0.0.1:8788</code>。采集日志会显示在 MediaCrawler 面板中。
        </p>
      </CardContent>
    </Card>
  );
}

function ModelBaselinePanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckCircle2 className="size-5 text-primary" />
          当前模型基线
        </CardTitle>
        <CardDescription>当前最佳模型作为本地分析基线，后续新模型仍需超过冻结测试集基线才替换。</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="rounded-lg border bg-background/70 p-4">
          <p className="text-muted-foreground text-sm">当前最佳 test macro F1</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight">{BEST_MODEL_TEST_MACRO_F1}</p>
        </div>
        <p className="text-muted-foreground text-sm leading-6">
          最近的 LLM 预标注 v3 训练未超过该基线，因此不建议替换当前模型。下一轮模型优化应先提升标签质量，尤其是负向评论与中性评论的边界。
        </p>
      </CardContent>
    </Card>
  );
}

function MediaCrawlerPanel({
  keyword,
  setKeyword,
  maxPosts,
  setMaxPosts,
  commentsPerPost,
  setCommentsPerPost,
  onCaptureLoaded
}: {
  keyword: string;
  setKeyword: (value: string) => void;
  maxPosts: number;
  setMaxPosts: (value: number) => void;
  commentsPerPost: number;
  setCommentsPerPost: (value: number) => void;
  onCaptureLoaded: (captureText: string) => void;
}) {
  const [headless, setHeadless] = useState(false);
  const [status, setStatus] = useState<MediaCrawlerStatus>({ running: false, status: "idle", logs: [] });
  const [collectorError, setCollectorError] = useState("");

  useEffect(() => {
    if (!status.running) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshStatus();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [status.running]);

  async function refreshStatus() {
    const response = await fetch(`${apiBaseUrl()}/api/mediacrawler/status`);
    const payload = (await response.json()) as MediaCrawlerStatus;
    setStatus(payload);
  }

  async function startCollection() {
    setCollectorError("");
    try {
      const response = await fetch(`${apiBaseUrl()}/api/mediacrawler/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword, maxPosts, commentsPerPost, headless })
      });
      const payload = (await response.json()) as MediaCrawlerStatus & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "MediaCrawler 启动失败");
      }
      setStatus(payload);
    } catch (error) {
      setCollectorError(error instanceof Error ? error.message : "MediaCrawler 启动失败");
    }
  }

  async function loadCapture() {
    if (!status.capturePath) {
      return;
    }
    setCollectorError("");
    try {
      const response = await fetch(`${apiBaseUrl()}/api/mediacrawler/capture?path=${encodeURIComponent(status.capturePath)}`);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "读取 capture JSON 失败");
      }
      onCaptureLoaded(JSON.stringify(payload, null, 2));
    } catch (error) {
      setCollectorError(error instanceof Error ? error.message : "读取 capture JSON 失败");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Terminal className="size-5 text-primary" />
          MediaCrawler 采集
        </CardTitle>
        <CardDescription>直接从本地 WebUI 启动 vendored MediaCrawler，完成后自动转换成报告可用的 capture JSON。</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="关键词" value={keyword} onChange={setKeyword} />
          <NumberInput label="帖子数" value={maxPosts} onChange={setMaxPosts} min={1} max={50} />
          <NumberInput label="每帖评论" value={commentsPerPost} onChange={setCommentsPerPost} min={0} max={300} />
          <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <input type="checkbox" checked={headless} onChange={(event) => setHeadless(event.target.checked)} />
            无头模式
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => void startCollection()} disabled={status.running}>
            {status.running ? "采集中..." : "开始采集"}
          </Button>
          <Button type="button" variant="outline" onClick={() => void refreshStatus()}>
            刷新日志
          </Button>
          <Button type="button" variant="outline" onClick={() => void loadCapture()} disabled={!status.capturePath}>
            载入结果
          </Button>
        </div>
        {collectorError && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>采集失败</AlertTitle>
            <AlertDescription>{collectorError}</AlertDescription>
          </Alert>
        )}
        <div className="rounded-lg border bg-background/70 p-3 text-sm">
          <p className="font-medium">
            状态：{status.status}
            {status.summary ? `，${status.summary.posts} 篇帖子 / ${status.summary.comments} 条评论` : ""}
          </p>
          {status.capturePath && <p className="text-muted-foreground mt-1 break-all text-xs">{status.capturePath}</p>}
        </div>
        <ScrollArea className="h-48 rounded-lg border bg-muted/30 p-3">
          <pre className="whitespace-pre-wrap text-xs leading-5">{status.logs.length ? status.logs.join("\n") : "等待采集任务..."}</pre>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function TextInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <Input value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function NumberInput({ label, value, onChange, min, max }: { label: string; value: number; onChange: (value: number) => void; min: number; max: number }) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <Input type="number" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value) || min)} />
    </div>
  );
}

function EmptyReportPreview() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>报告预览</CardTitle>
        <CardDescription>采集或导入 capture JSON 后，这里会展示摘要、关键发现、情绪分布、样本评论和帖子来源。</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </CardContent>
    </Card>
  );
}

function ReportDashboard({ result, onExport }: { result: AnalysisResponse; onExport: (format: ExportFormat) => void }) {
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
  const report = result.report;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="bg-card/70">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge>{result.sourceMode === "fixture" ? "fixture 演示" : "本地采集"}</Badge>
              <Badge variant="outline">{result.engine.toUpperCase()}</Badge>
              <Badge variant="outline">{new Date(result.capturedAt).toLocaleString("zh-CN")}</Badge>
            </div>
            <CardTitle className="text-3xl tracking-tight">
              {report?.headline || `“${result.keyword}”主要情绪：${LABEL_META[dominant.label].name}`}
            </CardTitle>
            <CardDescription className="max-w-4xl text-base leading-7">{report?.executiveSummary || result.summary}</CardDescription>
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

        {report && <ReportInsights report={report} />}

        {result.warnings.length > 0 && (
          <Alert>
            <AlertCircle />
            <AlertTitle>数据说明</AlertTitle>
            <AlertDescription>
              {result.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </AlertDescription>
          </Alert>
        )}

        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="overview">总览</TabsTrigger>
            <TabsTrigger value="samples">样本</TabsTrigger>
            <TabsTrigger value="posts">帖子</TabsTrigger>
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

function ReportInsights({ report }: { report: AnalysisResponse["report"] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lightbulb className="size-5 text-primary" />
            关键发现
          </CardTitle>
          <CardDescription>{report.dataQuality.message}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {report.keyFindings.map((item) => (
            <article key={`${item.title}-${item.detail}`} className="rounded-lg border bg-background/70 p-4">
              <Badge variant="outline" className={insightBadgeClass(item.tone)}>
                {item.title}
              </Badge>
              <p className="mt-3 text-sm leading-6">{item.detail}</p>
            </article>
          ))}
        </CardContent>
      </Card>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-primary" />
            建议动作
          </CardTitle>
          <CardDescription>按当前样本直接生成，适合阶段性复盘。</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-3">
            {report.recommendedActions.map((action, index) => (
              <li key={action} className="rounded-lg border bg-background/70 p-3 text-sm leading-6">
                <span className="mr-2 font-semibold text-primary">{index + 1}.</span>
                {action}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
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
                      <Badge variant="outline" className={LABEL_META[sample.label].badgeClass}>
                        {Math.round(sample.confidence * 100)}%
                      </Badge>
                      <p className="mt-2 text-sm leading-6">{sample.text}</p>
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

function ExportButtons({ onExport }: { onExport: (format: ExportFormat) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => onExport("pdf")}>
        <FileDown />
        PDF
      </Button>
      <Button variant="outline" size="sm" onClick={() => onExport("json")}>
        <FileJson />
        JSON
      </Button>
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

function insightBadgeClass(tone: AnalysisResponse["insights"][number]["tone"]) {
  if (tone === "positive") {
    return LABEL_META.positive.badgeClass;
  }
  if (tone === "negative") {
    return LABEL_META.negative.badgeClass;
  }
  if (tone === "neutral") {
    return LABEL_META.neutral.badgeClass;
  }
  return "bg-blue-100 text-blue-800 border-blue-200";
}

function isAnalysisResponse(value: Partial<AnalysisResponse>): value is AnalysisResponse {
  return Boolean(value && value.distribution && value.totals && value.labeledSamples);
}

function summarizeCapturePayload(value: Partial<ClientCapturedAnalyzeRequest & AnalysisResponse>) {
  const posts = Array.isArray(value.posts) ? value.posts : [];
  return {
    posts: posts.length,
    comments: posts.reduce((sum, post) => sum + (Array.isArray(post.comments) ? post.comments.length : 0), 0)
  };
}

function estimateAnalysisProgress(engine: AnalysisEngine, totalComments: number, elapsedSeconds: number) {
  return engine === "bert" ? estimateBertAnalysisProgress(totalComments, elapsedSeconds) : estimateLlmAnalysisProgress(totalComments, elapsedSeconds);
}

function estimateLlmAnalysisProgress(totalComments: number, elapsedSeconds: number) {
  const safeTotal = Math.max(0, totalComments);
  const totalBatches = Math.max(1, Math.ceil(safeTotal / LLM_CHUNK_SIZE));
  const totalWaves = Math.max(1, Math.ceil(totalBatches / LLM_CHUNK_CONCURRENCY));
  const currentWave = Math.min(totalWaves, Math.floor(elapsedSeconds / ESTIMATED_WAVE_SECONDS) + 1);
  const startBatch = (currentWave - 1) * LLM_CHUNK_CONCURRENCY + 1;
  const endBatch = Math.min(totalBatches, currentWave * LLM_CHUNK_CONCURRENCY);
  const startComment = safeTotal === 0 ? 0 : (startBatch - 1) * LLM_CHUNK_SIZE + 1;
  const endComment = Math.min(safeTotal, endBatch * LLM_CHUNK_SIZE);
  const percent = Math.min(95, Math.max(8, Math.round((currentWave / totalWaves) * 90)));
  return {
    totalBatches,
    startBatch,
    endBatch,
    startComment,
    endComment,
    percent
  };
}

function estimateBertAnalysisProgress(totalComments: number, elapsedSeconds: number) {
  const safeTotal = Math.max(0, totalComments);
  const totalBatches = Math.max(1, Math.ceil(safeTotal / BERT_CHUNK_SIZE));
  const currentBatch = Math.min(totalBatches, Math.floor(elapsedSeconds / BERT_ESTIMATED_CHUNK_SECONDS) + 1);
  const startComment = safeTotal === 0 ? 0 : (currentBatch - 1) * BERT_CHUNK_SIZE + 1;
  const endComment = Math.min(safeTotal, currentBatch * BERT_CHUNK_SIZE);
  const percent = Math.min(95, Math.max(12, Math.round((currentBatch / totalBatches) * 86)));
  return {
    totalBatches,
    startBatch: currentBatch,
    endBatch: currentBatch,
    startComment,
    endComment,
    percent
  };
}

function buildAnalysisProgressMessage(
  engine: AnalysisEngine,
  stats: { posts: number; comments: number },
  progress: ReturnType<typeof estimateAnalysisProgress>,
  elapsedSeconds: number,
  phase: "start" | "running"
) {
  if (engine === "bert") {
    if (phase === "start") {
      return `已识别为采集 JSON：${stats.posts} 篇帖子、${stats.comments} 条评论。本地 BERT 会按约 ${BERT_CHUNK_SIZE} 条一批推理。`;
    }
    return `本地 BERT 正在推理，预计处理第 ${progress.startComment}-${progress.endComment} 条评论（第 ${progress.startBatch}/${progress.totalBatches} 批）。首次加载模型可能较慢，已等待 ${elapsedSeconds} 秒。`;
  }
  if (phase === "start") {
    return `已识别为采集 JSON：${stats.posts} 篇帖子、${stats.comments} 条评论，共 ${progress.totalBatches} 批。正在交给本地 LLM 分析...`;
  }
  return `本地 LLM 正在分析，预计处理第 ${progress.startComment}-${progress.endComment} 条评论（第 ${progress.startBatch}-${progress.endBatch}/${progress.totalBatches} 批，最多 ${LLM_CHUNK_CONCURRENCY} 批并发），已等待 ${elapsedSeconds} 秒。`;
}

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
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

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char] || char);
}

function printPdfReport(result: AnalysisResponse) {
  const printWindow = window.open("", "_blank", "width=960,height=1200");
  if (!printWindow) {
    return;
  }
  printWindow.document.open();
  printWindow.document.write(buildPrintableHtml(result));
  printWindow.document.close();
  printWindow.focus();
  window.setTimeout(() => {
    printWindow.print();
  }, 250);
}

function buildPrintableHtml(result: AnalysisResponse): string {
  const report = result.report;
  const distributionRows = (["positive", "neutral", "negative"] as SentimentLabel[])
    .map((label) => {
      const bucket = result.distribution[label];
      return `<tr><td>${LABEL_META[label].name}</td><td>${bucket.count}</td><td>${Math.round(bucket.ratio * 100)}%</td><td>${Math.round(
        bucket.averageConfidence * 100
      )}%</td></tr>`;
    })
    .join("");
  const findingRows = (report?.keyFindings || result.insights || [])
    .map((item) => `<li><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></li>`)
    .join("");
  const actionRows = (report?.recommendedActions || [])
    .map((action, index) => `<li><strong>${index + 1}.</strong><span>${escapeHtml(action)}</span></li>`)
    .join("");
  const sampleRows = result.samples
    .slice(0, 24)
    .map(
      (sample) => `<article>
        <div><strong>${LABEL_META[sample.label].name}</strong><span>${Math.round(sample.confidence * 100)}%</span></div>
        <p>${escapeHtml(sample.text)}</p>
        <small>${escapeHtml(sample.reasonShort)} | ${escapeHtml(sample.postTitle)}</small>
      </article>`
    )
    .join("");
  const postRows = result.posts
    .slice(0, 30)
    .map(
      (post) => `<tr>
        <td>${escapeHtml(post.title || "未提取标题")}</td>
        <td>${post.comments.length}</td>
        <td>${escapeHtml(post.tags.slice(0, 4).join("、") || "-")}</td>
      </tr>`
    )
    .join("");
  const warnings = result.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(result.report?.headline || `${result.keyword} 舆情情绪报告`)}</title>
  <style>
    @page { size: A4; margin: 16mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #17202a;
      background: #fff;
      font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", Arial, sans-serif;
      font-size: 12px;
      line-height: 1.65;
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 25px; line-height: 1.28; }
    h2 { margin: 22px 0 10px; font-size: 16px; border-bottom: 1px solid #d9e2ec; padding-bottom: 5px; }
    h3 { font-size: 13px; }
    .meta { margin-top: 10px; color: #52616f; display: flex; flex-wrap: wrap; gap: 8px; }
    .pill { border: 1px solid #d9e2ec; border-radius: 999px; padding: 2px 8px; }
    .summary { margin-top: 14px; padding: 12px; background: #f5f7fa; border: 1px solid #d9e2ec; border-radius: 8px; }
    .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 16px; }
    .metric { border: 1px solid #d9e2ec; border-radius: 8px; padding: 10px; }
    .metric span { color: #52616f; display: block; }
    .metric strong { font-size: 20px; display: block; margin-top: 3px; }
    table { width: 100%; border-collapse: collapse; page-break-inside: avoid; }
    th, td { border: 1px solid #d9e2ec; padding: 7px; text-align: left; vertical-align: top; }
    th { background: #f5f7fa; }
    ul, ol { margin: 0; padding-left: 18px; }
    li { margin: 5px 0; }
    li span { display: block; }
    .samples { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    article { border: 1px solid #d9e2ec; border-radius: 8px; padding: 8px; page-break-inside: avoid; }
    article div { display: flex; justify-content: space-between; color: #0f766e; }
    article p { margin-top: 6px; }
    article small { display: block; margin-top: 6px; color: #52616f; }
    .footer { margin-top: 22px; color: #697586; font-size: 10px; }
    @media print {
      body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .samples { grid-template-columns: 1fr 1fr; }
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(report?.headline || `${result.keyword} 舆情情绪报告`)}</h1>
  <div class="meta">
    <span class="pill">关键词：${escapeHtml(result.keyword)}</span>
    <span class="pill">引擎：${escapeHtml(result.engine.toUpperCase())}</span>
    <span class="pill">时间：${escapeHtml(new Date(result.capturedAt).toLocaleString("zh-CN"))}</span>
    <span class="pill">来源：${escapeHtml(result.sourceMode)}</span>
  </div>
  <p class="summary">${escapeHtml(report?.executiveSummary || result.summary)}</p>

  <section class="metrics">
    <div class="metric"><span>帖子</span><strong>${result.totals.posts}</strong></div>
    <div class="metric"><span>评论</span><strong>${result.totals.comments}</strong></div>
    <div class="metric"><span>有效样本</span><strong>${result.totals.validSamples}</strong></div>
  </section>

  <h2>关键发现</h2>
  <ul>${findingRows || "<li>暂无关键发现</li>"}</ul>

  <h2>建议动作</h2>
  <ol>${actionRows || "<li>暂无建议动作</li>"}</ol>

  <h2>情绪分布</h2>
  <table>
    <thead><tr><th>情绪</th><th>数量</th><th>占比</th><th>平均置信度</th></tr></thead>
    <tbody>${distributionRows}</tbody>
  </table>

  <h2>代表评论</h2>
  <div class="samples">${sampleRows || "<p>暂无样本</p>"}</div>

  <h2>帖子来源</h2>
  <table>
    <thead><tr><th>帖子</th><th>评论数</th><th>标签</th></tr></thead>
    <tbody>${postRows || "<tr><td colspan='3'>暂无帖子</td></tr>"}</tbody>
  </table>

  <h2>数据说明</h2>
  <p>${escapeHtml(report?.dataQuality?.message || "未提供")}</p>
  ${warnings ? `<ul>${warnings}</ul>` : ""}

  <p class="footer">由 Xiaohongshu Opinion Radar 生成。PDF 导出使用浏览器打印功能。</p>
</body>
</html>`;
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
  const findingRows = (result.report?.keyFindings || result.insights || [])
    .map((item) => `- **${item.title}**：${item.detail}`)
    .join("\n");
  const actionRows = (result.report?.recommendedActions || [])
    .map((action, index) => `${index + 1}. ${action}`)
    .join("\n");
  return `# ${result.report?.headline || `${result.keyword} 舆情情绪报告`}

${result.report?.executiveSummary || result.summary}

## 关键发现

${findingRows || "暂无关键发现"}

## 建议动作

${actionRows || "暂无建议动作"}

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
- 数据质量：${result.report?.dataQuality.message || "未提供"}
- 警告：${result.warnings.join("；") || "无"}
`;
}

function apiBaseUrl(): string {
  return window.location.origin.replace(/\/+$/, "");
}

export default App;
