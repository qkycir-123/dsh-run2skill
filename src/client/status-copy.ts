export type Run2skillHealthStatus = 'READY' | 'RECOVERING' | 'DEGRADED' | 'INCOMPATIBLE'

export function describeRun2skillHealth(status: Run2skillHealthStatus): string {
  if (status === 'INCOMPATIBLE') return 'run2skill 当前版本不兼容'
  if (status === 'DEGRADED') return 'run2skill 暂时降级'
  if (status === 'RECOVERING') return 'run2skill 正在恢复历史观察'
  return 'run2skill 已就绪'
}
