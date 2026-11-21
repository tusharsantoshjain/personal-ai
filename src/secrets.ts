export interface SecretHit {
  kind: string;
  index: number;
}

// Shapes of real credentials. Kept specific so normal prose and code do not trip it.
const PATTERNS: [string, RegExp][] = [
  ['github-token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ['aws-access-key', /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['aws-secret-key', /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+]{40}\b/gi],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['openai-key', /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['bearer', /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi],
  ['basic-auth-url', /\bhttps?:\/\/[^\s:/@]+:[^\s:/@]{6,}@[^\s/]+/g],
  ['password-assignment', /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*['"][^'"\s]{8,}['"]/gi],
];

export function findSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const [kind, re] of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) hits.push({ kind, index: m.index });
  }
  return hits;
}

/** Mask anything secret-shaped, for logs. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const [, re] of PATTERNS) out = out.replace(re, '***');
  return out;
}
