import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  DshContextFileSystemObservationError,
  parseDshContextFileSystem,
  type DshContextFileSystemPort,
} from './context-filesystem.js'

/** Electron synthesizes a new inode per ASAR stat. Observe the physical archive version instead. */
export function stockDesktopSkillReads(value: unknown, stockPresetSkillDir: string | undefined): unknown {
  if (process.platform !== 'darwin' || process.versions.electron === undefined
    || !('resourcesPath' in process) || typeof process.resourcesPath !== 'string') return value
  const archive = join(process.resourcesPath, 'app.asar')
  const packagePath = join('dsh', 'node_modules', '@deepseek-ai', 'dsh-agent-preset', 'skills')
  const root = join(archive, packagePath)
  if (stockPresetSkillDir !== root) return value

  const filesystem = parseDshContextFileSystem(value)
  if (filesystem === undefined) return value
  const originalFs = createRequire(import.meta.url)('original-fs') as typeof import('node:fs')

  async function stableVersion(path: string, version: string): Promise<string> {
    const inside = relative(root, path)
    if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) return version
    // Unpacked files do not share the physical archive's version.
    const unpacked = await originalFs.promises.lstat(join(`${archive}.unpacked`, packagePath)).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    const stat = await originalFs.promises.lstat(archive, { bigint: true })
    if (unpacked !== undefined || !stat.isFile()) {
      throw new DshContextFileSystemObservationError('Unexpected stock desktop Skill archive layout')
    }
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${inside}`
  }

  const observation: DshContextFileSystemPort = {
    resolve: (path, options) => filesystem.resolve(path, options),
    contains: (parent, child) => filesystem.contains(parent, child),
    readBytes: (target, signal, maxBytes) => filesystem.readBytes(target, signal, maxBytes),
    listDir: (target, signal) => filesystem.listDir(target, signal),
    async stat(target, signal) {
      const info = await filesystem.stat(target, signal)
      if (info === undefined || resolve(target.displayPath) !== target.targetKey) return info
      return { ...info, version: await stableVersion(target.targetKey, info.version) }
    },
    async lstat(path, options, signal) {
      const info = await filesystem.lstat(path, options, signal)
      if (info === undefined || !isAbsolute(path) || info.type === 'symlink') return info
      return { ...info, version: await stableVersion(path, info.version) }
    },
  }
  return observation
}
