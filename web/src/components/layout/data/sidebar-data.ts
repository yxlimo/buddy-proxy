import {
  Boxes,
  CalendarCheck,
  CircleDollarSign,
  LayoutDashboard,
  Layers,
  Settings2,
  Wallet,
} from 'lucide-react'
import { type SidebarData } from '../types'

export const sidebarData: SidebarData = {
  navGroups: [
    {
      title: '总览',
      items: [
        {
          title: '总览',
          url: '/',
          icon: LayoutDashboard,
        },
      ],
    },
    {
      title: '网关',
      items: [
        {
          title: '平台',
          url: '/upstreams',
          icon: Boxes,
        },
        {
          title: '额度',
          url: '/balance',
          icon: Wallet,
        },
        {
          title: '签到',
          url: '/checkin',
          icon: CalendarCheck,
        },
        {
          title: '用量',
          url: '/usage',
          icon: CircleDollarSign,
        },
        {
          title: '主路由模型',
          url: '/models',
          icon: Layers,
        },
        {
          title: '配置',
          url: '/config',
          icon: Settings2,
        },
      ],
    },
  ],
}
