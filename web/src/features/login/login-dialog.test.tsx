import { create } from '@bufbuild/protobuf'
import { useState } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  GetLoginStatusResponseSchema,
  ImportLoginTokenResponseSchema,
  ListUpstreamsResponseSchema,
  LoginSessionSchema,
  LoginWithPasswordResponseSchema,
  UpstreamSchema,
  type LoginWithPasswordResponse,
  type Upstream,
} from '@/gen/buddy/admin/v1/admin_pb'
import { LoginDialog } from '@/features/login/login-dialog'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: toastError,
    success: toastSuccess,
  }),
  Toaster: () => null,
}))

function session(
  extra: Partial<{
    status: string
    method: string
    authorizationUrl: string
    userCode: string
    expiresAt: bigint
    message: string
    upstreamId: string
    accountId: string
  }> = {}
) {
  return create(LoginSessionSchema, {
    loginId: 'login-1',
    upstreamId: 'minimax',
    accountId: 'minimax',
    status: 'pending',
    method: 'device',
    authorizationUrl: 'https://example.test/authorize?code=ABCD',
    userCode: 'ABCD-EFGH',
    expiresAt: BigInt(Date.now() + 5 * 60 * 1000),
    message: '在浏览器里打开上面的链接，同意之后这里会自动变成已登录。',
    ...extra,
  })
}

/** 假服务端：GetLoginStatus 回一个固定的会话。 */
function clientWith(sessionValue = session(), upstreams: Upstream[] = []) {
  return mockAdminClient({
    GetLoginStatus: () =>
      create(GetLoginStatusResponseSchema, { ok: true, session: sessionValue }),
    // 上游列表：面板按 kind 判上游是哪一类，不按 id 判。
    ListUpstreams: () => create(ListUpstreamsResponseSchema, { upstreams }),
  })
}

/** 一个上游：id 是用户起的，kind 才是它属于哪一类。 */
function upstream(id: string, kind: string): Upstream {
  return create(UpstreamSchema, { id, kind, label: id })
}

