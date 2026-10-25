// lib/platform-keys.ts — 平台自己的 API key：三家一个形状。
//
// SenseNova、书生·端砚、TokenRhythm 都有「账号上的一把推理 key」：列出来、
// 建一把、注销，有的还能停用与启用。路径与字段三家不一样（控制台那套接口
// 各有各的形状），所以实现还是各家的；这里只定下它们共同回答的那些问题。
//
// 面板还没做 key 管理：下面这些接口现在是网关自己用（登录之后保证账号有一把
// 能用的 key）与探针用（tools/probe-tr-keys.ts）。留着是因为面板接上的时候
// 不用重写。

/** 一把 key，跨平台的同一个形状。 */
export interface PlatformKey {
  /** 平台给这把 key 的 id。 */
  id: string;
  /** 人起的名字。 */
  name: string;
  /** 掩码后的 key：列表里只有这个。 */
  masked: string;
  /** 完整的 key：只有创建的那一次回答里有。 */
  plain?: string;
  /** 平台自己的状态（active、disabled……）。 */
  status: string;
}

/**
 * 操作一把 key 时要带的东西。
 *
 * 各家要的不一样：书生·端砚的接口要控制台的 token，SenseNova 的 key 分
 * 计费类型，TokenRhythm 的 key 按租户号存。用不上的那家不看这些。
 */
export interface PlatformKeyContext<S = unknown> {
  /** 平台自己的会话。 */
  session: S;
  /** 控制台的 token：书生·端砚的接口要。 */
  token?: string;
  /** key 的计费类型：SenseNova 要（积分池还是按量计费）。 */
  keyType?: string;
  /** 第几个账号：TokenRhythm 的 key 按租户号存。 */
  index?: number;
  /** 账号在网关里的 id：key 存到哪一格。 */
  providerId?: string;
}

/** 一家平台的 key 管理。 */
export interface PlatformKeys<S = unknown> {
  /** 这家平台叫什么（错误提示里用）。 */
  what: string;
  /** 账号现有的 key。 */
  list(ctx: PlatformKeyContext<S>): Promise<PlatformKey[]>;
  /** 建一把。完整的 key 只有这一次有。 */
  create(ctx: PlatformKeyContext<S>, name: string): Promise<PlatformKey>;
  /** 注销一把。 */
  delete(ctx: PlatformKeyContext<S>, id: string): Promise<void>;
  /** 停用一把：平台没有这个动作时没有这个方法。 */
  disable?(ctx: PlatformKeyContext<S>, id: string): Promise<void>;
  /** 重新启用一把。 */
  enable?(ctx: PlatformKeyContext<S>, id: string): Promise<void>;
  /**
   * 账号要用的那把 key：没有就建一把并存下来。
   *
   * key 叫什么由平台自己定（网关这边叫「buddy」，TokenRhythm 叫
   * 「buddy-<租户号>」），所以这里不收名字。
   */
  ensure(ctx: PlatformKeyContext<S>, current?: string | null): Promise<string | null>;
}
