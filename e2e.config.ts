// e2e.config.ts — 面板的端到端测试（真浏览器 + 本地网关实例）。
//
// 跑起来的是真网关（`test/panel-e2e-app.sh` 起的那个），面板产物来自
// `web/dist`（`mise run web:build`）。上游一律关着：这些测试只碰面板与本地面板
// 接口，不发任何真上游请求。
//
// 数据目录每次运行新建（`mktemp -d`），路径写在 `.e2e/tmp/panel-data-dir`
// 让测试读令牌 —— 绝不指向 `~/.buddy-proxy` 或 NAS 上的库。
//
// 浏览器用的是系统 chromium，通过 CDP 接进来：本机是 NixOS，
// `~/.cache/ms-playwright` 里下载的 headless shell 缺 libglib / libnss，
// 一跑就 exit 127。每个 attempt 要一台新的浏览器（引擎的要求），所以
// `cdpEndpoint` 每次都新起一个进程。
//
// 跑完之后 `.e2e/` 里只剩交付物：`report.json`、`junit.xml`、`results/`（trace 与
// 失败截图）、`logs/app.log`。数据目录、marker、浏览器 profile 都建在那份数据目录
// 里，`test/panel-e2e-app.sh` 收尾时整个删掉 —— 所以跑完 `/tmp` 里看不到这轮的
// 东西不是 bug。中途被硬杀（kill -9 那种）时脚本没机会收尾，留一轮下来由下次
// 启动前那句「删一天以前的」清掉。

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

/** 运行期那些东西（数据目录、app 日志、报告）都落在这里，整目录 gitignore。 */
const OUTPUT = '.e2e';

/**
 * app 命令把这次运行的数据目录路径写在这儿，测试与凭据靠它找令牌。
 *
 * app 命令退出时会连这个文件带外面的目录一起删掉（`tests/panel.ts` 写死了这条
 * 路径，所以位置不能挪）。
 */
const DATA_DIR_MARKER = `${OUTPUT}/tmp/panel-data-dir`;

/**
 * 这次运行的面板数据目录。
 *
 * app 命令（`test/panel-e2e-app.sh`）先建目录、把路径写进 marker，再起网关；
 * 凭据的 provider 在填令牌时才读，那时 marker 一定在了。
 */
function panelDataDir(): string {
  return readFileSync(DATA_DIR_MARKER, 'utf8').trim();
}

/** 面板登录令牌。网关启动时生成在数据目录里，只给面板用。 */
function panelToken(): string {
  return readFileSync(join(panelDataDir(), 'admin-token'), 'utf8').trim();
}

/** 这台机器上 chromium 在哪儿。 */
const CHROME = process.env.CHROME_PATH ?? '/run/current-system/sw/bin/chromium';

/** 起过的浏览器，退出时一起收掉。 */
const browsers: ChildProcess[] = [];
process.on('exit', () => {
  for (const child of browsers) child.kill();
});
process.on('SIGINT', () => process.exit(1));
process.on('SIGTERM', () => process.exit(1));

/**
 * 这一轮浏览器 profile 的落点。
 *
 * 建在这次运行的数据目录里，而不是系统临时目录：脚本收尾删数据目录时 profile
 * 一起没，不用再写一套清理。一个 attempt 一个（引擎每次 attempt 都是全新的上下
 * 文，共用一个会把上一轮的 localStorage，也就是已登录的令牌，带进来），靠
 * `mkdtemp` 的随机尾巴各自独立，并发 attempt 也不会撞。
 *
 * 读不到 marker 说明网关还没起来 —— 只有异常启动会走到这条退路上，那时 profile
 * 落回系统临时目录，留下的一轮由脚本启动前那句「删一天以前的」兜底。
 */
function chromiumProfile(): string {
  let base: string;
  try {
    base = panelDataDir();
  } catch {
    return mkdtempSync(join(tmpdir(), 'e2e-chromium-'));
  }
  return mkdtempSync(join(base, 'chromium-'));
}

/**
 * 起一个系统 chromium，返回它的 CDP 地址。
 *
 * 引擎每个 attempt 都要一台新浏览器，所以这里不缓存 —— 每次调用都是一个新
 * 进程（各自的临时 profile）。`--remote-debugging-port=0` 让 chromium 自己挑
 * 端口，地址从 stderr 里那行 `DevTools listening on ws://…` 读出来。
 */
async function systemChromium(): Promise<string> {
  const profile = chromiumProfile();
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  browsers.push(child);
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`chromium 没起来（CHROME_PATH=${CHROME} 指不到浏览器？）`)),
      30_000,
    );
    child.stderr?.on('data', (chunk: Buffer) => {
      // 这行里的 ws:// 是 chromium 自己打印的本机调试地址，隐私扫描器会当成
      // 明文 ws 端点报出来 —— 它只能是本机回环，没有别的形态。
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        // 地址读到了，剩下的 stderr 只是噪音：继续排掉，别把管道堵住。
        child.stderr?.resume();
        resolve(match[1]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`chromium 退出了 code=${code}`));
    });
  });
}

// marker 由 app 命令自己写（它要 `mkdir -p` 一次），这里只保证 `.e2e/` 在。
mkdirSync(dirname(dirname(DATA_DIR_MARKER)), { recursive: true });

export default {
  projectId: 'buddy-proxy-panel',
  targets: [
    {
      name: 'panel',
      engine: web({
        connect: { cdpEndpoint: systemChromium },
        // 面板的弹窗比较高（新增平台那份模板清单），默认的 720 太矮：
        // 底部的按钮会跑到视口外面，点不动。
        viewport: { width: 1440, height: 900 },
      }),
      app: {
        url: 'http://127.0.0.1:6799/admin/',
        command: {
          executable: 'bash',
          args: ['test/panel-e2e-app.sh'],
          env: {
            DATA_DIR_MARKER,
            ROUTER_PORT: '6799',
            // 面板自己不带鉴权：闸门靠 admin-token，网关的 API KEY 拦不着它。
            REQUIRE_API_KEY: 'false',
            // 自测不碰任何平台：定时任务（换令牌、签到）一律不跑。
            PERIODIC_ENABLED: 'false',
            // app 命令的 env 是白名单（只继承 PATH / HOME / 临时目录），
            // mise 给的这个得自己带过去。
            NODE_OPTIONS: process.env.NODE_OPTIONS ?? '',
          },
          startupTimeout: 60_000,
          log: `${OUTPUT}/logs/app.log`,
        },
      },
    },
  ],
  // 一个网关、一份数据库，测试之间共享状态：串行跑，失败不重试（重试会把
  // 上一轮的半成品数据带进来）。
  workers: 1,
  retries: 0,
  // 面板是中文界面，locator 按真实文案写；断言给的时间比默认宽一点（本地网关
  // 冷启动、React 首次渲染）。
  assertionTimeout: 10_000,
  credentials: {
    // 令牌只经 `credentials.user('admin').password` 填进去，模型和报告里只出现
    // `<secret:admin.password>`。面板没有用户名这一格，用户名只是填满契约。
    admin: { username: 'admin', password: panelToken },
  },
  output: OUTPUT,
} satisfies E2EConfig;
