import { PageHeader } from '@/components/AppShell';
import { SectionPending } from '@/components/ui/SectionPending';

export default function FlowPage() {
  return (
    <>
      <PageHeader
        title="流程图"
        description="按指定意图把材料组织成受限流程。"
      />
      <SectionPending
        title="流程图正在实现"
        description="流程图先由模型产生受限结构，经过校验后由程序编译为 Mermaid 源码再渲染，模型不会直接提供可执行的图表指令。没有依据的排列会明确标为推测。"
        next={<p className="text-xs text-[var(--ink-muted)]">当前进度：基础设施阶段（G0）。</p>}
      />
      <div className="view-canvas rounded-lg border border-dashed border-[var(--line)] bg-[var(--surface)]" />
    </>
  );
}
