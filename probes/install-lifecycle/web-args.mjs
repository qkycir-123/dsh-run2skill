import { spawnSync } from 'node:child_process'

/** Read the public Web command help without booting a DSH profile. */
export function dshWebHelp(bin) {
  const result = spawnSync(process.execPath, [bin, 'web', '--help'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Unable to inspect DSH Web CLI options (exit ${String(result.status)})`)
  }
  return `${result.stdout}\n${result.stderr}`
}

/** Whether this DSH Web CLI supports suppressing its default-browser handoff. */
export function supportsNoOpen(webHelp) {
  return /(?:^|\s)--no-open(?:\s|$)/u.test(webHelp)
}

/** Build version-compatible public DSH Web CLI arguments without opening a system browser. */
export function dshWebArgs(port, canDisableOpen) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('Web probe port must be a valid integer')
  }
  return ['web', '--port', String(port), ...canDisableOpen ? ['--no-open'] : []]
}
