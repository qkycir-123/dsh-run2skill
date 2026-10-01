/** Controlled native DSH transport probe; no external model request or credentials. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DshV2StageLlmClient } from '../../src/adapters/dsh-llm/v2-stage-client.js'
import { CompleteCatalogRecallWorker, deriveRecallCandidateId } from '../../src/application/recall/index.js'
import { V2LearningAttentionService } from '../../src/adapters/dsh-connection/v2-learning-attention-rpc.js'
import { ExperienceIntentV2Schema, SessionBatchV2Schema, deriveTurnObservationContentDigestV2 } from '../../src/domain/v2/index.js'
import { deriveProjectScopeIdentityDigest } from '../../src/domain/purge/index.js'
import { createMemoryRun2skillV2Domain } from '../../tests/support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from '../../tests/support/v2-fixtures.js'

const [modulesArgument, outputArgument] = process.argv.slice(2)
assert(modulesArgument && outputArgument, 'Usage: pnpm exec tsx probes/catalog-retry/probe.ts <isolated SDK node_modules> <new output directory>')
const modules = resolve(modulesArgument)
for (const name of ['dsh-llm', 'dsh-llm-deepseek']) {
  const metadata = JSON.parse(await readFile(join(modules, '@deepseek-ai', name, 'package.json'), 'utf8'))
  assert.equal(metadata.version, '0.2.0-rc.2')
}
const { Context } = await import(pathToFileURL(join(modules, '@deepseek-ai/cordis/lib/index.js')).href)
const { default: LlmRuntime } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-llm/lib/index.js')).href)
const { registerDeepSeekProvider, resolveAdapterOptions, catalogModelInfo } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-llm-deepseek/lib/index.js')).href)
let requests = 0
const server = createServer((request, response) => {
  requests += 1
  request.resume()
  response.writeHead(503, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Controlled temporary outage' } }))
})
await new Promise<void>(done => { server.listen(0, '127.0.0.1', done) })
const address = server.address()
assert(address !== null && typeof address === 'object')
const ctx = new Context()
const fiber = ctx.plugin(LlmRuntime)
await fiber
const fixture = createMinimalV2Fixtures()
const batch = SessionBatchV2Schema.parse(fixture.sessionBatch)
const connection = resolveAdapterOptions({ baseURL: `http://127.0.0.1:${address.port}`, thinking: 'disabled', reasoningEffort: 'off', models: [{ id: batch.routeSnapshot.model, contextWindow: 32000 }] })
registerDeepSeekProvider(ctx, batch.routeSnapshot.provider, {
  options: () => connection,
  resolveAuth: async () => ({ headers: {} }),
  discoverModels: async (provider: string) => connection.models.map((model: unknown) => catalogModelInfo(provider, model)),
})
const client = new DshV2StageLlmClient(ctx.llm)
try {
  const domain = createMemoryRun2skillV2Domain()
  const scope = { kind: 'WORKSPACE' as const, generation: 1, workspaceId: 'probe-workspace' }
  const scopeBinding = { status: 'PROJECT' as const, workspaceId: scope.workspaceId, scopeIdentityDigest: deriveProjectScopeIdentityDigest('/probe-workspace') }
  const observation = { ...fixture.turnObservation, scopeBinding, contentDigest: deriveTurnObservationContentDigestV2({ ...fixture.turnObservation, scopeBinding }) }
  await domain.table('turn_observations').put(observation.observationId, observation)
  const intent = ExperienceIntentV2Schema.parse({
    ...fixture.proposalReadyIntent, status: 'RUN2SKILL_OWNED', lineageId: undefined,
    recall: { state: 'NOT_STARTED', complete: false, summaryScanComplete: false, candidates: [] },
    coverage: { state: 'NOT_STARTED', retryUsed: false },
    generation: { state: 'NOT_STARTED', userRetryUsed: false, staleRefreshUsed: false, receipts: [] }, stageCalls: [],
  })
  await domain.table('session_batches').put(batch.batchId, batch)
  await domain.table('experience_intents').put(intent.intentId, intent)
  const facts = { name: 'probe-skill', description: 'Synthetic test workflow', provider: 'filesystem', source: 'project-dsh', scope: 'PROJECT' as const, writable: true, rootIdentityDigest: 'a'.repeat(64) }
  const summary = { ...facts, candidateId: deriveRecallCandidateId(facts) }
  const worker = () => new CompleteCatalogRecallWorker(domain, {
    catalog: { snapshot: async () => ({ complete: true, runtimeCatalogDigest: 'b'.repeat(64), pendingCatalogDigest: 'c'.repeat(64), catalogEpoch: 1, catalogMutationReceiptDigest: 'd'.repeat(64), summaries: [summary] }), read: async () => undefined },
    classifier: { classify: input => client.classifyCatalog(input) },
  })
  await worker().runOnce()
  const stopped = ExperienceIntentV2Schema.parse(domain.experienceIntents.get(intent.intentId))
  assert.equal(stopped.recall.incompleteReason, 'CATALOG_SCAN_TEMPORARY_FAILED')
  assert.equal(requests, 1)
  const attention = new V2LearningAttentionService(domain, async workspaceId => ({ workspaceId, canonicalPath: '/probe-workspace' }))
  const action = (await attention.project(scope))[0]!
  assert.deepEqual(action.availableActions, ['RETRY', 'DISMISS'])
  const request = { apiVersion: 1, workItemId: action.subjectId, workItemRevision: stopped.revision, currentScope: scope, action: { actionKey: action.actionKey, subjectId: action.subjectId, kind: action.kind } }
  const handler = attention.handler()
  assert.equal((await handler('learning/issues/retry', request, new AbortController().signal)).ok, true)
  assert.equal((await handler('learning/issues/retry', request, new AbortController().signal)).ok, true)
  await worker().recover()
  await worker().runOnce()
  const final = ExperienceIntentV2Schema.parse(domain.experienceIntents.get(intent.intentId))
  const manualAuthorizations = final.reasonReceipts.filter(receipt => receipt.reasonCode === 'CATALOG_SCAN_RETRY_AUTHORIZED').length
  assert.equal(manualAuthorizations, 1)
  assert.equal(requests, 2)
  assert.equal(final.stageCalls.filter(call => call.outcome === 'FAILED').length, 2)
  assert.deepEqual((await attention.project(scope))[0]!.availableActions, ['DISMISS'])
  assert.equal(await worker().runOnce(), 'IDLE')
  const result = { sdk: '0.2.0-rc.2', controlledStatus: 503, externalModelCalled: false, requests, manualAuthorizations, duplicateRequestsAddedCalls: false, failureHistoryPreserved: true, detectionPreserved: JSON.stringify(domain.sessionBatches.get(batch.batchId)?.detector) === JSON.stringify(batch.detector), secondRetryAvailable: false }
  assert(result.detectionPreserved)
  await mkdir(resolve(outputArgument), { recursive: true })
  await writeFile(join(resolve(outputArgument), 'catalog-retry.json'), JSON.stringify(result, null, 2), { flag: 'wx' })
  console.log('NATIVE_DSH_CATALOG_RETRY=PASS')
} finally {
  client.dispose()
  await fiber.dispose()
  await new Promise<void>(done => { server.close(() => { done() }) })
}
