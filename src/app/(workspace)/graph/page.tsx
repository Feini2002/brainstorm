import { PageHeader } from '@/components/AppShell';
import { SectionPending } from '@/components/ui/SectionPending';

export default function GraphPage() {
  return (
    <>
      <PageHeader
        title="关系图"
        description="用已有知识与关系生成可布局的关系图。"
      />
      <SectionPending
        title="关系图正在实现"
        description="关系图是知识库的投影，不是另一份笔记。它需要先有关系数据，再读取数据库生成节点与边，并提供自动布局与位置保存。"
        next={<p className="text-xs text-[var(--ink-muted)]">当前进度：基础设施阶段（G0）。</p>}
      />
      {/* Reserve canvas space so the shell never collapses on narrow screens. */}
      <div className="view-canvas rounded-lg border border-dashed border-[var(--line)] bg-[var(--surface)]" />
    </>
  );
}
