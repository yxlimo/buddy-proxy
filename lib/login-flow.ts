// lib/login-flow.ts — 授权阶段的那一半：发起、等结果、落库。
//
// 登录分两半。**之后**那半已经是框架了（lib/session.ts：读、写、单写者
// 锁、刷新、死会话），minimax / qoder / workbuddy 都在里头。**之前**那半
// 一直各写各的，而且写了两遍：面板走 lib/admin/login.ts 的 switch，启动
// 与命令行走各模块自己的 login()。
//
// 这里收的是「之前」那半：每个平台登记一条 LoginFlow，描述
//   begin  → 给用户一个链接，
//   poll   → 等用户点完，拿到会话，
//   commit → 把会话存进库，返回凭据 id。
// 轮询的节奏、窗口过期、并发开始同一账号要串行 —— 这些是共用的，在这一
// 层做一次。
//
// 不在这里做的事，见 docs/tasks/refactor/login-flow-plan.md：
//   · 不碰刷新（刷新只在定时器那条路上，各平台的刷新逻辑已经在 session.ts 之上）
//   · 不改会话字段（writeSession 的新旧比较靠 loginAtMs ?? obtainedAtMs，
//     字段名是数据，不是写法）
//   · 不记 authLog（现在面板与命令行各自记一笔，合并留给迁移收尾那一步 ——
//     现在替它们记会让一次登录留下两条记录）

import { AuthError } from "./credential.ts";
import { allKinds } from "./provider-kinds.ts";
// 只用 store：providers.ts 会把各平台都拉进来，而各平台在加载时要调这里的
// registerLoginFlow —— 从这里引 providers.ts 会在模块循环里撞上还没初始化的表。
import { store } from "./store.ts";

/** 面板按它决定画什么。 */
export type LoginMethod = "device" | "browser" | "password" | "code" | "token" | "key";

/** 一次登录落在哪个账号上。 */
export interface LoginContext {
  /** provider 表那一行的 id —— 凭据落在它上面，也是它的凭据 id 的后缀。 */
  accountId: string;
  /** 平台 id（provider 行的 platform）。 */
  platform: string;
  /** 地区（qoder / zcode / workbuddy 有，其它是空串）。 */
  region: string;
}

/** 阶段一的结果：用户要点的那个链接。 */
export interface LoginTicket {
  method: LoginMethod;
  authorizationUrl: string;
  /** 设备流的大字码；没有就是空串。 */
  userCode: string;
  expiresAtMs: number;
  /** 面板上那句话。 */
  message: string;
  /**
   * 半凭据（state / device_code / flow_id……）。
   *
   * 只有发起它的那条 flow 能解释，所以这里不规定形状。它会跟着面板那次登
   * 录一起落进 cache 表 —— 一个字段都不进日志。
   */
  state: Record<string, unknown>;
}

/** 阶段二的结果。 */
export type PollResult<T> =
  | { state: "pending" }
  | { state: "approved"; session: T }
  | { state: "failed"; message: string }
  | { state: "expired"; message: string };

/** 阶段二'：一次性提交（密码 / 贴 token / 贴 key）。 */
export interface SubmitInput {
  username?: string;
  password?: string;
  token?: string;
  code?: string;
  /** 人机校验那类多出来的字段。 */
  extra?: Record<string, string>;
}

/**
 * 一条平台的登录链。
 *
 * `poll` 与 `submit` 至少有一个。有的平台自己就在里头等到结果（WorkBuddy
 * 的 pollLogin 一直轮询到批准或超时），那样 `poll` 返回的就是终态；这一层
 * 的循环只是给「一问一答」型留的位置。
 */
export interface LoginFlow<T = unknown> {
  readonly method: LoginMethod;
  /** 日志与面板上认人的名字。 */
  readonly label: string;
  /** 一次登录最久等多久；给了 `expiresAtMs` 的地方以它为准。 */
  readonly timeoutMs?: number;
  /** 「还在等」时两次问之间的间隔。 */
  readonly pollIntervalMs?: number;
  /** 阶段一。密码/token/key 型不需要授权链接，返回一张空票。 */
  begin(ctx: LoginContext): Promise<LoginTicket>;
  /** 阶段二。返回终态，或者 pending 让这一层隔一会儿再问。 */
  poll?(ctx: LoginContext, ticket: LoginTicket): Promise<PollResult<T>>;
  /** 阶段二'：一次性提交。 */
  submit?(ctx: LoginContext, input: SubmitInput): Promise<T>;
  /**
   * 落库，返回凭据 id。
   *
   * 这是**唯一**写会话的地方：`force: true` 只出现在这里 —— 登录完成那一
   * 次确实该覆盖，别的时候（刷新）不许顺手覆盖更新的会话。
   */
  commit(ctx: LoginContext, session: T): Promise<string> | string;
  /** 阶段三：派生资源（推理 key / 设备 id / 租户）。失败只报告，不改登录结果。 */
  derive?(ctx: LoginContext, session: T): Promise<void>;
}

