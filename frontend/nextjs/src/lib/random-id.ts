/** A random id. `crypto.randomUUID` where the browser offers it; it is absent
 *  on a page that is not served securely (a plain-http address on the local
 *  network), where 32 random hex characters stand in. */
export function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
