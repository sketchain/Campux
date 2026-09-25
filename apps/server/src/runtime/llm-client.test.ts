import { describe, expect, test } from "bun:test";
import {
  LlmError,
  LLM_PROMPT_JSON_INSTRUCTION,
  assembleChatCompletionStream,
  assembleResponsesStream,
  buildLlmRequest,
  callLlm,
  classifyParsedResponse,
  describeHttpError,
  executeLlmRequest,
  extractContentText,
  extractFirstJsonObject,
  parseChatCompletionResponse,
  parseResponsesApiResponse,
  redactRawBody,
  type LlmCallRequest,
  type LlmEndpoint,
} from "./llm-client";
import { defaultLlmModelParams, normalizeLlmModelParams, type LlmModelParams } from "./llm-params";

const params = (patch: Partial<LlmModelParams> = {}): LlmModelParams => ({ ...defaultLlmModelParams, ...patch });
const endpoint = (patch: Partial<LlmModelParams> = {}): LlmEndpoint => ({
  baseUrl: "https://gw.example/v1/",
  model: "gpt-5.6-terra",
  apiKey: "sk-test-secret-key-123456",
  params: params(patch),
});
const request: LlmCallRequest = {
  messages: [
    { role: "system", content: "只返回 JSON。" },
    { role: "user", content: "hi" },
  ],
  json: true,
  defaults: { timeoutMs: 20_000, maxTokens: 500, temperature: 0 },
};

describe("buildLlmRequest — Chat Completions", () => {
  test("defaults reproduce the legacy request exactly", () => {
    const { url, body } = buildLlmRequest(endpoint(), request);
    expect(url).toBe("https://gw.example/v1/chat/completions");
    expect(body).toEqual({
      model: "gpt-5.6-terra",
      messages: request.messages,
      temperature: 0,
      max_tokens: 500,
      response_format: { type: "json_object" },
    });
  });

  test("calls without a legacy budget or JSON keep omitting them", () => {
    const { body } = buildLlmRequest(endpoint(), { ...request, json: false, defaults: { timeoutMs: 1, temperature: 0 } });
    expect(body).toEqual({ model: "gpt-5.6-terra", messages: request.messages, temperature: 0 });
  });

  test("max_completion_tokens, configured budget, reasoning effort, custom temperature, stream", () => {
    const { body } = buildLlmRequest(endpoint({
      maxTokensField: "max_completion_tokens",
      maxTokens: 4096,
      reasoningEffort: "low",
      temperatureMode: "custom",
      temperature: 0.7,
      stream: true,
    }), request);
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.max_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBe("low");
    expect(body.temperature).toBe(0.7);
    expect(body.stream).toBe(true);
  });

  test("every parameter can be omitted", () => {
    const { body } = buildLlmRequest(endpoint({ maxTokensField: "omit", maxTokens: 999, temperatureMode: "omit", jsonMode: "prompt" }), request);
    expect(Object.keys(body).sort()).toEqual(["messages", "model"]);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toBe(`只返回 JSON。\n\n${LLM_PROMPT_JSON_INSTRUCTION}`);
  });

  test("prompt JSON mode adds a system message when there is none", () => {
    const { body } = buildLlmRequest(endpoint({ jsonMode: "prompt" }), { ...request, messages: [{ role: "user", content: "hi" }] });
    expect((body.messages as Array<{ role: string; content: string }>)[0]).toEqual({ role: "system", content: LLM_PROMPT_JSON_INSTRUCTION });
  });

  test("extra body is merged last and can override", () => {
    const { body } = buildLlmRequest(endpoint({ extraBody: { top_p: 0.9, temperature: 1, metadata: { a: 1 } } }), request);
    expect(body.top_p).toBe(0.9);
    expect(body.temperature).toBe(1);
    expect(body.metadata).toEqual({ a: 1 });
  });
});

