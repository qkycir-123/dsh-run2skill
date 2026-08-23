import type { Run2skillV2Domain } from '../../adapters/dsh-storage/v2-types.js'
import {
  ExperienceIntentV2Schema,
  OwnershipEvidenceV2Schema,
  SessionBatchV2Schema,
  deriveOwnershipClaimIdV2,
  deriveOwnershipEvidenceDigestV2,
  deriveOwnershipInputDigestV2,
  deriveOwnershipReceiptDigestV2,
  type ExperienceIntentV2,
  type OwnershipEvidenceV2,
  type SessionBatchV2,
} from '../../domain/v2/index.js'

export interface OwnershipObservationPort {
  observe(input: {
    readonly batch: SessionBatchV2
    readonly intent: ExperienceIntentV2
    readonly inputDigest: string
  }): Promise<OwnershipEvidenceV2>
}

export interface AgentFirstOwnershipOptions {
  readonly observation: OwnershipObservationPort
  readonly quiescence: {
    validate(intentId: string): Promise<'VALID' | 'STALE' | 'INCOMPLETE'>
  }
  readonly now?: () => number
}

type TerminalDecision = {
  readonly state: 'RESOLVED_BY_AGENT' | 'NEEDS_CONFIRMATION' | 'RUN2SKILL_OWNED'
  readonly reasonCode: string
  readonly resolvedCandidateId?: string
  readonly resolvedCandidateBodyDigest?: string
}

const unavailable = (
  reasonCode: Extract<OwnershipEvidenceV2, { status: 'UNAVAILABLE' }>['reasonCode'],
): OwnershipEvidenceV2 => ({ status: 'UNAVAILABLE', reasonCode })

export class AgentFirstOwnershipCoordinator {
  readonly #intents
  readonly #batches
  readonly #observation: OwnershipObservationPort
  readonly #quiescence: AgentFirstOwnershipOptions['quiescence']
  readonly #now: () => number

  constructor(domain: Run2skillV2Domain, options: AgentFirstOwnershipOptions) {
    this.#intents = domain.table('experience_intents')
    this.#batches = domain.table('session_batches')
    this.#observation = options.observation
    this.#quiescence = options.quiescence
    this.#now = options.now ?? Date.now
  }

