/**
 * Safe, screenshot-friendly diagnostics for the Join Room flow.
 * Never include Firebase config, auth tokens, private targets, or room payloads.
 */

const SAFE_CODE_PATTERN = /^[a-z0-9_./:-]{1,120}$/i;

export function safeDiagnosticCode(error) {
  const rawCode = String(error?.code || 'unknown').trim();
  return SAFE_CODE_PATTERN.test(rawCode) ? rawCode : 'unknown';
}

export function safeDiagnosticMessage(error) {
  const message = String(error?.message || '')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/(token|apiKey|authDomain|databaseURL)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!message) return 'The request failed without a detailed message.';
  return message.length > 180 ? `${message.slice(0, 177)}...` : message;
}

export function createJoinDiagnostic({
  stage,
  status = 'failed',
  error = null,
  attempt = null,
  detail = '',
}) {
  return {
    stage,
    status,
    code: error ? safeDiagnosticCode(error) : 'ok',
    message: error ? safeDiagnosticMessage(error) : detail,
    ...(attempt ? { attempt } : {}),
    recordedAt: new Date().toISOString(),
  };
}

export function addJoinDiagnosticError(error, diagnostic) {
  const enriched = error instanceof Error ? error : new Error(String(error || 'Join Room failed.'));
  enriched.joinDiagnostic = diagnostic;
  return enriched;
}
