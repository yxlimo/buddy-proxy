// tests/panel.ts — 面板 e2e 的共用零件（不是测试文件：文件名不带 .e2e）。
//
// 三件事：
//   * 进面板（令牌闸门那一步，每个 attempt 都是一台新浏览器，所以每个测试都要走一遍）；
//   * 读这次运行的数据目录与令牌，用 admin RPC 铺数据（面板上要验的是「点了之后
//     立刻变」，前置数据没必要一条条点出来）；
//   * 数控制台的报错条数。
//
// 令牌只在这个文件里读，不打印、不进日志。

import { readFileSync } from 'node:fs';
import { expect, credentials } from 'e2e';
import type { Screen } from 'e2e';
import type { Browser } from '@e2e-dev/web';

/** 被测实例的地址（`e2e.config.ts` 里给网关定的端口）。 */
export const BASE = 'http://127.0.0.1:6799';

/** app 命令把这次运行的数据目录写在这儿（见 `test/panel-e2e-app.sh`）。 */
const DATA_DIR_MARKER = new URL('../.e2e/tmp/panel-data-dir', import.meta.url);

/** 这次运行的数据目录。 */
export function dataDir(): string {
  return readFileSync(DATA_DIR_MARKER, 'utf8').trim();
}

/** 面板的访问令牌。 */
function adminToken(): string {
  return readFileSync(`${dataDir()}/admin-token`, 'utf8').trim();
}

const SERVICE = '/buddy.admin.v1.AdminService';

/** 打一个 admin RPC 方法（Connect 的 JSON 形态，跟面板发的一样）。 */
export async function adminRpc<T = Record<string, unknown>>(
  method: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(`${BASE}${SERVICE}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adminToken()}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} 失败：HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * 进面板。
 *
 * 没令牌时先看到闸门；填对就进总览。每个测试都从这一步开始 —— 浏览器是新的，
 * localStorage 里什么都没有。
 */
export async function login(screen: Screen): Promise<void> {
  // 闸门上的标题是个 div（不是 heading），所以按文字找。
  await expect(screen.getByText('输入访问令牌')).toBeVisible();
  await screen.getByLabel('访问令牌').fill(credentials.user('admin').password);
  await screen.getByRole('button', { name: '进入面板' }).click();
  await expect(screen.getByRole('heading', { name: '总览' })).toBeVisible();
}

/** 铺一个开放平台（方言类），返回它的 id。名字留着给测试当锚点。 */
export async function seedOpenPlatform(id: string, label: string): Promise<string> {
  await adminRpc('AddPlatform', {
    id,
    label,
    baseUrl: 'https://probe.example/v1',
    kind: 'openai',
  });
  return id;
}

/** 按 id 删掉一个平台（测试自己收尾用，别把数据留给下一个测试）。 */
export async function dropPlatform(id: string): Promise<void> {
  await adminRpc('DeletePlatform', { id });
}

/**
 * 记一下「这一页没有重新加载过」。
 *
 * 挂在 window 上的记号在刷新后就没了：改完立刻生效的断言要证明的是「没刷新也
 * 变了」，光看到新行不够（刷新同样能看到新行）。
 */
export async function markPage(browser: Browser): Promise<void> {
  await browser.evaluate("window.__e2ePageMark = 'kept'");
}

/** 断言还是同一个页面（没被刷新过）。 */
export async function expectSamePage(browser: Browser): Promise<void> {
  const mark = await browser.evaluate<string>('window.__e2ePageMark');
  expect(mark).toBe('kept');
}

/** 面板自己记的报错条数（见 `watchConsole`）。 */
const CONSOLE_KEY = '__e2ePanelConsole';

/**
 * 开始收集控制台的报错。
 *
 * 页面每跳一次就换一个文档，所以攒在 sessionStorage 里（同一个标签页、同一个源
 * 都还在），最后一次性读出来。收三类：`console.error`、`window.onerror`、
 * 未处理的 promise。
 */
export async function watchConsole(browser: Browser): Promise<void> {
  await browser.addInitScript(`
    (() => {
      const KEY = ${JSON.stringify(CONSOLE_KEY)};
      const push = (message) => {
        try {
          const raw = window.sessionStorage.getItem(KEY);
          const list = raw ? JSON.parse(raw) : [];
          list.push(message);
          window.sessionStorage.setItem(KEY, JSON.stringify(list.slice(-50)));
        } catch {
          // about:blank 这种没有 storage：不记就是了。
        }
      };
      const original = console.error;
      console.error = (...args) => {
        push('console.error: ' + args.map((arg) => String(arg)).join(' '));
        original.apply(console, args);
      };
      window.addEventListener('error', (event) => {
        push('window.onerror: ' + (event.message || String(event.error)));
      });
      window.addEventListener('unhandledrejection', (event) => {
        push('unhandledrejection: ' + String(event.reason));
      });
    })();
  `);
}

/** 到目前为止攒下的报错（按出现的先后）。 */
export async function consoleErrors(browser: Browser): Promise<string[]> {
  const raw = await browser.evaluate<string>(
    `window.sessionStorage.getItem(${JSON.stringify(CONSOLE_KEY)}) || '[]'`,
  );
  return JSON.parse(raw) as string[];
}
