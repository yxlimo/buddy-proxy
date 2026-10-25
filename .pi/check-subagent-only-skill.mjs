#!/usr/bin/env node
// .pi/check-subagent-only-skill.mjs — 校验「pi 启动时加载 skill，主 agent 不可见，只有 subagent 能用」。
//
//   node .pi/check-subagent-only-skill.mjs
//
// 不调模型，只走真实代码路径：
//   1. pi 的 skill 加载器（loadSkills）在项目里发现 hello_js_reverse_skill；
//   2. 项目扩展在 before_agent_start 里把它从 systemPromptOptions.skills 剔除；
//   3. pi 的提示词渲染（formatSkillsForPrompt）里不再出现该 skill；
//   4. pi-subagents 按 .pi/agents/js-reverse.md 的 skills + skillPath 解析到同一个 skill，
//      并把技能注入子代理提示词。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SKILL_NAME = "hello_js_reverse_skill";
const AGENT_FILE = path.join(ROOT, ".pi", "agents", "js-reverse.md");

let failed = 0;

function ok(message) {
  console.log(`  ok   ${message}`);
}

function fail(message) {
  failed++;
  console.error(`  FAIL ${message}`);
}

function check(name, condition, detail = "") {
  if (condition) ok(name);
  else fail(`${name}${detail ? ` — ${detail}` : ""}`);
}

/** 找到本机 pi 的安装包（受管安装：~/.pi/agent/install/releases/<version>）。 */
function resolvePiRoot() {
  const agentDir = path.join(os.homedir(), ".pi", "agent");
  const versionFile = path.join(agentDir, "install", "current-version");
  if (!fs.existsSync(versionFile)) return undefined;
  const version = fs.readFileSync(versionFile, "utf8").trim();
  const root = path.join(agentDir, "install", "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
  return fs.existsSync(path.join(root, "dist", "index.js")) ? root : undefined;
}

function resolveSubagentsRoot() {
  const root = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents");
  return fs.existsSync(path.join(root, "src", "agents", "skills.js")) ? root : undefined;
}

const piRoot = resolvePiRoot();
const subagentsRoot = resolveSubagentsRoot();
if (!piRoot || !subagentsRoot) {
  console.error("本机没有 pi / pi-subagents 安装，跳过检查");
  process.exit(0);
}

const pi = await import(pathToFileURL(path.join(piRoot, "dist", "index.js")).href);
const subagentsSkills = await import(pathToFileURL(path.join(subagentsRoot, "src", "agents", "skills.js")).href);
const subagentsFrontmatter = await import(pathToFileURL(path.join(subagentsRoot, "src", "agents", "frontmatter.js")).href);
const agentDir = path.join(os.homedir(), ".pi", "agent");

// 0. pi 启动：资源加载器（项目扩展 + 项目 skill）
const loader = new pi.DefaultResourceLoader({
  cwd: ROOT,
  agentDir,
  resolveProjectTrust: async () => ({ trusted: true }),
});
await loader.reload();
const extensions = loader.getExtensions();
check(
  "pi 启动时加载项目扩展",
  extensions.extensions.some((extension) => extension.path.endsWith("subagent-only-skills.ts")),
  extensions.extensions.map((extension) => extension.path).join(", ") || "无扩展",
);
check(
  "扩展加载无错误",
  extensions.errors.length === 0,
  extensions.errors.map((error) => `${error.path}: ${error.error}`).join("; "),
);
check(
  "pi 启动时加载项目 skill",
  loader.getSkills().skills.some((skill) => skill.name === SKILL_NAME),
  loader.getSkills().skills.map((skill) => skill.name).join(", ") || "无",
);

// 1. pi 启动时的 skill 发现
const { skills } = pi.loadSkills({ cwd: ROOT, agentDir, skillPaths: [], includeDefaults: true });
const discovered = skills.find((skill) => skill.name === SKILL_NAME);
check("pi 在项目里发现 skill", Boolean(discovered), `已发现：${skills.map((s) => s.name).join(", ") || "无"}`);
check("skill 不带 disable-model-invocation", discovered?.disableModelInvocation !== true);

const before = pi.formatSkillsForPrompt(skills, "read");
check("未过滤时提示词包含该 skill", before.includes(SKILL_NAME));

// 2. 项目扩展把 skill 从提示词选项里剔除
const extension = (await import(pathToFileURL(path.join(HERE, "extensions", "subagent-only-skills.ts")).href)).default;
let handler;
extension({
  on(event, fn) {
    if (event === "before_agent_start") handler = fn;
  },
});
check("扩展注册了 before_agent_start", typeof handler === "function");

const options = { cwd: ROOT, skills: [...skills] };
await handler({ type: "before_agent_start", messageType: "user", prompt: "check", systemPromptOptions: options });
check("扩展剔除了该 skill", !options.skills.some((skill) => skill.name === SKILL_NAME));
check("其它 skill 保留", options.skills.length === skills.length - 1);

// 3. pi 渲染后的提示词不再出现该 skill
const after = pi.formatSkillsForPrompt(options.skills, "read");
check("提示词不再包含该 skill", !after.includes(SKILL_NAME));

// 4. pi-subagents 按 agent 定义解析 skill
const agentRaw = fs.readFileSync(AGENT_FILE, "utf8");
// agent 定义由 pi-subagents 自己解析 frontmatter（值都是字符串），不是 pi 的 YAML 解析。
const { frontmatter } = subagentsFrontmatter.parseFrontmatter(agentRaw);
const list = (value) => String(value ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const skillNames = list(frontmatter.skill ?? frontmatter.skills);
const skillPaths = list(frontmatter.skillPath);
check("agent 定义声明了 inheritSkills: false", frontmatter.inheritSkills === "false");
check("agent 定义声明了 skill", skillNames.includes(SKILL_NAME), skillNames.join(", "));
check("agent 定义声明了 skillPath", skillPaths.length > 0);

const { resolved, missing } = subagentsSkills.resolveSkills(skillNames, ROOT, skillPaths, path.dirname(AGENT_FILE));
check("子代理解析到 skill", resolved.some((skill) => skill.name === SKILL_NAME), `missing：${missing.join(", ") || "无"}`);
check("子代理没有缺失 skill", missing.length === 0, missing.join(", "));

// 5. 子代理提示词里带上技能
const injection = subagentsSkills.buildSkillInjection(resolved);
check("子代理提示词包含该 skill", injection.includes(SKILL_NAME));

// 6. pi-subagents 在项目里发现 agent 定义
const subagentsAgents = await import(pathToFileURL(path.join(subagentsRoot, "src", "agents", "agents.js")).href);
const discoveredAgents = subagentsAgents.discoverAgents(ROOT, "project", undefined).agents ?? [];
const jsReverse = discoveredAgents.find((agent) => agent.name === "js-reverse");
check("pi-subagents 发现 js-reverse agent", Boolean(jsReverse), discoveredAgents.map((agent) => agent.name).join(", ") || "无");
check("agent 解析到 skill", Boolean(jsReverse?.skills?.includes(SKILL_NAME)), (jsReverse?.skills ?? []).join(", "));
check("agent 不继承 pi 的 skill 目录", jsReverse?.inheritSkills === false);

console.log(failed === 0 ? "\nsubagent-only skill 检查通过" : `\n${failed} 项检查失败`);
process.exit(failed === 0 ? 0 : 1);
