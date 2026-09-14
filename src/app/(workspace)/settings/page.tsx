import { PageHeader } from '@/components/AppShell';
import { SectionPending } from '@/components/ui/SectionPending';

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="设置"
        description="配置模型连接，查看本地数据与诊断。"
      />
      <SectionPending
        title="设置页正在实现"
        description="设置分为模型连接与本地数据两区。模型区会提供 Base URL、模型名、Key 输入与连接测试；数据区显示存储位置、逻辑导出、空库恢复与诊断。Key 保存在服务端秘密表，不会返回浏览器。"
        next={<p className="text-xs text-[var(--ink-muted)]">当前进度：基础设施阶段（G0）。</p>}
      />
    </>
  );
}
