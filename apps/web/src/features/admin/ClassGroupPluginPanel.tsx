import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { TenantPluginConfig } from "@/types/app";

export function ClassGroupIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className={className}>
      <rect x="4" y="8" width="40" height="32" rx="6" fill="#DBEAFE" />
      <circle cx="17" cy="21" r="5" fill="#2563EB" />
      <circle cx="31" cy="21" r="5" fill="#60A5FA" />
      <path d="M9 36c1.5-5 4.5-7.5 8-7.5s6.5 2.5 8 7.5z" fill="#2563EB" />
      <path d="M23 36c1.5-5 4.5-7.5 8-7.5s6.5 2.5 8 7.5z" fill="#60A5FA" />
    </svg>
  );
}

function Row({ title, description, checked, disabled, onChange }: { title: string; description: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-slate-200 bg-white p-3">
      <div className="space-y-1">
        <p className="text-sm font-medium text-slate-900">{title}</p>
        <p className="text-xs leading-5 text-slate-500">{description}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

export function ClassGroupPanel({ config, onChange, busy }: { config: TenantPluginConfig; onChange: (next: TenantPluginConfig) => void; busy: boolean }) {
  const section = config.classGroup;
  const update = (patch: Partial<TenantPluginConfig["classGroup"]>) => onChange({ ...config, classGroup: { ...section, ...patch } });
  const groupIdValid = /^\d{5,}$/.test(section.groupId.trim());

  return (
    <div className="space-y-4">
      <label className="grid gap-1 rounded-md border border-slate-200 bg-white p-3 text-sm font-medium text-slate-900">
        班级群号
        <Input
          inputMode="numeric"
          value={section.groupId}
          placeholder="例如 123456789"
          disabled={busy}
          onChange={(event) => update({ groupId: event.target.value.replace(/\D/g, "").slice(0, 20) })}
        />
        <span className={`text-xs font-normal ${groupIdValid || !section.groupId ? "text-slate-500" : "text-rose-600"}`}>
          Bot 需要在这个群里。好友过滤和群同步都依赖群号，未填写时这两项不生效。
        </span>
      </label>
      <Row
        title="好友申请只放行群成员"
        description="收到好友申请时查询申请人是否在班级群：在群里随机延迟 30–90 秒后通过，不在群里或查询失败直接拒绝。"
        checked={section.friendFilterEnabled}
        disabled={busy}
        onChange={(value) => update({ friendFilterEnabled: value })}
      />
      <Row
        title="好友投稿自动开通"
        description="不再在首条私聊时注册并私发密码；Bot 好友发起投稿时自动开通投稿权限，需要网页登录时自己发送 #重置密码。非好友维持原提示。"
        checked={section.lazyRegisterEnabled}
        disabled={busy}
        onChange={(value) => update({ lazyRegisterEnabled: value })}
      />
      <Row
        title="发布后同步到班级群"
        description="QQ 空间发布成功后，把稿件卡片图和原图发到班级群；合并发布时整批发成一条合并转发。匿名稿只看得到卡片，不带投稿人 QQ。"
        checked={section.publishSyncEnabled}
        disabled={busy}
        onChange={(value) => update({ publishSyncEnabled: value })}
      />
    </div>
  );
}
