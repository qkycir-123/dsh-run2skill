import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'

describe('CP-WEB-001 DSH 0.1.2 Remote and dual-face extension seams', () => {
  it('pins the Gateway, Remote protocol, and Client export contracts', async () => {
    const require = createRequire(import.meta.url)
    const gatewayPath = require.resolve('@deepseek-ai/dsh-api-gateway/package.json')
    const protocolPath = require.resolve('@deepseek-ai/dsh-typert-protocol/package.json')
    const connectionPath = require.resolve('@deepseek-ai/dsh-client-connection/package.json')
    for (const packagePath of [gatewayPath, protocolPath, connectionPath]) {
      const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as {
        version?: string
        exports?: Record<string, unknown>
      }
      expect(manifest.version).toBe('0.1.2-rc.1')
      expect(manifest.exports?.['.']).toBeDefined()
    }
    const gateway = JSON.parse(await readFile(gatewayPath, 'utf8')) as {
      exports?: Record<string, unknown>
      dsh?: { client?: { inject?: string[] } }
    }
    expect(gateway.exports?.['./client']).toBeDefined()
    expect(gateway.dsh?.client?.inject).toEqual([
      '@deepseek-ai/dsh-typert-registry',
      '@deepseek-ai/dsh-client-connection',
    ])
  })

  it('keeps the Session Header and settings tab slot declarations', async () => {
    const require = createRequire(import.meta.url)
    const conversationPackagePath = require.resolve('@deepseek-ai/dsh-client-ui-conversation/package.json')
    const primitivesPackagePath = require.resolve('@deepseek-ai/dsh-client-ui-primitives/package.json')
    const settingsPackagePath = require.resolve('@deepseek-ai/dsh-client-ui-settings/package.json')
    const conversationRoot = dirname(conversationPackagePath)
    const applySource = await readFile(join(conversationRoot, 'src', 'client', 'apply.ts'), 'utf8')
    const slotContract = await readFile(join(conversationRoot, 'src', 'client', 'contract', 'slots.ts'), 'utf8')
    expect(applySource).toMatch(/'conversation\.session\.header\.actions':\s*\{\s*kind:\s*'list',\s*scope:\s*'session'/)
    expect(slotContract).toMatch(/'conversation\.session\.header\.actions':\s*\{\s*kind:\s*'list'\s*;?\s*scope:\s*'session'\s*;?\s*owner:\s*ConversationHeaderActionOwnerProps/)
    const settingsRoot = dirname(settingsPackagePath)
    const settingsSlots = await readFile(join(settingsRoot, 'src', 'client', 'contract', 'slots.ts'), 'utf8')
    expect(settingsSlots).toMatch(/'settings\.plugins\.tab':\s*\{\s*kind:\s*'list'\s*;?\s*scope:\s*'root'\s*;?\s*owner:\s*SettingsPluginsTabOwnerProps/)
    const primitivesRoot = dirname(primitivesPackagePath)
    const primitives = await readFile(join(primitivesRoot, 'src', 'index.ts'), 'utf8')
    for (const exported of ['Button', 'Modal', 'Input', 'Pill', 'DisclosureRow', 'Toast']) {
      expect(primitives).toContain(`export { ${exported} }`)
    }
  })
})
