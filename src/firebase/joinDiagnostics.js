/**
 * Safe, screenshot-friendly diagnostics for the Join Room flow.
 * Never include Firebase config, auth tokens, private targets, or room payloads.
 */

const SAFE_CODE_PATTERN = /^[a-z0-9_./:-]{1,120}$/i;

function makeCorrelationId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `join-${Date.now().toString(36)}-${random}`;
}

export function createJoinTrace() {
  return {
    correlationId: makeCorrelationId(),
    startedAt: Date.now(),
  };
}

export function getSafeClientNetworkSnapshot() {
  const connection = typeof navigator !== 'undefined' ? navigator.connection : null;
  return {
    browserOnline: typeof navigator === 'undefined' ? null : navigator.onLine,
    connectionType: connection?.type || null,
    effectiveType: connection?.effectiveType || null,
    downlinkMbps: Number.isFinite(connection?.downlink) ? connection.downlink : null,
    rttMs: Number.isFinite(connection?.rtt) ? connection.rtt : null,
  };
}

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
  trace = null,
  connection = null,
  extra = null,
}) {
  const safeTrace = trace || createJoinTrace();
  const startedAt = Number.isFinite(safeTrace.startedAt) ? safeTrace.startedAt : Date.now();
  return {
    stage,
    status,
    code: error ? safeDiagnosticCode(error) : 'ok',
    message: error ? safeDiagnosticMessage(error) : detail,
    ...(attempt ? { attempt } : {}),
    correlationId: safeTrace.correlationId,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    ...(connection ? { connection } : {}),
    ...(extra ? { extra } : {}),
    recordedAt: new Date().toISOString(),
  };
}

export function addJoinDiagnosticError(error, diagnostic) {
  const enriched = error instanceof Error ? error : new Error(String(error || 'Join Room failed.'));
  enriched.joinDiagnostic = diagnostic;
  return enriched;
}