describe("buildLlmRequest — Responses API", () => {
  test("converts messages, budget, reasoning and JSON format", () => {
    const { url, body } = buildLlmRequest(endpoint({ apiFormat: "responses", reasoningEffort: "minimal", stream: true }), {
      ...request,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      ],
    });
    expect(url).toBe("https://gw.example/v1/responses");
    expect(body).toEqual({
      model: "gpt-5.6-terra",
      input: [
        { role: "system", content: "sys" },
        { role: "user", content: [{ type: "input_text", text: "看图" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
      ],
      temperature: 0,
      max_output_tokens: 500,
      reasoning: { effort: "minimal" },
      text: { format: { type: "json_object" } },
      stream: true,
    });
  });

  test("omit settings drop the Responses equivalents too", () => {
    const { body } = buildLlmRequest(endpoint({ apiFormat: "responses", maxTokensField: "omit", temperatureMode: "omit", jsonMode: "prompt" }), request);
    expect(Object.keys(body).sort()).toEqual(["input", "model"]);
  });
});

describe("response parsing", () => {
  test("string content", () => {
    expect(parseChatCompletionResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] })).toEqual({
      text: "ok",
      hasReasoning: false,
      finishReason: "stop",
      usage: null,
    });
  });

  test("array content joins text parts and skips reasoning parts", () => {
    expect(extractContentText([
      { type: "reasoning", text: "思考中……" },
      { type: "text", text: "{\"a\":" },
      { type: "output_text", text: "1}" },
      "!",
    ])).toEqual({ text: "{\"a\":1}!", hasReasoning: true });
  });

  test("reasoning_content is never treated as the answer", () => {
    const parsed = parseChatCompletionResponse({
      choices: [{ message: { content: "", reasoning_content: "让我想想" }, finish_reason: "stop" }],
    });
    expect(parsed?.text).toBe("");
    expect(parsed?.hasReasoning).toBe(true);
  });

  test("usage including reasoning tokens", () => {
    const parsed = parseChatCompletionResponse({
      choices: [{ message: { content: "x" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 32, total_tokens: 42, completion_tokens_details: { reasoning_tokens: 32 } },
    });
    expect(parsed?.usage).toEqual({ promptTokens: 10, completionTokens: 32, totalTokens: 42, reasoningTokens: 32 });
  });

  test("Responses API output", () => {
    const parsed = parseResponsesApiResponse({
      object: "response",
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "想法" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "{\"ok\":true}" }] },
      ],
      usage: { input_tokens: 5, output_tokens: 40, total_tokens: 45, output_tokens_details: { reasoning_tokens: 30 } },
    });
    expect(parsed).toEqual({
      text: "{\"ok\":true}",
      hasReasoning: true,
      finishReason: "completed",
      usage: { promptTokens: 5, completionTokens: 40, totalTokens: 45, reasoningTokens: 30 },
    });
  });

  test("Responses API incomplete by max_output_tokens maps to length", () => {
    const parsed = parseResponsesApiResponse({ object: "response", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "reasoning" }] });
    expect(parsed?.finishReason).toBe("length");
  });

  test("unrecognized structures return null", () => {
    expect(parseChatCompletionResponse({ result: "x" })).toBeNull();
    expect(parseChatCompletionResponse(null)).toBeNull();
    expect(parseResponsesApiResponse({ choices: [] })).toBeNull();
  });
});

describe("stream assembly", () => {
  test("Chat Completions SSE chunks are joined into one response", () => {
    const sse = [
      'data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"想"}}]}',
      'data: {"choices":[{"delta":{"content":"{\\"decision\\":"}}]}',
      'data: {"choices":[{"delta":{"content":"\\"approve\\"}"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":9,"total_tokens":12}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const parsed = parseChatCompletionResponse(assembleChatCompletionStream(sse));
    expect(parsed?.text).toBe("{\"decision\":\"approve\"}");
    expect(parsed?.hasReasoning).toBe(true);
    expect(parsed?.finishReason).toBe("stop");
    expect(parsed?.usage?.totalTokens).toBe(12);
  });

  test("Responses SSE prefers the completed response, falls back to deltas", () => {
    const completed = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"he"}',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"llo"}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"object":"response","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}],"usage":{"output_tokens":2}}}',
    ].join("\n\n");
    expect(parseResponsesApiResponse(assembleResponsesStream(completed))?.text).toBe("hello");

    const deltasOnly = 'data: {"type":"response.output_text.delta","delta":"a"}\n\ndata: {"type":"response.output_text.delta","delta":"b"}\n\n';
    expect(parseResponsesApiResponse(assembleResponsesStream(deltasOnly))?.text).toBe("ab");
  });
});

