export type Run2skillHealthStatus = 'READY' | 'RECOVERING' | 'DEGRADED' | 'INCOMPATIBLE'

export function describeRun2skillHealth(status: Run2skillHealthStatus): string {
  if (status === 'INCOMPATIBLE') return 'Run2Skill 当前版本不兼容'
  if (status === 'DEGRADED') return 'Run2Skill 当前功能受限'
  if (status === 'RECOVERING') return 'Run2Skill 正在恢复历史观察'
  return 'Run2Skill 已就绪'
}
