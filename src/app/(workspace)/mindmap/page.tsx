import { PageHeader } from '@/components/AppShell';
import { SectionPending } from '@/components/ui/SectionPending';

export default function MindmapPage() {
  return (
    <>
      <PageHeader
        title="脑图"
        description="把选中的材料整理成层级脑图。"
      />
      <SectionPending
        title="脑图正在实现"
        description="脑图由选定材料的层级结构生成：先经过模型与结构校验，再编译为受控 Markdown 并用 Markmap 渲染。没有模型连接时，已保存的脑图仍可查看和导出。"
        next={<p className="text-xs text-[var(--ink-muted)]">当前进度：基础设施阶段（G0）。</p>}
      />
      <div className="view-canvas rounded-lg border border-dashed border-[var(--line)] bg-[var(--surface)]" />
    </>
  );
}