describe("extractFirstJsonObject", () => {
  test("handles code fences and surrounding text", () => {
    expect(extractFirstJsonObject("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(extractFirstJsonObject("结果如下：{\"a\":{\"b\":\"}\"}} 以上。另外 {\"c\":2}")).toEqual({ a: { b: "}" } });
  });

  test("skips broken fragments and returns the first complete object", () => {
    expect(extractFirstJsonObject("{broken {\"ok\":true}")).toEqual({ ok: true });
    expect(extractFirstJsonObject("没有 JSON")).toBeNull();
    expect(extractFirstJsonObject("[1,2]")).toBeNull();
  });
});

describe("error classification", () => {
  test("finish_reason length with empty body explains reasoning exhaustion", () => {
    const result = classifyParsedResponse({ text: "", hasReasoning: true, finishReason: "length", usage: { promptTokens: 20, completionTokens: 32, totalTokens: 52, reasoningTokens: 32 } }, true);
    expect(result.error?.kind).toBe("length_exhausted");
    expect(result.error?.message).toContain("输出上限被思考过程耗尽，请调大输出上限或降低推理强度");
    expect(result.error?.message).toContain("reasoning_tokens: 32");
  });

  test("empty body with reasoning, empty body, unrecognized, invalid JSON", () => {
    expect(classifyParsedResponse({ text: " ", hasReasoning: true, finishReason: "stop", usage: null }, false).error?.kind).toBe("reasoning_only");
    expect(classifyParsedResponse({ text: "", hasReasoning: false, finishReason: "stop", usage: null }, false).error?.kind).toBe("empty");
    expect(classifyParsedResponse(null, false).error?.kind).toBe("unrecognized");
    expect(classifyParsedResponse({ text: "好的", hasReasoning: false, finishReason: "stop", usage: null }, true).error?.kind).toBe("invalid_json");
    expect(classifyParsedResponse({ text: "好的", hasReasoning: false, finishReason: "stop", usage: null }, false)).toEqual({ error: null, json: null });
  });

  test("HTTP errors carry the gateway message", () => {
    expect(describeHttpError(400, '{"error":{"message":"Unsupported parameter: max_tokens"}}')).toBe("HTTP 400：Unsupported parameter: max_tokens");
    expect(describeHttpError(502, "<html>Bad Gateway</html>")).toBe("HTTP 502：<html>Bad Gateway</html>");
  });

  test("raw bodies are redacted before being shown", () => {
    const redacted = redactRawBody('{"echo":"sk-test-secret-key-123456","Authorization":"Bearer abcdefghijkl","other":"sk-abcdefghijklmnop"}', ["sk-test-secret-key-123456"]);
    expect(redacted).not.toContain("secret-key");
    expect(redacted).not.toContain("abcdefghijkl");
    expect(redacted.length).toBeLessThan(200);
    expect(redactRawBody("x".repeat(5_000), []).length).toBe(2_049);
  });
});

describe("executeLlmRequest", () => {
  const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

  test("successful JSON call returns text, json, usage and status", async () => {
    const report = await executeLlmRequest(endpoint(), request, json({
      choices: [{ message: { content: "```json\n{\"ok\":true}\n```" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }));
    expect(report.ok).toBe(true);
    expect(report.json).toEqual({ ok: true });
    expect(report.httpStatus).toBe(200);
    expect(report.finishReason).toBe("stop");
    expect(report.rawBody).toContain("choices");
  });

  test("reasoning model exhausting the budget reports length_exhausted", async () => {
    const report = await executeLlmRequest(endpoint(), request, json({
      choices: [{ message: { content: "" }, finish_reason: "length" }],
      usage: { completion_tokens: 32, completion_tokens_details: { reasoning_tokens: 32 } },
    }));
    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe("length_exhausted");
    expect(report.usage?.reasoningTokens).toBe(32);
  });

  test("HTTP errors and error payloads in 200 responses", async () => {
    const http = await executeLlmRequest(endpoint(), request, json({ error: { message: "invalid key sk-test-secret-key-123456" } }, 401));
    expect(http.error).toEqual({ kind: "http", message: "HTTP 401：invalid key sk-test-secret-key-123456" });
    expect(http.rawBody).not.toContain("secret-key");
    const inline = await executeLlmRequest(endpoint(), request, json({ error: { message: "upstream busy" } }));
    expect(inline.error?.kind).toBe("http");
  });

  test("timeouts and network failures are classified", async () => {
    const hanging = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const report = await executeLlmRequest({ ...endpoint(), params: params({ timeoutSeconds: null }) }, { ...request, defaults: { ...request.defaults, timeoutMs: 20 } }, hanging);
    expect(report.error?.kind).toBe("timeout");
    const network = await executeLlmRequest(endpoint(), request, async () => { throw new Error("ECONNREFUSED"); });
    expect(network.error).toEqual({ kind: "network", message: "网络请求失败：ECONNREFUSED" });
  });

  test("stream responses are assembled; Responses API is sent to /responses", async () => {
    let calledUrl = "";
    const sse = 'data: {"choices":[{"delta":{"content":"{\\"a\\":1}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const report = await executeLlmRequest(endpoint({ stream: true }), request, async (url) => {
      calledUrl = url;
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    expect(calledUrl).toBe("https://gw.example/v1/chat/completions");
    expect(report.json).toEqual({ a: 1 });

    const responses = await executeLlmRequest(endpoint({ apiFormat: "responses" }), request, async (url) => {
      calledUrl = url;
      return new Response(JSON.stringify({ object: "response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{\"b\":2}" }] }] }));
    });
    expect(calledUrl).toBe("https://gw.example/v1/responses");
    expect(responses.json).toEqual({ b: 2 });
  });

  test("callLlm throws LlmError with the report", async () => {
    const failing = callLlm(endpoint(), request, json({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }));
    await expect(failing).rejects.toBeInstanceOf(LlmError);
    await expect(failing).rejects.toMatchObject({ kind: "empty" });
  });
});

