// Minimal NIfTI-1 reader for int16/uint8 volumes (node + browser).
export interface Nii { dims: [number, number, number]; spacing: [number, number, number]; data: Int16Array | Uint8Array | Float32Array }

export function parseNifti(buf: ArrayBuffer): Nii {
  const dv = new DataView(buf)
  let le = true
  if (dv.getInt32(0, true) !== 348) le = false
  const dims: [number, number, number] = [dv.getInt16(42, le), dv.getInt16(44, le), dv.getInt16(46, le)]
  const datatype = dv.getInt16(70, le)
  const spacing: [number, number, number] = [dv.getFloat32(80, le), dv.getFloat32(84, le), dv.getFloat32(88, le)]
  const off = Math.round(dv.getFloat32(108, le))
  const n = dims[0] * dims[1] * dims[2]
  const slice = buf.slice(off)
  let data: Int16Array | Uint8Array | Float32Array
  if (datatype === 4) data = new Int16Array(slice, 0, n)
  else if (datatype === 2) data = new Uint8Array(slice, 0, n)
  else if (datatype === 16) data = new Float32Array(slice, 0, n)
  else throw new Error('unsupported NIfTI datatype ' + datatype)
  return { dims, spacing, data }
}

export async function gunzipIfNeeded(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(buf, 0, 2)
  if (b[0] !== 0x1f || b[1] !== 0x8b) return buf
  const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(ds).arrayBuffer()
}
