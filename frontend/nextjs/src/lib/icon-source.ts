/**
 * Where an icon's picture is loaded from.
 *
 * An icon overlay stores Iconify's address for the icon
 * (`https://api.iconify.design/<set>/<icon>.svg`): that is what every saved
 * design and template already holds, and it names the icon wherever the
 * design is opened. Nothing loads it from there any more. Iconify limits each
 * internet address to roughly 180 requests in a few minutes and then refuses
 * for about five, so the Icons tab's tiles became broken images and a design
 * with icons could not be submitted (2026-11-05). `ownIconUrl` turns the
 * stored address into the same icon on our own server, which keeps a
 * permanent copy (backend services/icon_store.py).
 */

const ICONIFY_ICON = /^https:\/\/api\.(?:iconify\.design|simplesvg\.com|unisvg\.com)\/([a-z0-9-]+)\/([a-z0-9-]+)\.svg(?:\?.*)?$/i;

/** The address an icon overlay stores: Iconify's, as it always was. */
export function iconifyUrl(prefix: string, name: string): string {
  return `https://api.iconify.design/${prefix}/${name}.svg`;
}

/** The same icon on our server. Absolute, because the print raster and the
 *  canvas treat an image address as a full URL. */
export function ownIconUrlFor(prefix: string, name: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/api/icons/${prefix.toLowerCase()}/${name.toLowerCase()}.svg`;
}

/** `src` as it should be loaded: an Iconify icon from our server, anything
 *  else (a sticker, an uploaded image, a blob) unchanged. */
export function ownIconUrl(src: string): string;
export function ownIconUrl(src: string | null | undefined): string | null | undefined;
export function ownIconUrl(src: string | null | undefined): string | null | undefined {
  const m = ICONIFY_ICON.exec(src ?? '');
  return m ? ownIconUrlFor(m[1], m[2]) : src;
}