describe("normalizeLlmModelParams", () => {
  test("unknown values fall back to legacy-compatible defaults", () => {
    expect(normalizeLlmModelParams(undefined)).toEqual(defaultLlmModelParams);
    expect(normalizeLlmModelParams({ apiFormat: "grpc", maxTokensField: "tokens", reasoningEffort: "extreme", extraBody: [1] })).toEqual(defaultLlmModelParams);
  });

  test("keeps valid values and clamps numbers", () => {
    const normalized = normalizeLlmModelParams({
      apiFormat: "responses",
      maxTokensField: "omit",
      maxTokens: 1e9,
      reasoningEffort: "high",
      temperatureMode: "custom",
      temperature: 5,
      jsonMode: "prompt",
      stream: true,
      extraBody: { top_p: 1 },
      timeoutSeconds: 1,
    });
    expect(normalized).toEqual({
      apiFormat: "responses",
      maxTokensField: "omit",
      maxTokens: 200_000,
      reasoningEffort: "high",
      temperatureMode: "custom",
      temperature: 2,
      jsonMode: "prompt",
      stream: true,
      extraBody: { top_p: 1 },
      timeoutSeconds: 5,
    });
  });

  test("oversized extra body is dropped", () => {
    expect(normalizeLlmModelParams({ extraBody: { blob: "x".repeat(10_000) } }).extraBody).toEqual({});
  });
});
