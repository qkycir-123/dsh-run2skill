/** Build the public DSH Web CLI arguments without ever opening a system browser. */
export function dshWebArgs(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('Web probe port must be a valid integer')
  }
  return ['web', '--port', String(port), '--no-open']
}
