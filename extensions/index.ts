/**
 * extensions/index.ts — pi-security-audit 装配层
 *
 * 注册薄工具(resolve_scan_model / validate_scan_artifacts——后者任务 3 加入)。
 * 设计原则(ADR-0004):代码只做「确定性计算」,方法论判断留给 agent 与 skills。
 * 所有失败以 isError 结果返回,不向模型抛裸异常;detail 文案原样透传。
 */
import { Type } from "typebox";

import { resolveScanModel } from "./scan-model.ts";

/** 文本内容块(pi 工具结果 content 的本包子集) */
interface TextBlock {
  type: "text";
  text: string;
}

interface ToolResult {
  content: TextBlock[];
  details: unknown;
  isError?: boolean;
}

/** 工具定义(TypeBox schema + execute;execute 签名见 pi 扩展文档) */
interface ToolDef {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    id: string,
    params: never,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: unknown,
  ) => Promise<ToolResult>;
}

/** 工厂内部使用的 pi 方法面(宿主 ExtensionAPI 的结构性投影) */
interface PiSurface {
  registerTool(def: ToolDef): void;
}

const resolveModelSchema = Type.Object({});

/** 注册薄工具(pi 插件入口,加载时被调用一次) */
export function registerSecurityAudit(pi: PiSurface): void {
  pi.registerTool({
    name: "resolve_scan_model",
    label: "解析扫描引擎模型",
    description:
      "解析安全审计的引擎模型(配置优先,回退会话模型;ADR-0003)。审计编排的派发前必调:ok 时用返回的 provider/model 派发 subagent;错误时向用户展示 detail 的补救指引,不得自行猜测模型。",
    parameters: resolveModelSchema,
    execute: async (_id, _params, _signal, _onUpdate, ctx) => {
      const model = (ctx as { model?: unknown } | undefined)?.model;
      const r = resolveScanModel(undefined, model as { provider?: string; id?: string } | null | undefined);
      const text = r.ok
        ? `引擎模型:${r.provider}/${r.model}(来源:${r.source === "config" ? "配置文件" : "会话模型"})`
        : `引擎模型解析失败:${r.detail}`;
      return { content: [{ type: "text", text }], details: r, isError: !r.ok };
    },
  });
}

export default function (pi: PiSurface): void {
  registerSecurityAudit(pi);
}
