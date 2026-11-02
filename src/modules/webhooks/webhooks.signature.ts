import { createHmac } from 'node:crypto';

// `t=<ts>,v1=<sig>[,v1=<sig>...]`: one v1 per active secret, so receivers can accept either during a rotation.
export function signatureHeader(secrets: string[], timestamp: number, body: string) {
  const signed = `${timestamp}.${body}`;
  return [`t=${timestamp}`, ...secrets.map((secret) => `v1=${createHmac('sha256', secret).update(signed).digest('hex')}`)].join(',');
}
