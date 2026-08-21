import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createAttentionRpcHandler } from '../../src/adapters/dsh-connection/attention-rpc.js'
import { RuntimeNotices } from '../../src/application/capture/runtime-notices.js'
import { createMemoryRun2skillDomain } from '../../tests/support/memory-run2skill-domain.js'
import { ProposalReviewStore } from '../../src/adapters/dsh-storage/proposal-review-store.js'
import { PublicationSagaStore } from '../../src/adapters/dsh-storage/publication-saga-store.js'
import { createProposalReviewRpcHandler } from '../../src/adapters/dsh-connection/proposal-review-rpc.js'
import { proposalRefOf } from '../../src/domain/review/index.js'
import { makeCreateProposalSnapshot, makeLearnedWorkItem } from '../../tests/support/review-fixture.js'

const output = process.argv[2]
if (output === undefined) throw new Error('usage: tsx build-ui-probe-fixture.ts <output-json>')

const signal = () => new AbortController().signal
const workspace = async (workspaceId: string) => workspaceId === 'workspace-fixture'
  ? { workspaceId, canonicalPath: 'D:\\workspace' }
  : undefined

async function pendingFixture() {
  const domain = createMemoryRun2skillDomain()
  const item = makeLearnedWorkItem()
  domain.workItems.set(item.workItemId, item)
  const staged = await new ProposalReviewStore(domain).stage(
    item.workItemId,
    item.revision,
    makeCreateProposalSnapshot(item),
  )
  const review = createProposalReviewRpcHandler(() => domain)
  const ref = proposalRefOf(staged.item.review!.proposal)
  const base = { apiVersion: 1 as const, workspaceId: 'workspace-fixture' }
  const fixture = {
    attention: await createAttentionRpcHandler(
      () => domain,
      new RuntimeNotices(),
      workspace,
    )('attention', base, signal()),
    list: await review('proposals/list', base, signal()),
    detail: await review('proposals/get', { apiVersion: 1, proposalId: ref.proposalId }, signal()),
    approve: await review('proposals/approve', {
      apiVersion: 1,
      workItemId: staged.item.workItemId,
      workItemRevision: staged.item.revision,
      proposalRef: ref,
    }, signal()),
  }
  await domain.close()
  return fixture
}

async function failedFixture() {
  const domain = createMemoryRun2skillDomain()
  const item = makeLearnedWorkItem()
  domain.workItems.set(item.workItemId, item)
  const reviews = new ProposalReviewStore(domain)
  const staged = await reviews.stage(item.workItemId, item.revision, makeCreateProposalSnapshot(item))
  const approved = await reviews.approve(
    staged.item.workItemId,
    staged.item.revision,
    proposalRefOf(staged.item.review!.proposal),
  )
  const failed = await new PublicationSagaStore(domain).fail(
    approved.item.workItemId,
    'PUBLISH_FAILED',
    'READBACK_TIMEOUT',
    true,
  )
  const review = createProposalReviewRpcHandler(() => domain)
  const ref = proposalRefOf(failed.review!.proposal)
  const base = { apiVersion: 1 as const, workspaceId: 'workspace-fixture' }
  const attention = await createAttentionRpcHandler(
    () => domain,
    new RuntimeNotices(),
    workspace,
  )('attention', base, signal())
  const list = await review('proposals/list', base, signal())
  const detail = await review('proposals/get', { apiVersion: 1, proposalId: ref.proposalId }, signal())
  const retry = await review('proposals/retry', {
    apiVersion: 1,
    workItemId: failed.workItemId,
    workItemRevision: failed.revision,
    proposalRef: ref,
  }, signal())
  const afterRetry = await review('proposals/list', base, signal())
  await domain.close()
  return {
    attention,
    list,
    detail,
    retry,
    afterRetry,
    doneAttention: attention.ok
      ? { ok: true as const, value: { ...attention.value, actions: [] } }
      : attention,
  }
}

await writeFile(resolve(output), JSON.stringify({
  kind: 'run2skill-controlled-web-probe-fixture-v1',
  review: await pendingFixture(),
  failure: await failedFixture(),
}))
