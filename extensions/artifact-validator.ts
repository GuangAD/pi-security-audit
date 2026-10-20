/**
 * 产物契约校验:轻量 JSON Schema 子集校验器(零依赖,ADR-0004)。
 * 支持子集:type/required/properties/items/enum/pattern/minLength/maxLength/$ref(仅 #/$defs/... 内部引用)。
 * oracle:必须能应用 cs 原版 schema(spec「真实 schema 锚点」)。
 */
import fs from "node:fs";
import path from "node:path";

/** 单条违规:JSON 路径 + 原因 */
export interface ValidationError {
  path: string;
  message: string;
}

export type ValidationResult = { ok: true } | { ok: false; errors: ValidationError[] };

type Schema = Record<string, unknown>;

/** 校验异常:仅 schema 本身损坏(schemaPath 缺失等),数据问题一律走 ValidationResult */
export class SchemaLoadError extends Error {}

const schemaCache = new Map<string, Schema>();

/** 读 + 缓存 schema 文件;缺失/坏 JSON 抛 SchemaLoadError(调用方配置错误) */
export function loadSchema(schemaPath: string): Schema {
  const key = path.resolve(schemaPath);
  const cached = schemaCache.get(key);
  if (cached) return cached;
  let raw: string;
  try {
    raw = fs.readFileSync(key, "utf8");
  } catch (e) {
    throw new SchemaLoadError(`无法读取 schema 文件:${key}`, { cause: e });
  }
  let schema: Schema;
  try {
    schema = JSON.parse(raw) as Schema;
  } catch (e) {
    throw new SchemaLoadError(`schema 文件不是合法 JSON:${key}`, { cause: e });
  }
  schemaCache.set(key, schema);
  return schema;
}

/** $ref 解引用链深度上限(防构造 schema 打爆调用栈;自审 cand-01) */
const MAX_REF_DEPTH = 64;

/** 截断回显值(错误消息不携带完整不可信数据;自审 cand-03) */
function echo(value: unknown, max = 200): string {
  const s = JSON.stringify(value) ?? String(value);
  return s.length > max ? s.slice(0, max) + "…(截断)" : s;
}

/** 类型名 → 实际 JS 值判定(JSON Schema 类型语义) */
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true; // 未知类型名不拦(子集校验器不做过度承诺)
  }
}

/** 解析内部 $ref(仅支持 "#/$defs/Name" 与 "#/definitions/Name" 形式) */
function resolveRef(root: Schema, ref: string): Schema | null {
  const m = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref);
  if (!m) return null;
  const defs = root[m[1] === "$defs" ? "$defs" : "definitions"] as Record<string, Schema> | undefined;
  const target = defs?.[m[2]];
  return typeof target === "object" && target !== null ? target : null;
}

/** 递归校验:违规全部收集(path 为 JSON 路径;根为 "$") */
function validateNode(value: unknown, schema: Schema, root: Schema, path: string, errors: ValidationError[], seen: Set<string> = new Set(), depth = 0): void {
  // $ref 解引用:循环引用与超深链按结构违规处理,不递归打爆调用栈(自审 cand-01)
  if (typeof schema.$ref === "string") {
    const m2 = /^#\/($defs|definitions)\/([^/]+)$/.exec(schema.$ref);
    const refKey = m2 ? m2[1] + "/" + m2[2] : schema.$ref;
    if (m2 && seen.has(refKey)) {
      errors.push({ path, message: `循环 $ref(已在解引用链上): ${schema.$ref}` });
      return;
    }
    if (depth >= MAX_REF_DEPTH) {
      errors.push({ path, message: `$ref 链深超上限 ${MAX_REF_DEPTH}` });
      return;
    }
    const target = resolveRef(root, schema.$ref);
    if (target === null) {
      errors.push({ path, message: `校验器不支持的外部 $ref:${schema.$ref}` });
      return;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(refKey);
    validateNode(value, target, root, path, errors, nextSeen, depth + 1);
    return;
  }
  const type = schema.type;
  if (typeof type === "string" && !matchesType(value, type)) {
    errors.push({ path, message: `类型应为 ${type},实际 ${Array.isArray(value) ? "array" : typeof value}` });
    return;
  }
  if ("const" in schema && value !== schema.const) {
    errors.push({ path, message: `值必须为常量 ${JSON.stringify(schema.const)},实际 ${echo(value)}` });
    return;
  }
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.some((v) => v === value)) {
    errors.push({ path, message: `值 ${echo(value)} 不在枚举 [${enumValues.map((v) => JSON.stringify(v)).join(", ")}] 内` });
    return;
  }
  if (typeof value === "string") {
    const minLen = schema.minLength;
    if (typeof minLen === "number" && value.length < minLen) {
      errors.push({ path, message: `字符串长度 ${value.length} 小于 minLength ${minLen}` });
    }
    const maxLen = schema.maxLength;
    if (typeof maxLen === "number" && value.length > maxLen) {
      errors.push({ path, message: `字符串长度 ${value.length} 超过 maxLength ${maxLen}` });
    }
    const pattern = schema.pattern;
    if (typeof pattern === "string" && !new RegExp(pattern).test(value)) {
      errors.push({ path, message: `字符串不匹配 pattern ${pattern}` });
    }
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
    value.forEach((item, i) => validateNode(item, schema.items as Schema, root, `${path}[${i}]`, errors, seen, depth));
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (!(key in value)) errors.push({ path: `${path}.${key}`, message: "缺少必填字段" });
    }
    const props = schema.properties;
    if (props && typeof props === "object") {
      for (const [key, sub] of Object.entries(props as Record<string, Schema>)) {
        if (key in value) validateNode(value[key], sub, root, `${path}.${key}`, errors, seen, depth);
      }
    }
  }
}

/** 通用校验入口:doc 按 schema 校验,返回全部违规(空数组即通过) */
export function validateAgainstSchema(doc: unknown, schemaPath: string): ValidationResult {
  const schema = loadSchema(schemaPath);
  const errors: ValidationError[] = [];
  validateNode(doc, schema, schema, "$", errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** findings.json 契约校验(缺省 schema = 插件内 schemas/findings.schema.json) */
function pluginSchemaPath(name: string): string {
  // 自审 cand-05:dirname 缺失显式失败,不信任 CWD(被扫仓库可预置同名 schema 冒充契约)
  const dir = import.meta.dirname;
  if (!dir) throw new SchemaLoadError("无法定位插件 schemas 目录(import.meta.dirname 不可用)");
  return path.join(dir, "..", "schemas", name);
}

export function validateFindings(doc: unknown, schemaPath?: string): ValidationResult {
  return validateAgainstSchema(doc, schemaPath ?? pluginSchemaPath("findings.schema.json"));
}

/** coverage.json 契约校验(缺省 schema = 插件内 schemas/coverage.schema.json) */
export function validateCoverage(doc: unknown, schemaPath?: string): ValidationResult {
  return validateAgainstSchema(doc, schemaPath ?? pluginSchemaPath("coverage.schema.json"));
}
