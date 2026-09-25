import type { LlmDiagnostics } from "@/types/app";

type DiagnosableResult = {
  ok: boolean;
  message: string;
  model: string;
  latencyMs: number | null;
  diagnostics?: LlmDiagnostics | null;
  warnings?: string[];
};

function formatUsage(usage: LlmDiagnostics["usage"]) {
  if (!usage) return "—";
  const parts = [
    usage.promptTokens !== null ? `输入 ${usage.promptTokens}` : null,
    usage.completionTokens !== null ? `输出 ${usage.completionTokens}` : null,
    usage.reasoningTokens !== null ? `其中思考 ${usage.reasoningTokens}` : null,
    usage.totalTokens !== null ? `合计 ${usage.totalTokens}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/** 测试连接结果：结论 + 耗时 / HTTP 状态 / finish_reason / usage / 正文 / 原始响应（脱敏后前 2KB）。 */
export function LlmDiagnosticsView({ result, title }: { result: DiagnosableResult; title?: string }) {
  const diagnostics = result.diagnostics;
  return (
    <div className={`rounded-md border p-3 text-sm leading-6 ${result.ok ? "border-green-200 bg-green-50 text-green-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}>
      <div className="font-semibold">{title ? `${title}：` : ""}{result.message}</div>
      {result.warnings?.map((warning) => (
        <div key={warning} className="mt-1 text-xs font-semibold text-amber-700">{warning}</div>
      ))}
      {diagnostics ? (
        <>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-slate-700">
            <dt className="text-slate-500">模型</dt>
            <dd className="break-all">{result.model} · {diagnostics.apiFormat === "responses" ? "Responses API" : "Chat Completions"}{diagnostics.stream ? " · 流式" : ""}</dd>
            <dt className="text-slate-500">耗时</dt>
            <dd>{result.latencyMs === null ? "—" : `${result.latencyMs}ms`}</dd>
            <dt className="text-slate-500">HTTP 状态</dt>
            <dd>{diagnostics.httpStatus ?? "—"}</dd>
            <dt className="text-slate-500">finish_reason</dt>
            <dd>{diagnostics.finishReason ?? "—"}</dd>
            <dt className="text-slate-500">usage</dt>
            <dd>{formatUsage(diagnostics.usage)}</dd>
            <dt className="text-slate-500">正文</dt>
            <dd className="whitespace-pre-wrap break-all font-mono">{diagnostics.text || "（空）"}</dd>
          </dl>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs font-semibold text-slate-600">原始响应（前 2KB，已脱敏）</summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-2 font-mono text-[11px] leading-4 text-slate-700 ring-1 ring-slate-200">
              {diagnostics.rawBody || "（无响应体）"}
            </pre>
          </details>
        </>
      ) : (
        <div className="mt-1 text-xs opacity-80">{result.model} · {result.latencyMs === null ? "未发送请求" : `${result.latencyMs}ms`}</div>
      )}
    </div>
  );
}
