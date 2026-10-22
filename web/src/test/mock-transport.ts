import {
  type MessageInitShape,
  type MessageShape,
} from '@bufbuild/protobuf'
import {
  Code,
  ConnectError,
  createClient,
  type Transport,
} from '@connectrpc/connect'
import { AdminService } from '@/gen/buddy/admin/v1/admin_pb'

type Methods = typeof AdminService['method']

/**
 * 假 transport 的处理器表。
 *
 * 键写契约里的 RPC 名（GetSystemStatus、ListUpstreams……），返回值和入参
 * 的类型都从契约推出来：形状写错（比如把 upstreams 写成 items）编译不过，
 * 不用等测试红了才发现。
 */
export type MockHandlers = {
  [K in keyof Methods as Capitalize<K>]?: (
    input: MessageInitShape<Methods[K]['input']>
  ) =>
    | MessageShape<Methods[K]['output']>
    | Promise<MessageShape<Methods[K]['output']>>
}

type AnyHandler = (input: never) => unknown

/**
 * 一个假的 transport：按方法名派发到预先放好的处理器。
 *
 * 方法名长这样：buddy.admin.v1.AdminService/ListUpstreams。处理器可以写
 * 全名，也可以只写最后一段。
 */
export function mockTransport(handlers: MockHandlers): Transport {
  const table = new Map<string, AnyHandler>()
  for (const [key, handler] of Object.entries(handlers)) {
    if (!handler) continue
    table.set(key, handler as AnyHandler)
    const short = key.split('/').pop() ?? key
    table.set(short, handler as AnyHandler)
  }

  return {
    async unary(method, _signal, _timeoutMs, _header, input) {
      const handler = table.get(method.name)
      if (!handler) {
        throw new ConnectError(
          `没有给 ${method.name} 准备处理器`,
          Code.Unimplemented
        )
      }
      return {
        stream: false as const,
        message: (await handler(input as never)) as never,
        header: new Headers(),
        trailer: new Headers(),
        method,
        service: method.parent,
      }
    },
    async stream() {
      throw new ConnectError('这个测试传输不支持流', Code.Unimplemented)
    },
  }
}

/** 用假 transport 造一个客户端。 */
export function mockAdminClient(handlers: MockHandlers) {
  return createClient(AdminService, mockTransport(handlers))
}
