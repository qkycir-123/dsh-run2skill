import { describe, expect, it, vi } from 'vitest'
import { DshPublicationReadbackAdapter } from '../src/adapters/dsh-skills/publication-readback.js'
import type { SkillCatalogPort, SkillCatalogSnapshotProjection } from '../src/domain/learn/index.js'
import { ProposalReviewStore } from '../src/adapters/dsh-storage/proposal-review-store.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeCreateProposalSnapshot, makeLearnedWorkItem } from './support/review-fixture.js'
import { proposalRefOf } from '../src/domain/review/index.js'

interface View { readonly cwd: string }

async function approvedItem() {
  const domain = createMemoryRun2skillDomain()
  const learned = makeLearnedWorkItem()
  domain.workItems.set(learned.workItemId, learned)
  const proposal = makeCreateProposalSnapshot(learned)
  const store = new ProposalReviewStore(domain, () => '2026-08-20T00:00:01.000Z')
  const staged = await store.stage(learned.workItemId, learned.revision, proposal)
  return (await store.approve(
    learned.workItemId,
    staged.item.revision,
    proposalRefOf(proposal),
  )).item
}

function exactCatalog(item: Awaited<ReturnType<typeof approvedItem>>): SkillCatalogPort<View> {
  const proposal = item.review!.proposal
  const binding = proposal.actionBinding
  if (binding.kind === 'DISCARD') throw new Error('unexpected DISCARD')
  const summary = {
    name: proposal.name,
    description: proposal.description,
    whenToUse: proposal.whenToUse,
    invocation: proposal.invocation,
    provider: binding.rootBinding.expectedProvider,
    source: binding.rootBinding.expectedSource,
  }
  return {
    async snapshot() { return { skills: [summary], complete: true } },
    async get() {
      return {
        ...summary,
        path: binding.targetBinding.skillFilePath,
        content: '# Generated file hygiene',
      }
    },
  }
}

describe('DshPublicationReadbackAdapter', () => {
  it('waits through an incomplete observation and confirms exact structured get facts', async () => {
    const item = await approvedItem()
    const exact = exactCatalog(item)
    let snapshots = 0
    const skills: SkillCatalogPort<View> = {
      async snapshot(view): Promise<SkillCatalogSnapshotProjection> {
        snapshots += 1
        return snapshots === 1 ? { skills: [], complete: false } : await exact.snapshot(view)
      },
      get: (name, view) => exact.get(name, view),
    }
    const wait = vi.fn(async () => undefined)
    const adapter = new DshPublicationReadbackAdapter(
      skills,
      () => ({ cwd: 'D:\\workspace' }),
      { attempts: 3, wait },
    )

    await expect(adapter.confirmExact(item)).resolves.toEqual({
      status: 'CONFIRMED',
      observedHash: item.review!.proposal.skillBytesDigest,
    })
    expect(wait).toHaveBeenCalledOnce()
  })

  it('distinguishes a complete wrong winner from bounded incomplete timeout', async () => {
    const item = await approvedItem()
    const exact = exactCatalog(item)
    const changed: SkillCatalogPort<View> = {
      snapshot: (view) => exact.snapshot(view),
      async get(name, view) {
        const loaded = await exact.get(name, view)
        return loaded === undefined ? undefined : { ...loaded, path: 'D:\\other\\SKILL.md' }
      },
    }
    const timeout: SkillCatalogPort<View> = {
      async snapshot() { return { skills: [], complete: false } },
      async get() { return undefined },
    }

    await expect(new DshPublicationReadbackAdapter(
      changed,
      () => ({ cwd: 'D:\\workspace' }),
      { attempts: 2, wait: async () => undefined },
    ).confirmExact(item)).resolves.toEqual({ status: 'CHANGED', code: 'REGISTRY_READBACK_CHANGED' })
    await expect(new DshPublicationReadbackAdapter(
      timeout,
      () => ({ cwd: 'D:\\workspace' }),
      { attempts: 2, wait: async () => undefined },
    ).confirmExact(item)).resolves.toEqual({ status: 'TIMEOUT', code: 'READBACK_TIMEOUT' })
  })
})
