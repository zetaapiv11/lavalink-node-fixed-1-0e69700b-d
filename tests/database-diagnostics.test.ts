import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseDiagnostic } from '../lib/database-diagnostics';

test('database diagnostics identify actionable causes without echoing sensitive error fields', () => {
  const secret = 'postgresql://private-user:private-password@private-host/private-database';
  const examples = [
    ['ERR_INVALID_URL', 'DB_URL'], ['ENOTFOUND', 'DB_DNS'], ['EAI_AGAIN', 'DB_DNS'],
    ['ETIMEDOUT', 'DB_NETWORK'], ['ECONNREFUSED', 'DB_NETWORK'], ['57P03', 'DB_NETWORK'],
    ['28P01', 'DB_AUTH'], ['28000', 'DB_AUTH'], ['3D000', 'DB_NAME'],
    ['42P01', 'DB_MIGRATION'], ['42703', 'DB_MIGRATION'], ['DB_NODE_MISSING', 'DB_MIGRATION'],
    ['42501', 'DB_PERMISSION'], ['CERT_HAS_EXPIRED', 'DB_TLS'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'DB_TLS'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'DB_TLS'],
    [secret, 'DB_UNKNOWN'],
  ];
  for (const [code, expected] of examples) {
    const result = databaseDiagnostic({ code, message: secret, detail: secret, stack: secret });
    assert.ok(result.startsWith(`[${expected}]`), `${code}: ${result}`);
    assert.ok(!result.includes(secret));
    assert.ok(!result.includes('private-password'));
  }
});
test('uncoded connection/TLS/config failures are categorized safely', () => {
  assert.match(databaseDiagnostic(new Error('Connection terminated due to connection timeout')), /^\[DB_NETWORK\]/);
  assert.match(databaseDiagnostic(new Error('The server does not support SSL connections')), /^\[DB_TLS\]/);
  assert.match(databaseDiagnostic(new Error('DATABASE_UNCONFIGURED')), /^\[DB_URL\]/);
  assert.match(databaseDiagnostic(null), /^\[DB_UNKNOWN\]/);
  assert.match(databaseDiagnostic('private-secret'), /^\[DB_UNKNOWN\]/);
});