  async runOnce(): Promise<'IDLE' | 'PROCESSED'> {
    const candidate = [...this.#intents.entries()]
      .map(([, intent]) => ExperienceIntentV2Schema.parse(intent))
      .filter(intent => intent.status === 'READY')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.ordinal - right.ordinal)[0]
    if (candidate === undefined) return 'IDLE'
    if (await this.#validateQuiescence(candidate.intentId) !== 'VALID') {
      await this.#requeueForQuiescence(candidate.intentId)
      return 'PROCESSED'
    }

    const claimId = deriveOwnershipClaimIdV2({ intentId: candidate.intentId, intentRevision: candidate.revision })
    let didClaim = false
    const claimed = await this.#intents.update(candidate.intentId, current => {
      const parsed = ExperienceIntentV2Schema.parse(current)
      if (parsed.status !== 'READY') return parsed
      didClaim = true
      return ExperienceIntentV2Schema.parse({
        ...parsed,
        revision: parsed.revision + 1,
        status: 'OWNERSHIP_ARBITRATING',
        ownership: {
          state: 'ARBITRATING', claimId,
          claimedIntentRevision: parsed.revision,
          claimedAt: this.#isoNow(),
        },
        updatedAt: this.#isoNow(),
      })
    })
    if (!didClaim || claimed.status !== 'OWNERSHIP_ARBITRATING' || claimed.ownership.claimId !== claimId) return 'PROCESSED'

    if (await this.#validateQuiescence(claimed.intentId) !== 'VALID') {
      await this.#requeueForQuiescence(claimed.intentId)
      return 'PROCESSED'
    }

    await this.#observeAndFinalize(claimed)
    return 'PROCESSED'
  }

  async recover(): Promise<void> {
    const claimed = [...this.#intents.entries()]
      .map(([, intent]) => ExperienceIntentV2Schema.parse(intent))
      .filter(intent => intent.status === 'OWNERSHIP_ARBITRATING')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.ordinal - right.ordinal)
    for (const intent of claimed) {
      if (await this.#validateQuiescence(intent.intentId) !== 'VALID') {
        await this.#requeueForQuiescence(intent.intentId)
        continue
      }
      if (intent.ownership.evidence === undefined) {
        await this.#sealEvidence(intent, unavailable('OBSERVATION_OUTCOME_UNKNOWN'))
      } else if (intent.ownership.evidence.status === 'OBSERVED') {
        const batchValue = this.#batches.get(intent.batchId)
        if (batchValue !== undefined) {
          const parsedBatch = SessionBatchV2Schema.safeParse(batchValue)
          if (parsedBatch.success && this.#evidenceBindingIsValid(intent, parsedBatch.data, intent.ownership.evidence)) {
            await this.#recordEndObservation(intent.batchId, intent.ownership.evidence)
          }
        }
      }
      await this.#finalize(intent.intentId)
    }
  }

  async #observeAndFinalize(claimed: ExperienceIntentV2): Promise<void> {
    const batchValue = this.#batches.get(claimed.batchId)
    if (batchValue === undefined) {
      await this.#sealEvidence(claimed, unavailable('CLAIM_INPUT_UNAVAILABLE'))
      await this.#finalize(claimed.intentId)
      return
    }
    if (this.#baselineTimeIsInvalid(batchValue)) {
      await this.#sealEvidence(claimed, unavailable('BASELINE_TIME_INVALID'))
      await this.#finalize(claimed.intentId)
      return
    }
    const parsedBatch = SessionBatchV2Schema.safeParse(batchValue)
    if (!parsedBatch.success) {
      await this.#sealEvidence(claimed, unavailable('CLAIM_INPUT_UNAVAILABLE'))
      await this.#finalize(claimed.intentId)
      return
    }
    const batch = parsedBatch.data
    if (claimed.completeness.status !== 'COMPLETE') {
      await this.#sealEvidence(claimed, unavailable('INTENT_INCOMPLETE'))
      await this.#finalize(claimed.intentId)
      return
    }
    if (!batch.batchManifestBaseline.complete) {
      await this.#sealEvidence(claimed, unavailable('BASELINE_INCOMPLETE'))
      await this.#finalize(claimed.intentId)
      return
    }

    const boundClaim = await this.#bindInput(claimed, batch)
    const inputDigest = boundClaim.ownership.inputDigest!
    let evidence: OwnershipEvidenceV2
    try {
      const raw = await this.#observation.observe({ batch, intent: boundClaim, inputDigest })
      const parsed = OwnershipEvidenceV2Schema.safeParse(raw)
      evidence = parsed.success && (
        parsed.data.status !== 'OBSERVED' || this.#evidenceBindingIsValid(boundClaim, batch, parsed.data)
      ) ? parsed.data : unavailable('OBSERVATION_INVALID')
    } catch {
      evidence = unavailable('OBSERVATION_FAILED')
    }
    if (await this.#validateQuiescence(claimed.intentId) !== 'VALID') {
      await this.#requeueForQuiescence(claimed.intentId)
      return
    }
    await this.#sealEvidence(boundClaim, evidence)
    if (evidence.status === 'OBSERVED') await this.#recordEndObservation(batch.batchId, evidence)
    if (await this.#validateQuiescence(claimed.intentId) !== 'VALID') {
      await this.#requeueForQuiescence(claimed.intentId)
      return
    }
    await this.#finalize(claimed.intentId)
  }

  async #bindInput(claimed: ExperienceIntentV2, batch: SessionBatchV2): Promise<ExperienceIntentV2> {
    const claimId = claimed.ownership.claimId
    if (claimId === undefined) throw new Error('Ownership claim is missing its identity')
    const inputDigest = deriveOwnershipInputDigestV2({
      batchId: batch.batchId,
      intentId: claimed.intentId,
      claimId,
      batchEndTurnEndSeq: batch.lastTurnEndSeq,
      batchFrozenAt: batch.createdAt,
      observationManifestDigest: batch.observationManifestDigest,
      baseline: batch.batchManifestBaseline,
    })
    return this.#intents.update(claimed.intentId, current => {
      const parsed = ExperienceIntentV2Schema.parse(current)
      if (parsed.status !== 'OWNERSHIP_ARBITRATING') return parsed
      if (parsed.ownership.claimId !== claimId) throw new Error('Ownership claim changed before input binding')
      if (parsed.ownership.inputDigest !== undefined) {
        if (parsed.ownership.inputDigest !== inputDigest) throw new Error('Ownership claim already has a different input binding')
        return parsed
      }
      return ExperienceIntentV2Schema.parse({
        ...parsed,
        revision: parsed.revision + 1,
        ownership: { ...parsed.ownership, inputDigest },
        updatedAt: this.#isoNow(),
      })
    })
  }

  async #sealEvidence(claimed: ExperienceIntentV2, evidence: OwnershipEvidenceV2): Promise<void> {
    const evidenceDigest = deriveOwnershipEvidenceDigestV2(evidence)
    await this.#intents.update(claimed.intentId, current => {
      const parsed = ExperienceIntentV2Schema.parse(current)
      if (parsed.status !== 'OWNERSHIP_ARBITRATING') return parsed
      if (parsed.ownership.claimId !== claimed.ownership.claimId) throw new Error('Ownership claim changed before evidence seal')
      if (parsed.ownership.evidence !== undefined) {
        if (parsed.ownership.evidenceDigest !== evidenceDigest) throw new Error('Ownership claim already has different sealed evidence')
        return parsed
      }
      return ExperienceIntentV2Schema.parse({
        ...parsed,
        revision: parsed.revision + 1,
        ownership: { ...parsed.ownership, evidence, evidenceDigest },
        updatedAt: this.#isoNow(),
      })
    })
  }

  async #recordEndObservation(batchId: string, evidence: Extract<OwnershipEvidenceV2, { status: 'OBSERVED' }>): Promise<void> {
    await this.#batches.update(batchId, current => {
      const batch = SessionBatchV2Schema.parse(current)
      if (batch.manifestEndObservation.state === 'OBSERVED') return batch
      return SessionBatchV2Schema.parse({
        ...batch,
        revision: batch.revision + 1,
        manifestEndObservation: {
          state: 'OBSERVED', observedAt: evidence.observedAt,
          ...evidence.endManifest,
        },
        updatedAt: this.#isoNow(),
      })
    })
  }

  async #finalize(intentId: string): Promise<void> {
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.status !== 'OWNERSHIP_ARBITRATING') return intent
      const evidence = intent.ownership.evidence
      const evidenceDigest = intent.ownership.evidenceDigest
      const claimId = intent.ownership.claimId
      const claimedIntentRevision = intent.ownership.claimedIntentRevision
      if (evidence === undefined || evidenceDigest === undefined || claimId === undefined || claimedIntentRevision === undefined) {
        throw new Error('Cannot finalize ownership without a sealed claim and evidence')
      }
      const batchValue = this.#batches.get(intent.batchId)
      const parsedBatch = batchValue === undefined ? undefined : SessionBatchV2Schema.safeParse(batchValue)
      const batch = parsedBatch?.success ? parsedBatch.data : undefined
      const decision = this.#decide(intent, batch, evidence)
      const receiptFacts = {
        intentId: intent.intentId,
        claimedIntentRevision,
        claimId,
        decision: decision.state,
        evidenceDigest,
        inputDigest: intent.ownership.inputDigest,
        reasonCode: decision.reasonCode,
        resolvedCandidateId: decision.resolvedCandidateId,
        resolvedCandidateBodyDigest: decision.resolvedCandidateBodyDigest,
      }
      return ExperienceIntentV2Schema.parse({
        ...intent,
        revision: intent.revision + 1,
        status: decision.state,
        ownership: {
          ...intent.ownership,
          state: decision.state,
          reasonCode: decision.reasonCode,
          ...(decision.resolvedCandidateId === undefined ? {} : { resolvedCandidateId: decision.resolvedCandidateId }),
          ...(decision.resolvedCandidateBodyDigest === undefined ? {} : { resolvedCandidateBodyDigest: decision.resolvedCandidateBodyDigest }),
          receiptDigest: deriveOwnershipReceiptDigestV2(receiptFacts),
        },
        updatedAt: this.#isoNow(),
      })
    })
  }

  #decide(intent: ExperienceIntentV2, batch: SessionBatchV2 | undefined, evidence: OwnershipEvidenceV2): TerminalDecision {
    if (evidence.status === 'UNAVAILABLE') return { state: 'NEEDS_CONFIRMATION', reasonCode: evidence.reasonCode }
    if (batch === undefined) return { state: 'NEEDS_CONFIRMATION', reasonCode: 'CLAIM_INPUT_UNAVAILABLE' }
    if (intent.completeness.status !== 'COMPLETE') return { state: 'NEEDS_CONFIRMATION', reasonCode: 'INTENT_INCOMPLETE' }
    if (!batch.batchManifestBaseline.complete) return { state: 'NEEDS_CONFIRMATION', reasonCode: 'BASELINE_INCOMPLETE' }
    if (!this.#evidenceBindingIsValid(intent, batch, evidence)) {
      return { state: 'NEEDS_CONFIRMATION', reasonCode: 'OBSERVATION_INVALID' }
    }
    if (!evidence.endManifest.complete) return { state: 'NEEDS_CONFIRMATION', reasonCode: 'END_MANIFEST_INCOMPLETE' }
    if (!evidence.catalogComplete) return { state: 'NEEDS_CONFIRMATION', reasonCode: 'CATALOG_INCOMPLETE' }
    if (!evidence.toolEvidenceComplete) return { state: 'NEEDS_CONFIRMATION', reasonCode: 'TOOL_EVIDENCE_INCOMPLETE' }

    const recordedEnd = batch.manifestEndObservation
    if (
      recordedEnd.state !== 'OBSERVED'
      || recordedEnd.rootManifestDigest !== evidence.endManifest.rootManifestDigest
      || recordedEnd.runtimeCatalogDigest !== evidence.endManifest.runtimeCatalogDigest
      || recordedEnd.complete !== evidence.endManifest.complete
    ) {
      return { state: 'NEEDS_CONFIRMATION', reasonCode: 'END_OBSERVATION_CHANGED' }
    }
    if (evidence.changedCandidates.some(candidate => !candidate.exactReadbackComplete)) {
      return { state: 'NEEDS_CONFIRMATION', reasonCode: 'CANDIDATE_READBACK_INCOMPLETE' }
    }
    if (evidence.agentActivity === 'WRITE_FAILED') return { state: 'NEEDS_CONFIRMATION', reasonCode: 'AGENT_WRITE_FAILED' }
    if (evidence.agentActivity === 'BODY_GENERATED') return { state: 'NEEDS_CONFIRMATION', reasonCode: 'AGENT_BODY_GENERATED' }
    if (evidence.agentActivity === 'AMBIGUOUS') return { state: 'NEEDS_CONFIRMATION', reasonCode: 'AGENT_ACTIVITY_AMBIGUOUS' }
    if (evidence.changedCandidates.some(candidate => candidate.writeAttribution === 'UNKNOWN')) {
      return { state: 'NEEDS_CONFIRMATION', reasonCode: 'WRITE_ATTRIBUTION_UNKNOWN' }
    }
    if (evidence.changedCandidates.some(candidate => candidate.intentBinding === 'UNKNOWN')) {
      return { state: 'NEEDS_CONFIRMATION', reasonCode: 'INTENT_BINDING_UNKNOWN' }
    }

    const manifestUnchanged = (
      evidence.endManifest.rootManifestDigest === batch.batchManifestBaseline.rootManifestDigest
      && evidence.endManifest.runtimeCatalogDigest === batch.batchManifestBaseline.runtimeCatalogDigest
    )
    if (manifestUnchanged) {
      if (evidence.changedCandidates.length === 0 && evidence.agentActivity === 'NONE') {
        return { state: 'RUN2SKILL_OWNED', reasonCode: 'NO_AGENT_SKILL_ACTIVITY' }
      }
      if (evidence.agentActivity !== 'WRITE_SUCCEEDED') {
        return { state: 'NEEDS_CONFIRMATION', reasonCode: 'OBSERVATION_CONTRADICTORY' }
      }
    }

    if (!manifestUnchanged && evidence.changedCandidates.length === 0) {
      return { state: 'NEEDS_CONFIRMATION', reasonCode: 'MANIFEST_CHANGE_UNATTRIBUTED' }
    }
    if (!manifestUnchanged && evidence.agentActivity !== 'WRITE_SUCCEEDED') {
      return { state: 'NEEDS_CONFIRMATION', reasonCode: 'MANIFEST_CHANGE_UNATTRIBUTED' }
    }
    const matches = evidence.changedCandidates.filter(candidate => (
      candidate.writeAttribution === 'AGENT_WRITE_SUCCEEDED' && candidate.intentBinding === 'MATCH'
    ))
    if (matches.length === 0) return { state: 'NEEDS_CONFIRMATION', reasonCode: 'AGENT_WRITE_NOT_BOUND' }
    if (matches.length > 1) return { state: 'NEEDS_CONFIRMATION', reasonCode: 'MULTIPLE_AGENT_MATCHES' }
    const match = matches[0]!
    return {
      state: 'RESOLVED_BY_AGENT', reasonCode: 'AGENT_SAVED_MATCHING_SKILL',
      resolvedCandidateId: match.candidateId,
      resolvedCandidateBodyDigest: match.bodyDigest!,
    }
  }

  #evidenceBindingIsValid(
    intent: ExperienceIntentV2,
    batch: SessionBatchV2,
    evidence: Extract<OwnershipEvidenceV2, { status: 'OBSERVED' }>,
  ): boolean {
    const claimId = intent.ownership.claimId
    const inputDigest = intent.ownership.inputDigest
    if (claimId === undefined || inputDigest === undefined) return false
    const expectedInputDigest = deriveOwnershipInputDigestV2({
      batchId: batch.batchId,
      intentId: intent.intentId,
      claimId,
      batchEndTurnEndSeq: batch.lastTurnEndSeq,
      batchFrozenAt: batch.createdAt,
      observationManifestDigest: batch.observationManifestDigest,
      baseline: batch.batchManifestBaseline,
    })
    return (
      inputDigest === expectedInputDigest
      && evidence.inputDigest === expectedInputDigest
      && evidence.observedAfterTurnEndSeq === batch.lastTurnEndSeq
      && Date.parse(evidence.observedAt) >= Date.parse(batch.createdAt)
      && Date.parse(evidence.observedAt) >= Date.parse(batch.batchManifestBaseline.observedAt)
    )
  }

  #baselineTimeIsInvalid(batch: SessionBatchV2): boolean {
    return Date.parse(batch.batchManifestBaseline.observedAt) > Date.parse(batch.createdAt)
  }

  async #validateQuiescence(intentId: string): Promise<'VALID' | 'STALE' | 'INCOMPLETE'> {
    try {
      return await this.#quiescence.validate(intentId)
    } catch {
      return 'INCOMPLETE'
    }
  }

  async #requeueForQuiescence(intentId: string): Promise<void> {
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (!['READY', 'OWNERSHIP_ARBITRATING'].includes(intent.status)) return intent
      return ExperienceIntentV2Schema.parse({
        ...intent,
        revision: intent.revision + 1,
        status: 'WAITING_FOR_QUIESCENCE',
        quiescence: {
          state: 'WAITING',
          batchLastTurnEndSeq: intent.quiescence.batchLastTurnEndSeq,
          requiredIdleMs: intent.quiescence.requiredIdleMs,
        },
        ownership: { state: 'NOT_STARTED' },
        updatedAt: this.#isoNow(),
      })
    })
  }

  #isoNow(): string {
    return new Date(this.#now()).toISOString()
  }
}
