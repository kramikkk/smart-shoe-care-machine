/**
 * Normalize stored CAM address to "host" or "host:port" for http://… URLs.
 * Handles accidental prefixes like "http://192.168.1.5" or trailing slashes.
 */
export function normalizeCamHost(camIp: string): string {
  let h = camIp.trim()
  if (!h) return h
  if (/^https?:\/\//i.test(h)) {
    try {
      const u = new URL(h)
      h = u.hostname + (u.port ? `:${u.port}` : '')
    } catch {
      h = h.replace(/^https?:\/\//i, '')
      const slash = h.indexOf('/')
      if (slash >= 0) h = h.substring(0, slash)
    }
  } else {
    const slash = h.indexOf('/')
    if (slash >= 0) h = h.substring(0, slash)
  }
  return h
}