const flows = new Map<string, LoginFlow<any>>();

/** 登记一个平台的登录链。平台在模块加载时自己登记。 */
export function registerLoginFlow<T>(kind: string, flow: LoginFlow<T>): void {
  flows.set(kind, flow);
}

/** 这个平台怎么登录；没登记就是 null（调用方要报错，不许兜底）。 */
export function loginFlowOf(kind: string): LoginFlow<any> | null {
  return flows.get(kind) ?? null;
}

/** 登记过的平台，给启动时的穷尽校验用。 */
export function loginKinds(): string[] {
  return [...flows.keys()].sort();
}

/**
 * 显式声明「这个平台没有登录链」。
 *
 * 不登记 flow、也不声明，启动时会被 assertLoginFlows() 拦下来 —— 沉默地
 * 漏掉一个平台，面板上只会回一句「没有这个方法」，排查时看不出是漏了。
 */
const noFlows = new Map<string, string>();

/** 这个平台为什么没有登录链；有 flow 或从没声明过都是 null。 */
export function noLoginFlowReason(kind: string): string | null {
  return noFlows.get(kind) ?? null;
}

export function declareNoLoginFlow(kind: string, reason: string): void {
  noFlows.set(kind, reason);
}

/**
 * 每个已注册的 kind 都必须有 flow 或显式的「没有 flow」声明。
 *
 * 新接一个平台忘了登记，这里在启动时就报出来，而不是等用户点「登录」才
 * 收到一句 400。
 */
