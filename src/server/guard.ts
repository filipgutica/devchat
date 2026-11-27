/**
 * The server's copy of the devchat text guard (§5): the plugin's new-text patterns in filip-stack
 * (`plugins/devchat/skills/devchat/scripts/devchat.mjs`). `fixtures/guard.json` keeps the two in
 * step: both must give its `general` expectation for every case. The UI route refuses a write the
 * guard refuses (§12).
 */
const guardPatterns = [
  { pattern: /\/(?:Users|home)\/[^/\s]+\//u, reason: 'absolute home-directory path' },
  { pattern: /[A-Za-z]:\\Users\\[^\\\s]+\\/u, reason: 'absolute home-directory path' },
  { pattern: /https:\/\/[^\s?]+\?[^\s]*/iu, reason: 'URL query string' },
  { pattern: /%[0-9a-f]{2}/iu, reason: 'percent-encoded source text' },
  { pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u, reason: 'private key' },
  { pattern: /\b(?:github_pat_|gh[pousr]_|AKIA)[A-Za-z0-9_]{12,}\b/u, reason: 'credential token' },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/u, reason: 'credential token' },
  { pattern: /\b(?:password|passwd|access[_-]?token|api[_-]?key|client[_-]?secret)\s*[:=]\s*[^\s,;]+/iu, reason: 'credential assignment' },
  { pattern: /^(?:user|assistant|system):\s+/imu, reason: 'raw transcript marker' },
  { pattern: /<(?:user|assistant|system)>|BEGIN (?:RAW )?PROMPT/iu, reason: 'raw prompt marker' },
  { pattern: /[a-z][a-z0-9+.-]*:[^\s?]*\?\S/iu, reason: 'URL query string' },
  { pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]*@/iu, reason: 'URL user information' },
  { pattern: /(?<![\w.-])\/(?:Users|home)\/[^/\s]+/u, reason: 'absolute home-directory path' },
  { pattern: /(?:\/mnt\/[a-z]\/(?:users|home)|[a-z]:[\\/]users)[\\/][^\\/\s]+/iu, reason: 'absolute home-directory path' },
]

/** Why the guard refuses `text`, or null when it passes. */
export type Guard = (text: string) => string | null

export const guardReason: Guard = (text) => guardPatterns.find(({ pattern }) => pattern.test(text))?.reason ?? null
