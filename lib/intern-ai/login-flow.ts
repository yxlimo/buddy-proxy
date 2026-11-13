// lib/intern-ai/login-flow.ts — 授权阶段，登记给 lib/login-flow.ts。
//
// 为什么单独一个文件：登录本身在 auth.ts（三段：公钥 → 账号密码 → 换子站
// token），而「建推理 key」在 transport.ts。两个都往这儿引会成环，所以登记
// 放在第三个模块里，由 lib/intern-ai/register.ts 引一次，登记就在 kindOf()
// 之前发生。
//
// intern-ai 与别家不同的两处，都留在这里说清楚：
//
//   · 落库不在 commit 里：auth.ts 的 login() 自己存会话，而且存的时候要保住
//     obtainedAtMs（writeSession 的新旧比较靠它）。commit 只把凭据 id 交回去。
//   · 人可以不给账号密码，只在浏览器里登完把 uaa-token 贴回来（面板上的
//     ImportLoginToken）。那条路不走这条 flow。

import { providerSecretId } from "../credential-ids.ts";
import { registerLoginFlow, type LoginTicket, type SubmitInput } from "../login-flow.ts";
import { login, storedAccount, type InternAiCaptcha, type InternAiSession } from "./auth.ts";
import { INTERN_AI_SSO_BASE, internAiDiscoveryKey } from "./config.ts";

/** 提交的结果：会话，以及账号上有没有推理用的 key。 */
export interface InternAiLogin {
  session: InternAiSession;
  /**
   * 账号上已经有推理用的 key 吗。
   *
   * key 由用户自己在面板上填：登录不再替人建一把（平台只把完整值给一次，
   * 建出来的那把用户既看不到也换不掉）。
   */
  hasKey: boolean;
}

/** 面板上那句话。人机校验要人点，所以这里说的是「你去点，再把 token 给我」。 */
const MESSAGE =
  `在浏览器里打开上面的链接登录，然后从开发者工具的 Cookie 里复制 uaa-token，贴回面板。` +
  `这一步要人自己点，服务器替不了。`;

/** 人机校验的三个值（浏览器里过一次验证码才有）。少一个就当没给。 */
function captchaOf(input: SubmitInput): InternAiCaptcha | undefined {
  const extra = input.extra ?? {};
  const captchaVerifyParam = extra.captchaVerifyParam;
  const sceneId = extra.sceneId;
  const prefix = extra.prefix;
  if (!captchaVerifyParam || !sceneId || !prefix) return undefined;
  return { captchaVerifyParam, sceneId, prefix };
}

registerLoginFlow<InternAiLogin>("intern-ai", {
  method: "token",
  label: "书生·端砚",
  begin: async (): Promise<LoginTicket> => ({
    method: "token",
    authorizationUrl: `${INTERN_AI_SSO_BASE}/login`,
    userCode: "",
    // 人在浏览器里登录、打开开发者工具、复制 token，都要时间：半小时够。
    expiresAtMs: Date.now() + 30 * 60 * 1000,
    message: MESSAGE,
    state: {},
  }),

  submit: async (ctx, input): Promise<InternAiLogin> => {
    const session = await login(
      { user: input.username, password: input.password, captcha: captchaOf(input) },
      ctx.accountId,
    );
    // 推理端点认的是 Discovery 那把 key：key 由用户自己在面板上填，登录
    // 不碰它，只说清账号上有没有。
    const hasKey = Boolean(internAiDiscoveryKey(storedAccount(ctx.accountId)?.discoveryKey));
    return { session, hasKey };
  },

  // 会话由 login() 落库（见文件头）。这里只交凭据 id。
  commit: (ctx) => providerSecretId(ctx.accountId),
});
