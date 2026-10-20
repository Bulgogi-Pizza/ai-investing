import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const inflate = promisify(inflateRaw);

export interface ZipLimits {
  maxEntries: number;
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
}
export class ZipError extends Error {
  constructor(public reason: string) {
    super(`ZIP_${reason}`);
  }
}

const eocdSignature = 0x06054b50;
const centralSignature = 0x02014b50;
const localSignature = 0x04034b50;
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Extracts exactly one named entry from a single-disk, non-ZIP64 archive without writing to disk.
 * Sizes are checked against the central directory before inflating, and the inflater itself
 * is capped, so a forged size field cannot produce more than `maxUncompressedBytes`.
 */
export async function extractZipEntry(
  input: Uint8Array,
  entryName: string,
  limits: ZipLimits,
): Promise<Buffer> {
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buffer.length < 22 || buffer.length > limits.maxCompressedBytes + 1024 * 1024)
    throw new ZipError('SIZE');
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
    if (
      buffer.readUInt32LE(i) === eocdSignature &&
      i + 22 + buffer.readUInt16LE(i + 20) <= buffer.length
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('NO_EOCD');
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount)
    throw new ZipError('MULTIDISK');
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff)
    throw new ZipError('ZIP64');
  if (entryCount < 1 || entryCount > limits.maxEntries) throw new ZipError('ENTRY_COUNT');
  if (centralOffset + centralSize > eocd) throw new ZipError('CENTRAL_RANGE');

  let position = centralOffset;
  const end = centralOffset + centralSize;
  let found:
    | {
        flags: number;
        method: number;
        crc: number;
        compressed: number;
        uncompressed: number;
        offset: number;
      }
    | undefined;
  for (let index = 0; index < entryCount; index++) {
    if (position + 46 > end || buffer.readUInt32LE(position) !== centralSignature)
      throw new ZipError('CENTRAL_ENTRY');
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const next = position + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw new ZipError('CENTRAL_ENTRY');
    const name = buffer.toString('utf8', position + 46, position + 46 + nameLength);
    if (name.toLowerCase() === entryName.toLowerCase()) {
      if (found) throw new ZipError('DUPLICATE_ENTRY');
      found = {
        flags: buffer.readUInt16LE(position + 8),
        method: buffer.readUInt16LE(position + 10),
        crc: buffer.readUInt32LE(position + 16),
        compressed: buffer.readUInt32LE(position + 20),
        uncompressed: buffer.readUInt32LE(position + 24),
        offset: buffer.readUInt32LE(position + 42),
      };
    }
    position = next;
  }
  if (!found) throw new ZipError('ENTRY_MISSING');
  if (found.flags & 1) throw new ZipError('ENCRYPTED');
  if (found.method !== 0 && found.method !== 8) throw new ZipError('METHOD');
  if (found.compressed === 0xffffffff || found.uncompressed === 0xffffffff)
    throw new ZipError('ZIP64');
  if (found.compressed > limits.maxCompressedBytes) throw new ZipError('COMPRESSED_TOO_LARGE');
  if (found.uncompressed < 1 || found.uncompressed > limits.maxUncompressedBytes)
    throw new ZipError('UNCOMPRESSED_TOO_LARGE');
  if (found.method === 0 && found.compressed !== found.uncompressed) throw new ZipError('SIZE');
  if (found.offset + 30 > centralOffset || buffer.readUInt32LE(found.offset) !== localSignature)
    throw new ZipError('LOCAL_HEADER');
  const dataStart =
    found.offset +
    30 +
    buffer.readUInt16LE(found.offset + 26) +
    buffer.readUInt16LE(found.offset + 28);
  const dataEnd = dataStart + found.compressed;
  if (dataEnd > centralOffset) throw new ZipError('DATA_RANGE');
  const data = buffer.subarray(dataStart, dataEnd);
  let output: Buffer;
  if (found.method === 0) output = Buffer.from(data);
  else {
    try {
      output = await inflate(data, { maxOutputLength: found.uncompressed });
    } catch {
      throw new ZipError('INFLATE');
    }
  }
  if (output.length !== found.uncompressed) throw new ZipError('SIZE_MISMATCH');
  if (crc32(output) !== found.crc) throw new ZipError('CRC');
  return output;
}
