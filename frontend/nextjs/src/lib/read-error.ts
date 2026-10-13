/** The `detail` of a failed proxy response, or `fallback` when there is none. */
export async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body as { detail?: string }).detail || fallback;
}
