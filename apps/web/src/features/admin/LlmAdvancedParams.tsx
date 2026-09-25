import { useEffect, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { LlmModelParams } from "@/types/app";

export const defaultLlmModelParams: LlmModelParams = {
  apiFormat: "chat_completions",
  maxTokensField: "max_tokens",
  maxTokens: null,
  reasoningEffort: "omit",
  temperatureMode: "default",
  temperature: 0,
  jsonMode: "native",
  stream: false,
  extraBody: {},
  timeoutSeconds: null,
};

export function withLlmParamDefaults(value: Partial<LlmModelParams> | undefined): LlmModelParams {
  return { ...defaultLlmModelParams, ...(value ?? {}) };
}

function countChanged(value: LlmModelParams) {
  return (Object.keys(defaultLlmModelParams) as Array<keyof LlmModelParams>).filter((key) =>
    JSON.stringify(value[key]) !== JSON.stringify(defaultLlmModelParams[key])).length;
}

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/**
 * 「高级参数」折叠区：接口格式、输出上限、推理强度、temperature、JSON 输出、流式、额外请求体、超时。
 * 每一项都能选「不发送」，默认值与原来的请求一致。
 */
export function LlmAdvancedParams({
  value,
  disabled,
  onChange,
  budgetHint,
}: {
  value: LlmModelParams;
  disabled: boolean;
  onChange: (next: LlmModelParams) => void;
  /** 留空时使用的默认预算说明 */
  budgetHint: string;
}) {
  const [open, setOpen] = useState(false);
  const [extraBodyText, setExtraBodyText] = useState(() => stringifyExtraBody(value.extraBody));
  const [extraBodyError, setExtraBodyError] = useState<string | null>(null);
  const changed = countChanged(value);

  useEffect(() => {
    // 外部重置（保存后重新加载）时同步文本；编辑中的非法 JSON 不覆盖。
    if (!extraBodyError) setExtraBodyText(stringifyExtraBody(value.extraBody));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value.extraBody)]);

  const update = (patch: Partial<LlmModelParams>) => onChange({ ...value, ...patch });

  function updateExtraBody(text: string) {
    setExtraBodyText(text);
    if (!text.trim()) {
      setExtraBodyError(null);
      update({ extraBody: {} });
      return;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setExtraBodyError("必须是 JSON 对象，例如 {\"top_p\": 0.9}");
        return;
      }
      setExtraBodyError(null);
      update({ extraBody: parsed as Record<string, unknown> });
    } catch {
      setExtraBodyError("JSON 格式不正确，未生效");
    }
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-2 text-left"
      >
        <span className="text-sm font-medium text-slate-900">高级参数</span>
        <span className="flex items-center gap-2 text-xs text-slate-500">
          {changed > 0 ? `已调整 ${changed} 项` : "默认"}
          <ChevronDownIcon className={`size-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open ? (
        <div className="grid gap-3 border-t border-slate-200 p-3 md:grid-cols-2">
          <p className="text-xs text-slate-500 md:col-span-2">
            推理模型（如 gpt-5 系列）常需要：不发送 temperature、改用 max_completion_tokens 并调大输出上限。网关不认识某个参数时，把它设为「不发送」。
          </p>
          <label className="grid gap-1 text-sm font-medium">
            接口格式
            <Select value={value.apiFormat} disabled={disabled} onValueChange={(apiFormat) => update({ apiFormat: apiFormat as LlmModelParams["apiFormat"] })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="chat_completions">Chat Completions（/chat/completions）</SelectItem>
                <SelectItem value="responses">Responses API（/responses）</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            推理强度
            <Select value={value.reasoningEffort} disabled={disabled} onValueChange={(reasoningEffort) => update({ reasoningEffort: reasoningEffort as LlmModelParams["reasoningEffort"] })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="omit">不发送</SelectItem>
                <SelectItem value="minimal">minimal</SelectItem>
                <SelectItem value="low">low</SelectItem>
                <SelectItem value="medium">medium</SelectItem>
                <SelectItem value="high">high</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            输出上限字段
            <Select value={value.maxTokensField} disabled={disabled} onValueChange={(maxTokensField) => update({ maxTokensField: maxTokensField as LlmModelParams["maxTokensField"] })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="max_tokens">max_tokens</SelectItem>
                <SelectItem value="max_completion_tokens">max_completion_tokens</SelectItem>
                <SelectItem value="omit">不发送</SelectItem>
              </SelectContent>
            </Select>
            {value.apiFormat === "responses" && value.maxTokensField !== "omit" ? (
              <span className="text-xs font-normal text-slate-500">Responses API 下统一发送 max_output_tokens。</span>
            ) : null}
          </label>
          <label className="grid gap-1 text-sm font-medium">
            输出上限
            <Input
              type="number"
              min={1}
              value={value.maxTokens ?? ""}
              placeholder="留空用默认"
              disabled={disabled || value.maxTokensField === "omit"}
              onChange={(event) => update({ maxTokens: parseOptionalNumber(event.target.value) })}
            />
            <span className="text-xs font-normal text-slate-500">{budgetHint}</span>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            temperature
            <Select value={value.temperatureMode} disabled={disabled} onValueChange={(temperatureMode) => update({ temperatureMode: temperatureMode as LlmModelParams["temperatureMode"] })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="default">默认（各功能原有取值，通常为 0）</SelectItem>
                <SelectItem value="custom">自定义</SelectItem>
                <SelectItem value="omit">不发送</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            自定义 temperature
            <Input
              type="number"
              step="0.1"
              min={0}
              max={2}
              value={value.temperature}
              disabled={disabled || value.temperatureMode !== "custom"}
              onChange={(event) => update({ temperature: Math.max(0, Math.min(2, Number(event.target.value) || 0)) })}
            />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            JSON 输出
            <Select value={value.jsonMode} disabled={disabled} onValueChange={(jsonMode) => update({ jsonMode: jsonMode as LlmModelParams["jsonMode"] })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="native">response_format: json_object</SelectItem>
                <SelectItem value="prompt">不发送，改在提示词里要求 JSON</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            请求超时（秒）
            <Input
              type="number"
              min={5}
              max={600}
              value={value.timeoutSeconds ?? ""}
              placeholder="留空用各功能默认"
              disabled={disabled}
              onChange={(event) => update({ timeoutSeconds: parseOptionalNumber(event.target.value) })}
            />
          </label>
          <div className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 md:col-span-2">
            <div>
              <p className="text-sm font-medium text-slate-900">流式请求</p>
              <p className="text-xs text-slate-500">发送 stream: true，由服务端把流拼成完整响应。只有网关只支持流式时才需要打开。</p>
            </div>
            <Switch checked={value.stream} disabled={disabled} onCheckedChange={(stream) => update({ stream })} aria-label="流式请求" />
          </div>
          <label className="grid gap-1 text-sm font-medium md:col-span-2">
            额外请求体（JSON 对象，原样合并进请求）
            <Textarea
              className="min-h-20 font-mono text-xs"
              value={extraBodyText}
              disabled={disabled}
              placeholder={'例如 {"top_p": 0.9}'}
              onChange={(event) => updateExtraBody(event.target.value)}
            />
            {extraBodyError ? <span className="text-xs font-normal text-rose-600">{extraBodyError}</span> : null}
          </label>
        </div>
      ) : null}
    </div>
  );
}

function stringifyExtraBody(value: Record<string, unknown>) {
  return Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : "";
}
