import { describe, expect, it, vi } from 'vitest'
import {
  Run2skillV2PipelineRuntime,
  type V2PipelineBatchScheduler,
  type V2PipelineStageWorker,
} from '../src/application/pipeline/index.js'

describe('v2 pipeline runtime', () => {
  it('recovers durable stages in the declared order before starting and draining the batch queue', async () => {
    const order: string[] = []
    const stage = (name: string): V2PipelineStageWorker => ({
      recover: async () => { order.push(`${name}:recover`) },
      runOnce: async () => { order.push(`${name}:run`); return 'IDLE' },
    })
    const detector = stage('detector')
    const generation = stage('generation')
    const batch: V2PipelineBatchScheduler = {
      start: async () => { order.push('batch:start') },
      prepareSessionWindow: async () => undefined,
      observe: async () => undefined,
      wake: () => undefined,
      settle: async () => undefined,
      dispose: async () => { order.push('batch:dispose') },
    }
    const runtime = new Run2skillV2PipelineRuntime({
      batchScheduler: batch,
      stages: [detector, generation],
      recoveryOrder: [generation, detector],
    })

    await runtime.start()
    await runtime.start()
    expect(order).toEqual([
      'generation:recover', 'detector:recover', 'batch:start',
      'detector:run', 'generation:run',
    ])
    await runtime.dispose()
    expect(order.at(-1)).toBe('batch:dispose')
  })

  it('does not report a failed recovery as started and permits a clean retry', async () => {
    let recoveries = 0
    let starts = 0
    const stage: V2PipelineStageWorker = {
      recover: async () => {
        recoveries += 1
        if (recoveries === 1) throw new Error('synthetic recovery failure')
      },
      runOnce: async () => 'IDLE',
    }
    const batch: V2PipelineBatchScheduler = {
      start: async () => { starts += 1 },
      prepareSessionWindow: async () => undefined,
      observe: async () => undefined,
      wake: () => undefined,
      settle: async () => undefined,
      dispose: async () => undefined,
    }
    const runtime = new Run2skillV2PipelineRuntime({
      batchScheduler: batch,
      stages: [stage],
      recoveryOrder: [stage],
    })

    await expect(runtime.start()).rejects.toThrow('synthetic recovery failure')
    await expect(runtime.start()).resolves.toBeUndefined()
    expect(recoveries).toBe(2)
    expect(starts).toBe(1)
    await runtime.dispose()
  })

  it('coalesces concurrent disposal through the same scheduler close', async () => {
    const dispose = vi.fn(async () => undefined)
    const batch: V2PipelineBatchScheduler = {
      start: async () => undefined,
      prepareSessionWindow: async () => undefined,
      observe: async () => undefined,
      wake: () => undefined,
      settle: async () => undefined,
      dispose,
    }
    const stage: V2PipelineStageWorker = { runOnce: async () => 'IDLE' }
    const runtime = new Run2skillV2PipelineRuntime({
      batchScheduler: batch,
      stages: [stage],
      recoveryOrder: [],
    })
    await runtime.start()

    await Promise.all([runtime.dispose(), runtime.dispose()])
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('runs one scheduler feedback check for each counted stage transition', async () => {
    const afterStageTransition = vi.fn(async () => undefined)
    const batch: V2PipelineBatchScheduler = {
      start: async () => undefined,
      prepareSessionWindow: async () => undefined,
      observe: async () => undefined,
      afterStageTransition,
      wake: () => undefined,
      settle: async () => undefined,
      dispose: async () => undefined,
    }
    const stage: V2PipelineStageWorker = { runOnce: async () => 'PROCESSED' }
    const runtime = new Run2skillV2PipelineRuntime({
      batchScheduler: batch,
      stages: [stage],
      recoveryOrder: [],
      maxTransitionsPerDrain: 2,
    })

    await expect(runtime.start()).rejects.toThrow('Run2Skill v2 pipeline drain limit reached')
    expect(afterStageTransition).toHaveBeenCalledTimes(2)
    await runtime.dispose()
  })

  it('signals active work, starts no next item, and waits for the active tail before disposal completes', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const abortActive = vi.fn()
    const disposeBatch = vi.fn(async () => undefined)
    const batch: V2PipelineBatchScheduler = {
      start: async () => undefined,
      prepareSessionWindow: async () => undefined,
      observe: async () => undefined,
      wake: () => undefined,
      settle: async () => undefined,
      dispose: disposeBatch,
    }
    let runOnceCalls = 0
    const stage: V2PipelineStageWorker = {
      runOnce: async () => {
        runOnceCalls += 1
        started.resolve()
        await release.promise
        return 'PROCESSED'
      },
    }
    const runtime = new Run2skillV2PipelineRuntime({
      batchScheduler: batch,
      stages: [stage],
      recoveryOrder: [],
      abortActive,
    })
    const starting = runtime.start()
    await started.promise

    const disposing = runtime.dispose()
    expect(abortActive).toHaveBeenCalledOnce()
    expect(disposeBatch).toHaveBeenCalledOnce()
    let settled = false
    void disposing.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    release.resolve()
    await starting
    await disposing
    expect(runOnceCalls).toBe(1)
  })
})
