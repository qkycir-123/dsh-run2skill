import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NodePublicationFactsAdapter } from '../src/adapters/dsh-publication/publication-facts.js'

describe('NodePublicationFactsAdapter', () => {
  it('derives absent and existing root identities without guessing through links', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'run2skill-facts-'))
    if (!basename(workspace).startsWith('run2skill-facts-')) throw new Error('unsafe cleanup')
    try {
      const facts = new NodePublicationFactsAdapter()
      const root = join(workspace, '.dsh', 'skills')
      const absent = await facts.observeRoot(root)
      expect(absent).toMatchObject({
        status: 'ABSENT',
        canonicalExistingAncestorPath: workspace,
        missingSegments: ['.dsh', 'skills'],
      })
      if (absent.status !== 'ABSENT') throw new Error('expected absent root')
      expect(await facts.verifyIdentity(workspace, absent.ancestorIdentityDigest)).toBe(true)

      await mkdir(root, { recursive: true })
      const existing = await facts.observeRoot(root)
      expect(existing).toMatchObject({ status: 'EXISTING', canonicalRootPath: root })
      if (existing.status !== 'EXISTING') throw new Error('expected existing root')
      expect(await facts.verifyIdentity(root, existing.rootIdentityDigest)).toBe(true)

      const skill = join(root, 'SKILL.md')
      await writeFile(skill, '# Exact\n')
      expect(await facts.observeEntry(skill)).toEqual({ status: 'FILE' })
      expect(await facts.readExactText(skill, 64)).toEqual({ status: 'AVAILABLE', text: '# Exact\n' })
      expect(await facts.readExactText(skill, 2)).toEqual({ status: 'UNAVAILABLE' })
      expect((await lstat(root)).isDirectory()).toBe(true)
      expect(await readFile(skill, 'utf8')).toBe('# Exact\n')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
