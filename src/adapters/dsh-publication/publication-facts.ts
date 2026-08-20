import type { PublicationFactsPort } from '../../application/curation/index.js'
import {
  observePublicationEntry,
  observePublicationRoot,
  readPublicationText,
  verifyPublicationDirectoryIdentity,
} from './filesystem-cas.mjs'

export class NodePublicationFactsAdapter implements PublicationFactsPort {
  observeRoot(path: string) {
    return observePublicationRoot(path)
  }

  observeEntry(path: string) {
    return observePublicationEntry(path)
  }

  readExactText(path: string, maxBytes: number) {
    return readPublicationText(path, maxBytes)
  }

  verifyIdentity(path: string, expectedIdentityDigest: string): Promise<boolean> {
    return verifyPublicationDirectoryIdentity(path, expectedIdentityDigest)
  }
}