describe('登录对话框', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
  })

  it('device 形态：授权链接、大字码、倒计时', async () => {
    renderWithClient({
      client: clientWith(),
      children: (
        <LoginDialog open loginId='login-1' onOpenChange={() => {}} />
      ),
    })

    // 授权链接是可点的。
    const link = await screen.findByRole('link', {
      name: /example\.test\/authorize/,
    })
    expect(link).toHaveAttribute('href', 'https://example.test/authorize?code=ABCD')
    expect(link).toHaveAttribute('target', '_blank')

    // 大字码。
    expect(screen.getByText('ABCD-EFGH')).toBeInTheDocument()
    // 倒计时。
    expect(screen.getByText(/还剩 \d+ 分/)).toBeInTheDocument()
    // 等用户点同意。
    expect(screen.getByText('正在等你在浏览器里同意…')).toBeInTheDocument()
    // 有取消。
    expect(
      screen.getByRole('button', { name: '取消这次登录' })
    ).toBeInTheDocument()
  })

  it('browser 形态：只有链接，没有大字码', async () => {
    renderWithClient({
      client: clientWith(
        session({
          method: 'browser',
          userCode: '',
          authorizationUrl: 'https://example.test/browser-login',
        })
      ),
      children: (
        <LoginDialog open loginId='login-1' onOpenChange={() => {}} />
      ),
    })

    expect(
      await screen.findByRole('link', { name: /browser-login/ })
    ).toBeInTheDocument()
    expect(screen.queryByText('大字码')).not.toBeInTheDocument()
  })

  it('password 形态：账号、密码、记住密码', async () => {
    renderWithClient({
      client: clientWith(
        session({
          method: 'password',
          upstreamId: 'tokenrhythm',
          accountId: 'tokenrhythm:1',
          authorizationUrl: '',
          userCode: '',
          message: '在面板上填账号与密码，然后点「登录」。',
        }),
        [upstream('tokenrhythm', 'tokenrhythm')]
      ),
      children: (
        <LoginDialog
          open
          loginId='login-1'
          upstreamId='tokenrhythm'
          accountId='tokenrhythm:1'
          onOpenChange={() => {}}
        />
      ),
    })

    expect(await screen.findByLabelText('账号名')).toBeInTheDocument()
    expect(screen.getByLabelText('密码')).toBeInTheDocument()
    // TokenRhythm 的密码要留着才能再登一次，所以有「记住密码」。
    expect(screen.getByText(/记住密码吗/)).toBeInTheDocument()
    // 密码型没有链接也没有大字码。
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('sensenova 的密码型不给「记住密码」这个选项', async () => {
    renderWithClient({
      client: clientWith(
        session({
          method: 'password',
          upstreamId: 'sensenova',
          accountId: 'sensenova',
          authorizationUrl: '',
          userCode: '',
          message: '在面板上填账号与密码，然后点「登录」。',
        }),
        [upstream('sensenova', 'sensenova')]
      ),
      children: (
        <LoginDialog
          open
          loginId='login-1'
          upstreamId='sensenova'
          accountId='sensenova'
          onOpenChange={() => {}}
        />
      ),
    })

    expect(await screen.findByLabelText('账号名')).toBeInTheDocument()
    // SenseNova 的 cookie 就是会话本身，密码存不存没有意义。
    expect(screen.queryByText(/记住密码吗/)).not.toBeInTheDocument()
  })

  it('上游 id 换了也不影响：按 kind 判，不按 id 判', async () => {
    renderWithClient({
      client: clientWith(
        session({
          method: 'password',
          upstreamId: 'my-sense-nova',
          accountId: 'my-sense-nova',
          authorizationUrl: '',
          userCode: '',
          message: '在面板上填账号与密码，然后点「登录」。',
        }),
        [upstream('my-sense-nova', 'sensenova')]
      ),
      children: (
        <LoginDialog
          open
          loginId='login-1'
          upstreamId='my-sense-nova'
          accountId='my-sense-nova'
          onOpenChange={() => {}}
        />
      ),
    })

    expect(await screen.findByLabelText('账号名')).toBeInTheDocument()
    // id 不叫 sensenova，但它就是 sensenova 那一类：一样不给「记住密码」。
    expect(screen.queryByText(/记住密码吗/)).not.toBeInTheDocument()
  })

  it('token 形态：SSO 链接、贴 token 的框、人机校验的说明', async () => {
    renderWithClient({
      client: clientWith(
        session({
          method: 'token',
          upstreamId: 'intern-ai',
          accountId: 'intern-ai',
          authorizationUrl: 'https://example.test/sso/login',
          userCode: '',
          message: '在浏览器里打开上面的链接登录，然后贴回 uaa-token。',
        })
      ),
      children: (
        <LoginDialog
          open
          loginId='login-1'
          upstreamId='intern-ai'
          accountId='intern-ai'
          onOpenChange={() => {}}
        />
      ),
    })

    expect(
      await screen.findByRole('link', { name: /sso\/login/ })
    ).toBeInTheDocument()
    expect(screen.getByLabelText('uaa-token')).toBeInTheDocument()
    // 人机校验要说清楚是人自己过。
    expect(
      screen.getByText(/人机验证需要在浏览器中完成/)
    ).toBeInTheDocument()
    // token 从哪拿：开发者工具的 Cookie。
    expect(screen.getByText(/开发者工具/)).toBeInTheDocument()
    // intern-ai 的两个子站共用一个 token：不问子站了。
    expect(screen.queryByText('子站')).not.toBeInTheDocument()
    expect(screen.queryByText(/discovery/)).not.toBeInTheDocument()
    expect(screen.queryByText(/chat（对话）/)).not.toBeInTheDocument()
  })

  it('code 形态：授权码的框', async () => {
    renderWithClient({
      client: clientWith(
        session({
          method: 'code',
          upstreamId: 'intern-ai',
          accountId: 'intern-ai',
          authorizationUrl: 'https://example.test/sso/login',
          userCode: '',
        })
      ),
      children: (
        <LoginDialog
          open
          loginId='login-1'
          upstreamId='intern-ai'
          accountId='intern-ai'
          onOpenChange={() => {}}
        />
      ),
    })

    expect(await screen.findByLabelText('授权码')).toBeInTheDocument()
    // intern-ai 的两个子站共用一个 token：不问子站了。
    expect(screen.queryByText('子站')).not.toBeInTheDocument()
    expect(screen.queryByText(/discovery/)).not.toBeInTheDocument()
  })

  it('每 3 秒问一次进度', async () => {
    let calls = 0
    const client = mockAdminClient({
      GetLoginStatus: () => {
        calls += 1
        return create(GetLoginStatusResponseSchema, {
          ok: true,
          session: session(),
        })
      },
    })

    renderWithClient({
      client,
      children: (
        <LoginDialog open loginId='login-1' onOpenChange={() => {}} />
      ),
    })

    await waitFor(() => expect(calls).toBe(1))
    // 3 秒之后应该又问了一次。
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), {
      timeout: 6000,
    })
  })

  it('成了：关掉对话框', async () => {
    const onOpenChange = vi.fn()
    renderWithClient({
      client: clientWith(
        session({ status: 'approved', message: '登录好了。' })
      ),
      children: (
        <LoginDialog
          open
          loginId='login-1'
          onOpenChange={onOpenChange}
        />
      ),
    })

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it('同一个会话重新打开的时候还是会关掉（只是不说第二遍）', async () => {
    const user = userEvent.setup({ delay: null })
    const onOpenChange = vi.fn()
    const client = clientWith(
      session({ status: 'approved', message: '登录好了。' })
    )

    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>打开</button>
          <LoginDialog
            open={open}
            loginId='login-1'
            onOpenChange={(next) => {
              onOpenChange(next)
              setOpen(next)
            }}
          />
        </>
      )
    }

    renderWithClient({ client, children: <Harness /> })

    await user.click(screen.getByRole('button', { name: '打开' }))
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
    const calls = onOpenChange.mock.calls.length

    // 同一个 login_id 又打开一次：还是要关掉，但不用再说一遍。
    await user.click(screen.getByRole('button', { name: '打开' }))
    await waitFor(() => {
      expect(onOpenChange.mock.calls.length).toBeGreaterThan(calls)
    })
    expect(toastSuccess).toHaveBeenCalledTimes(1)
  })

  it('败了：显示中文，不显示机器码', async () => {
    renderWithClient({
      client: clientWith(
        session({
          status: 'failed',
          message: '授权码不对（invalid_grant）',
        })
      ),
      children: (
        <LoginDialog open loginId='login-1' onOpenChange={() => {}} />
      ),
    })

    expect(await screen.findByText('授权码不对')).toBeInTheDocument()
    expect(screen.queryByText(/invalid_grant/)).not.toBeInTheDocument()
  })

  it('过期后提供重新发起入口', async () => {
    const onRestart = vi.fn()
    renderWithClient({
      client: clientWith(
        session({ status: 'expired', message: '登录窗口过期了，重新点一次登录。' })
      ),
      children: (
        <LoginDialog
          open
          loginId='login-1'
          onOpenChange={() => {}}
          onRestart={onRestart}
        />
      ),
    })

    const button = await screen.findByRole('button', { name: '重新发起' })
    expect(button).toBeInTheDocument()
  })

  it('密码型：提交中按钮禁用并转圈', async () => {
    const user = userEvent.setup({ delay: null })
    let resolveLogin: (value: LoginWithPasswordResponse) => void = () => {}
    const client = mockAdminClient({
      GetLoginStatus: () =>
        create(GetLoginStatusResponseSchema, {
          ok: true,
          session: session({
            method: 'password',
            upstreamId: 'tokenrhythm',
            accountId: 'tokenrhythm:1',
            authorizationUrl: '',
            userCode: '',
          }),
        }),
      LoginWithPassword: () =>
        new Promise((resolve) => {
          resolveLogin = resolve
        }),
    })

    renderWithClient({
      client,
      children: (
        <LoginDialog
          open
          loginId='login-1'
          upstreamId='tokenrhythm'
          accountId='tokenrhythm:1'
          onOpenChange={() => {}}
        />
      ),
    })

    await user.type(await screen.findByLabelText('账号名'), 'tenant-a')
    await user.type(screen.getByLabelText('密码'), 'hunter2')
    await user.click(screen.getByRole('button', { name: '登录' }))

    // 提交中：按钮禁用。
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '登录' })).toBeDisabled()
    })

    resolveLogin(
      create(LoginWithPasswordResponseSchema, { ok: true, message: '登录好了。' })
    )
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('登录好了。')
    })
  })

  it('密码型：失败的时候只说中文，不说机器码', async () => {
    const user = userEvent.setup({ delay: null })
    toastError.mockClear()
    const client = mockAdminClient({
      GetLoginStatus: () =>
        create(GetLoginStatusResponseSchema, {
          ok: true,
          session: session({
            method: 'password',
            upstreamId: 'tokenrhythm',
            accountId: 'tokenrhythm:1',
            authorizationUrl: '',
            userCode: '',
          }),
        }),
      LoginWithPassword: () =>
        create(LoginWithPasswordResponseSchema, {
          ok: false,
          message: '账号或密码不对（invalid_credentials）',
        }),
    })

    renderWithClient({
      client,
      children: (
        <LoginDialog
          open
          loginId='login-1'
          upstreamId='tokenrhythm'
          accountId='tokenrhythm:1'
          onOpenChange={() => {}}
        />
      ),
    })

    await user.type(await screen.findByLabelText('账号名'), 'tenant-a')
    await user.type(screen.getByLabelText('密码'), 'wrong')
    await user.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalled()
    })
    const text = toastError.mock.calls[0][0] as string
    expect(text).toContain('账号或密码不对')
    expect(text).not.toContain('invalid_credentials')
  })

  it('token 型：贴回去之后调导入', async () => {
    const user = userEvent.setup({ delay: null })
    const imported: string[] = []
    const client = mockAdminClient({
      GetLoginStatus: () =>
        create(GetLoginStatusResponseSchema, {
          ok: true,
          session: session({
            method: 'token',
            upstreamId: 'intern-ai',
            accountId: 'intern-ai',
            authorizationUrl: 'https://example.test/sso/login',
            userCode: '',
          }),
        }),
      ImportLoginToken: (input) => {
        imported.push(input.token ?? '')
        return create(ImportLoginTokenResponseSchema, {
          ok: true,
          message: '导入好了凭据。',
        })
      },
    })

    renderWithClient({
      client,
      children: (
        <LoginDialog
          open
          loginId='login-1'
          upstreamId='intern-ai'
          accountId='intern-ai'
          onOpenChange={() => {}}
        />
      ),
    })

    await user.type(await screen.findByLabelText('uaa-token'), 'uaa-abc')
    await user.click(screen.getByRole('button', { name: '导入' }))

    await waitFor(() => {
      expect(imported).toEqual(['uaa-abc'])
    })
  })
})
