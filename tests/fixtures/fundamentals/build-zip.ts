import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../../../src/server/fundamentals/zip';

// Minimal ZIP writer for tests only. Synthetic archives; options let tests forge headers.
export interface ZipEntryInput {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  flags?: number;
  crc?: number;
  declaredUncompressed?: number;
  declaredCompressed?: number;
}

export function buildZip(entries: ZipEntryInput[], options: { entryCountOverride?: number } = {}) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const stored = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name, 'utf8');
    const crc = entry.crc ?? crc32(entry.data);
    const compressed = entry.declaredCompressed ?? stored.length;
    const uncompressed = entry.declaredUncompressed ?? entry.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, stored);
    centrals.push(central, name);
    offset += 30 + name.length + stored.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = options.entryCountOverride ?? entries.length;
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}
