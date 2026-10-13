/** Lower-cased extension without the dot, or '' when the name has none. */
export function fileExtension(name: string): string {
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
}

/** `name:size:lastModified` — the identity key used for per-file caches. */
export function fileFingerprint(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}
