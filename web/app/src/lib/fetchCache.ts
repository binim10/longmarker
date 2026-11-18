// One in-flight/finished request per URL, so a prefetch and the real load share the same bytes.
// Volume buffers are large (tens of MB), so callers trim them with keepOnly(); JSON is tiny and kept.
const buffers = new Map<string, Promise<ArrayBuffer>>()
const json = new Map<string, Promise<any>>()

function remember<T>(map: Map<string, Promise<T>>, url: string, load: (r: Response) => Promise<T>): Promise<T> {
  let p = map.get(url)
  if (!p) {
    p = fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return load(r) })
    p.catch(() => map.delete(url)) // let a later call retry
    map.set(url, p)
  }
  return p
}

export const getBuffer = (url: string) => remember(buffers, url, r => r.arrayBuffer())
export const getJson = (url: string) => remember(json, url, r => r.json())

/** Drop cached volume buffers whose URL does not start with one of the given prefixes. */
export function keepOnly(prefixes: string[]) {
  for (const url of buffers.keys()) if (!prefixes.some(p => url.startsWith(p))) buffers.delete(url)
}
