import { LegacySourceCutoverGate } from './migration/legacy-source-cutover-gate.js'

export class HostMutationGate extends LegacySourceCutoverGate {
  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.runLegacyMutation(operation)
  }
}
