import { useMemo, useState } from "react";
import { AlertCircle, BarChart3, Database, Download, FileJson, FileText, MessageCircle, Radar, Upload } from "lucide-react";
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

const DEFAULT_WORKER_URL = "https://public-opinion-cloudflare.liuuhe.workers.dev";

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
  const [engine, setEngine] = useState<AnalysisEngine>("llm");
  const [maxPosts, setMaxPosts] = useState(10);
  const [commentsPerPost, setCommentsPerPost] = useState(30);
  const [workerUrl, setWorkerUrl] = useState(DEFAULT_WORKER_URL);
  const [jsonText, setJsonText] = useState("");
  const [result, setResult] = useState<AnalysisResponse | null>(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const collectCommand = `python -m app collect --keyword "${keyword}" --posts ${maxPosts} --comments ${commentsPerPost} --worker-url ${workerUrl} --engine ${engine}`;

  async function handleFileUpload(file: File | undefined) {
    if (!file) {
      return;
    }
    setJsonText(await file.text());
    setError("");
  }

  async function analyzeJson() {
    setError("");
    setIsLoading(true);
    try {
      const payload = JSON.parse(jsonText || "{}") as Partial<ClientCapturedAnalyzeRequest & AnalysisResponse>;
      if (isAnalysisResponse(payload)) {
        setResult(payload);
        return;
      }
      const requestPayload: ClientCapturedAnalyzeRequest = {
        keyword: String(payload.keyword || keyword),
        engine,
        maxPosts,
        commentsPerPost,
        pageUrl: String(payload.pageUrl || ""),
        posts: Array.isArray(payload.posts) ? payload.posts : []
      };
      const response = await fetch(`${apiBaseUrl(workerUrl)}/api/analyze/captured`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload)
      });
      const analysis = await response.json();
      if (!response.ok) {
        throw new Error([analysis.error, analysis.details].filter(Boolean).join("："));
      }
      setResult(analysis as AnalysisResponse);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "JSON 解析或分析失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function loadFixture() {
    setError("");
    setIsLoading(true);
    try {
      const response = await fetch(`${apiBaseUrl(workerUrl)}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword, engine, maxPosts, commentsPerPost, useFixture: true })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error([payload.error, payload.details].filter(Boolean).join("："));
      }
      setResult(payload as AnalysisResponse);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "演示数据加载失败");
    } finally {
      setIsLoading(false);
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

      <section className="grid gap-5 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <Card className="bg-card/90 backdrop-blur">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Radar className="size-5 text-primary" />
              本地 Playwright 采集
            </CardTitle>
            <CardDescription>登录、搜索、打开帖子和采集评论都在本机浏览器完成；Cloudflare 只负责情绪分析和报告展示。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <TextInput label="关键词" value={keyword} onChange={setKeyword} />
              <TextInput label="Worker 地址" value={workerUrl} onChange={setWorkerUrl} />
              <NumberInput label="帖子数" value={maxPosts} onChange={setMaxPosts} min={1} max={30} />
              <NumberInput label="每帖评论" value={commentsPerPost} onChange={setCommentsPerPost} min={0} max={80} />
            </div>
            <div className="grid gap-2">
              <Label>标注引擎</Label>
              <Tabs value={engine} onValueChange={(value) => setEngine(value as AnalysisEngine)}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="llm">LLM</TabsTrigger>
                  <TabsTrigger value="bert">BERT 外部推理</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div className="rounded-xl border bg-muted/30 p-4">
              <p className="text-sm font-medium">推荐流程</p>
              <ol className="text-muted-foreground mt-2 grid gap-1 text-sm leading-6">
                <li>1. 首次运行：<code>python -m app login</code></li>
                <li>2. 采集并分析：运行下面命令</li>
                <li>3. 把生成的 <code>data/reports/*-analysis.json</code> 上传到右侧查看报告</li>
              </ol>
              <pre className="mt-3 overflow-x-auto rounded-lg bg-background p-3 text-xs">{collectCommand}</pre>
            </div>
            <Button variant="outline" type="button" onClick={() => void loadFixture()} disabled={isLoading}>
              加载本地 fixture 演示报告
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="size-5 text-primary" />
              上传采集结果
            </CardTitle>
            <CardDescription>支持本地采集器生成的 capture JSON，或 Worker 返回的 analysis JSON。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Input type="file" accept="application/json,.json" onChange={(event) => void handleFileUpload(event.target.files?.[0])} />
            <textarea
              className="border-input bg-background min-h-64 rounded-md border p-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={jsonText}
              onChange={(event) => setJsonText(event.target.value)}
              placeholder="也可以直接粘贴 data/captures 或 data/reports 中的 JSON..."
            />
            <Button type="button" onClick={() => void analyzeJson()} disabled={isLoading || !jsonText.trim()}>
              {isLoading ? "处理中..." : "生成/查看报告"}
            </Button>
          </CardContent>
        </Card>
      </section>

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>处理失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!result && !isLoading && <EmptyReportPreview />}
      {isLoading && <Progress value={70} />}
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
            本机稳定采集，云端生成情绪报告。
          </CardTitle>
          <CardDescription className="mt-3 max-w-3xl text-sm leading-6">
            Playwright 在本机复用真实登录态完成搜索和评论采集；Cloudflare Worker 接收结构化 JSON，调用 LLM/BERT 推理并生成可导出的舆情报告。
          </CardDescription>
        </div>
        <div className="grid gap-2 sm:grid-cols-3 md:grid-cols-1">
          <MetricPill label="采集" value="本地 Playwright" />
          <MetricPill label="分析" value="Cloudflare Worker" />
          <MetricPill label="展示" value="网页报告" />
        </div>
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
        <CardDescription>上传采集 JSON 或加载 fixture 后，这里会展示情绪分布、样本评论和帖子来源。</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </CardContent>
    </Card>
  );
}

function ReportDashboard({ result, onExport }: { result: AnalysisResponse; onExport: (format: "json" | "csv" | "markdown") => void }) {
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
              <Badge>{result.sourceMode === "fixture" ? "fixture 演示" : "本地采集"}</Badge>
              <Badge variant="outline">{result.engine.toUpperCase()}</Badge>
              <Badge variant="outline">{new Date(result.capturedAt).toLocaleString("zh-CN")}</Badge>
            </div>
            <CardTitle className="text-3xl tracking-tight">
              “{result.keyword}”主要情绪：<span className="text-primary">{LABEL_META[dominant.label].name}</span>
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

function ExportButtons({ onExport }: { onExport: (format: "json" | "csv" | "markdown") => void }) {
  return (
    <div className="flex flex-wrap gap-2">
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

function isAnalysisResponse(value: Partial<AnalysisResponse>): value is AnalysisResponse {
  return Boolean(value && value.distribution && value.totals && value.labeledSamples);
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

function apiBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export default App;
