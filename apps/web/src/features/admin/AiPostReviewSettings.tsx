import { useState } from "react";
import { DEFAULT_POST_REVIEW_PROMPT, POST_REVIEW_MAX_RETRIES_LIMIT, POST_REVIEW_PROMPT_MAX_LENGTH } from "@campux/domain";
import { KeyRoundIcon, RotateCcwIcon, TestTube2Icon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { LlmDiagnostics, LlmModelParams } from "@/types/app";
import { LlmAdvancedParams } from "./LlmAdvancedParams";
import { LlmDiagnosticsView } from "./LlmDiagnosticsView";

export type AiPostReviewForm = {
  postReviewEnabled: boolean;
  postReviewPrompt: string;
  postReviewMaxRetries: number;
  postReviewFallbackBaseUrl: string;
  postReviewFallbackModel: string;
  postReviewFallbackApiKey: string;
  postReviewFallbackClearApiKey: boolean;
  postReviewFallbackParams: LlmModelParams;
};

type PostReviewTestResult = {
  ok: boolean;
  target: "primary" | "fallback";
  model: string;
  latencyMs: number | null;
  message: string;
  diagnostics?: LlmDiagnostics | null;
  warnings?: string[];
};

/**
 * AI 设置页里的「自动审核」一块：开关、审核 prompt、重试次数、备用模型、连接测试。
 * 表单值随 LLM 设置一起保存；连接测试用当前未保存的表单值。
 */
export function AiPostReviewSettings<Form extends AiPostReviewForm>({
  form,
  fallbackKeyConfigured,
  disabled,
  buildTestPayload,
  onFormChange,
}: {
  form: Form;
  fallbackKeyConfigured: boolean;
  disabled: boolean;
  buildTestPayload: () => Record<string, unknown> | null;
  onFormChange: (form: Form) => void;
}) {
  const [testing, setTesting] = useState<"primary" | "fallback" | null>(null);
  const [results, setResults] = useState<PostReviewTestResult[]>([]);
  const busy = disabled || testing !== null;

  async function runTest(target: "primary" | "fallback") {
    const payload = buildTestPayload();
    if (!payload) return;
    setTesting(target);
    try {
      const response = await api<{ result: PostReviewTestResult }>("/api/admin/ai/post-review/test", {
        method: "POST",
        body: JSON.stringify({ ...payload, target }),
      });
      setResults((current) => [...current.filter((item) => item.target !== target), response.result]);
      if (response.result.ok) {
        toast.success(response.result.message);
      } else {
        toast.error(response.result.message);
      }
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "审核模型测试失败");
    } finally {
      setTesting(null);
    }
  }

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-900">自动审核</p>
          <p className="text-xs text-slate-500">新稿件由 AI 看图文判定：通过后直接发布，拒绝时私聊告知投稿人；AI 调用全部失败时转人工审核。</p>
        </div>
        <Switch
          checked={form.postReviewEnabled}
          disabled={busy}
          onCheckedChange={(checked) => onFormChange({ ...form, postReviewEnabled: checked })}
          aria-label="启用 AI 自动审核"
        />
      </div>

      <label className="mt-3 grid gap-1 text-sm font-medium">
        <span className="flex items-center justify-between gap-2">
          审核提示词
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || form.postReviewPrompt.trim() === DEFAULT_POST_REVIEW_PROMPT}
            onClick={() => onFormChange({ ...form, postReviewPrompt: DEFAULT_POST_REVIEW_PROMPT })}
          >
            <RotateCcwIcon data-icon="inline-start" />
            恢复默认
          </Button>
        </span>
        <Textarea
          className="min-h-32 font-mono text-xs"
          value={form.postReviewPrompt}
          disabled={busy}
          maxLength={POST_REVIEW_PROMPT_MAX_LENGTH}
          onChange={(event) => onFormChange({ ...form, postReviewPrompt: event.target.value })}
        />
        <span className="text-xs text-muted-foreground">只写判定标准即可，输出格式由系统固定追加；留空使用默认提示词（只拒绝血腥、暴力、恐怖）。</span>
      </label>

      <label className="mt-3 grid gap-1 text-sm font-medium md:max-w-60">
        失败重试次数
        <Input
          type="number"
          min={0}
          max={POST_REVIEW_MAX_RETRIES_LIMIT}
          value={form.postReviewMaxRetries}
          disabled={busy}
          onChange={(event) => onFormChange({ ...form, postReviewMaxRetries: Math.max(0, Math.min(POST_REVIEW_MAX_RETRIES_LIMIT, Math.trunc(Number(event.target.value) || 0))) })}
        />
        <span className="text-xs text-muted-foreground">主模型与备用模型各自按指数退避重试。</span>
      </label>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <p className="text-xs font-semibold text-slate-600 md:col-span-2">备用模型（主模型全部失败后使用，需支持看图，留空不启用）</p>
        <label className="grid gap-1 text-sm font-medium md:col-span-2">
          接口地址
          <Input
            value={form.postReviewFallbackBaseUrl}
            placeholder="https://api.example.com/v1"
            disabled={busy}
            onChange={(event) => onFormChange({ ...form, postReviewFallbackBaseUrl: event.target.value })}
          />
        </label>
        <label className="grid gap-1 text-sm font-medium">
          模型
          <Input
            value={form.postReviewFallbackModel}
            disabled={busy}
            onChange={(event) => onFormChange({ ...form, postReviewFallbackModel: event.target.value })}
          />
        </label>
        <label className="grid gap-1 text-sm font-medium">
          API 密钥
          <Input
            type="password"
            value={form.postReviewFallbackApiKey}
            placeholder={fallbackKeyConfigured && !form.postReviewFallbackClearApiKey ? "保持不变" : "未配置"}
            disabled={busy}
            onChange={(event) => onFormChange({ ...form, postReviewFallbackApiKey: event.target.value, postReviewFallbackClearApiKey: false })}
          />
        </label>
        <div className="md:col-span-2">
          <LlmAdvancedParams
            value={form.postReviewFallbackParams}
            disabled={busy}
            onChange={(postReviewFallbackParams) => onFormChange({ ...form, postReviewFallbackParams })}
            budgetHint="留空时审核沿用原预算 300；连接测试用 1024 并在超出审核预算时提醒。"
          />
        </div>
      </div>

      {results.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {results.map((result) => (
            <LlmDiagnosticsView key={result.target} result={result} title={result.target === "primary" ? "主模型" : "备用模型"} />
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {fallbackKeyConfigured && !form.postReviewFallbackClearApiKey ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onFormChange({ ...form, postReviewFallbackApiKey: "", postReviewFallbackClearApiKey: true })}>
            <KeyRoundIcon data-icon="inline-start" />
            清除备用密钥
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void runTest("primary")}>
          <TestTube2Icon data-icon="inline-start" />
          {testing === "primary" ? "测试中" : "测试主模型"}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void runTest("fallback")}>
          <TestTube2Icon data-icon="inline-start" />
          {testing === "fallback" ? "测试中" : "测试备用模型"}
        </Button>
      </div>
    </div>
  );
}