export function assertLoginFlows(): void {
  const missing = allKinds()
    .map((k) => k.kind)
    .filter((kind) => !flows.has(kind) && !noFlows.has(kind));
  if (missing.length) {
    throw new Error(`这些平台既没有登录链也没有声明：${missing.join("、")}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 发起一次登录。没登记的平台在这里就报错，不落进任何兜底分支。 */
export async function beginLoginFlow(kind: string, ctx: LoginContext): Promise<LoginTicket> {
  const flow = loginFlowOf(kind);
  if (!flow) {
    throw new AuthError("unknown upstream", `这个上游还没有登录的办法：${ctx.platform}`, 400);
  }
  return flow.begin(ctx);
}

/**
 * 阶段二'：一次性提交（密码 / 贴 token / 贴 key）。
 *
 * 会话落库在 `commit` 里；但 submit 也会写库（账号密码、推理 key），所以账号
 * 在途中被删时由 submitLoginResult 事后补删。
 */
export async function submitLogin<T = unknown>(
  kind: string,
  ctx: LoginContext,
  input: SubmitInput,
): Promise<string> {
  const { credentialId } = await submitLoginResult<T>(kind, ctx, input);
  return credentialId;
}

/**
 * 与 submitLogin 一样，但把平台交回来的东西也带出去。
 *
 * 有些平台提交完还要说一句自己的话（SenseNova：推理用的 key 建出来没有）。
 * 那句话只在提交的结果里 —— 凭据 id 里没有它，落库之后也没地方找。
 */
export async function submitLoginResult<T = unknown>(
  kind: string,
  ctx: LoginContext,
  input: SubmitInput,
): Promise<{ credentialId: string; result: T }> {
  const flow = loginFlowOf(kind) as LoginFlow<T> | null;
  if (!flow) throw new AuthError("unknown upstream", `这个上游还没有登录的办法：${kind}`, 400);
  if (!flow.submit) throw new AuthError("no login", `${flow.label} 不需要提交账号密码。`, 400);
  // 一次性提交的那几家（TokenRhythm / SenseNova / intern-ai）在 submit 里就
  // 写了库：账号密码、会话、新建的推理 key —— key 只能在登录之后、拿着会话
  // 去平台建，建它的那一下就得存（完整值只出现一次），挪不进 commit 里那个
  // 没有 await 的位置。所以这里不靠「先查后写」，而是事后兜底：整件事做完
  // （成也好、败也好），账号行不在了，就把这次登录写下的东西删干净。
  try {
    const result = await flow.submit(ctx, input);
    assertAccountExists(ctx);
    const credentialId = await flow.commit(ctx, result);
    // commit 里也可能有 await（TokenRhythm 建 key）：账号可能在那时被删。
    assertAccountExists(ctx);
    return { credentialId, result };
  } finally {
    if (!accountExists(ctx)) await forgetOrphanedLogin(kind, ctx);
  }
}

/**
 * 账号在登录途中被删了：把这次登录写下的凭据删掉。
 *
 * 删账号时（lib/admin/accounts.ts 的 deleteAccount）已经删过一遍，但那时登录
 * 还在等平台，平台答复之后写下的东西就成了孤儿。用同一个删法再删一次。
 *
 * 动态引入：admin/accounts.ts 会把各平台都拉进来，而各平台加载时要调这里的
 * registerLoginFlow（见文件头那条 import 的注释）。
 */
async function forgetOrphanedLogin(kind: string, ctx: LoginContext): Promise<void> {
  try {
    const { forgetAccountRecords } = await import("./admin/accounts.ts");
    const removed = forgetAccountRecords(ctx.accountId, kind);
    if (removed) console.warn(`[LOGIN] ${ctx.accountId} 在登录途中被删了，补删了这次登录写下的 ${removed} 条凭据`);
  } catch (e) {
    console.warn(`[LOGIN] ${ctx.accountId} 在登录途中被删了，补删凭据失败：${(e as Error)?.message ?? e}`);
  }
}

/**
 * 这次登录还要不要接着做。
 *
 * 面板上点了「取消」、账号被删了，答案就是 false：轮询停下，批下来的会话也
 * 不落库。
 */
export type LoginStillWanted = () => boolean;

/** 登录被取消了：调用方看到它就知道不用再报「失败」。 */
export class LoginCancelledError extends AuthError {
  constructor(kind: string) {
    super(`${kind} login cancelled`, "登录已取消。", 409);
  }
}

/**
 * 账号行还在吗。
 *
 * 落库之前问一次：账号在登录途中被删了，批下来的会话没有主人，写进去就是一
 * 条孤儿凭据 —— 等同一个 id 再出现时它就成了别人的。
 */
function assertAccountExists(ctx: LoginContext): void {
  if (!accountExists(ctx)) {
    throw new AuthError("account gone", `账号在登录途中被删了：${ctx.accountId}，这次登录的结果不保存。`, 409);
  }
}

function accountExists(ctx: LoginContext): boolean {
  return store().prepare("SELECT id FROM provider WHERE id = ?").get(ctx.accountId) !== undefined;
}

/**
 * 等结果，然后落库。
 *
 * `poll` 抛出来的错原样往上抛：面板上那句话是平台自己的意思（「被拒了」与
 * 「窗口过了」不一样），在这一层改写只会把它变成一句笼统的失败。
 *
 * `stillWanted` 在每一轮轮询之前、以及落库之前各问一次：取消发生在轮询途中
 * 时，平台可能照样批了，但会话不能写进去 —— 用户已经说了不要。
 */
export async function driveLogin<T>(
  kind: string,
  ctx: LoginContext,
  ticket: LoginTicket,
  deadlineMs = ticket.expiresAtMs,
  stillWanted: LoginStillWanted = () => true,
): Promise<{ credentialId: string; session: T }> {
  const flow = loginFlowOf(kind);
  if (!flow) {
    throw new AuthError("unknown upstream", `这个上游还没有登录的办法：${ctx.platform}`, 400);
  }
  if (!flow.poll) {
    throw new AuthError("no poll", "该登录会话没有可轮询的内容。", 400);
  }
  const interval = flow.pollIntervalMs ?? 2000;
  while (Date.now() < deadlineMs) {
    if (!stillWanted()) throw new LoginCancelledError(kind);
    const result = await flow.poll(ctx, ticket);
    if (result.state === "approved") {
      // 轮询那一下可能等了很久（WorkBuddy 在里头一直等到批准）：落库前再问。
      // 这一问与 commit 之间没有 await，同一个进程里不会有人插进来。
      if (!stillWanted()) throw new LoginCancelledError(kind);
      assertAccountExists(ctx);
      const credentialId = await flow.commit(ctx, result.session);
      if (flow.derive) {
        // 派生资源失败不算登录失败：会话已经存下来了，下一次扫描会补。
        await flow.derive(ctx, result.session).catch((e: unknown) => {
          console.warn(`[LOGIN] ${flow.label} 派生资源失败：${(e as Error)?.message ?? e}`);
        });
      }
      return { credentialId, session: result.session };
    }
    if (result.state === "failed") {
      throw new AuthError(`${kind} login failed`, result.message, 401);
    }
    if (result.state === "expired") {
      throw new AuthError(`${kind} login timed out`, result.message, 401);
    }
    await sleep(interval);
  }
  throw new AuthError(`${kind} login timed out`, "登录窗口过期了，请重新发起登录。", 401);
}
