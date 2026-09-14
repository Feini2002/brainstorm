/**
 * The six workspace destinations, in navigation order (T005-R01).
 *
 * One list drives the sidebar, the active-route highlight and any future
 * keyboard shortcut, so a nav item can never point at a route that does not
 * exist and a route can never be missing from the nav.
 */
export interface NavDestination {
  href: string;
  label: string;
  /** Short description shown in the page header / empty state. */
  description: string;
}

export const NAV_DESTINATIONS: readonly NavDestination[] = [
  {
    href: '/inbox',
    label: '收件箱',
    description: '记录一句话、一个词或一段资料，原文先保存。',
  },
  {
    href: '/library',
    label: '资料库',
    description: '搜索、筛选和编辑已经保存的知识。',
  },
  {
    href: '/graph',
    label: '关系图',
    description: '用已有知识与关系生成可布局的关系图。',
  },
  {
    href: '/mindmap',
    label: '脑图',
    description: '把选中的材料整理成层级脑图。',
  },
  {
    href: '/flow',
    label: '流程图',
    description: '按指定意图把材料组织成受限流程。',
  },
  {
    href: '/settings',
    label: '设置',
    description: '配置模型连接，查看本地数据与诊断。',
  },
] as const;

export const DEFAULT_ROUTE = NAV_DESTINATIONS[0].href;

/** Longest-prefix match so nested routes keep their section highlighted. */
export function findDestination(pathname: string): NavDestination | null {
  let best: NavDestination | null = null;
  for (const destination of NAV_DESTINATIONS) {
    if (pathname === destination.href || pathname.startsWith(`${destination.href}/`)) {
      if (!best || destination.href.length > best.href.length) best = destination;
    }
  }
  return best;
}
