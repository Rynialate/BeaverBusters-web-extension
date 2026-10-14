#!/usr/bin/env node
/*
 * Build per-browser packages from src/.
 *
 *   node scripts/build.mjs            -> dist/chrome, dist/firefox and .zip files
 *   node scripts/build.mjs chrome     -> only Chrome
 *
 * src/manifest.json is a cross-browser manifest. Chrome only understands
 * `background.service_worker`; Firefox uses `background.scripts`. Each build
 * keeps the key its browser needs and drops the other, plus Firefox-only keys
 * for Chrome, so neither store reports unknown keys.
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');
const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));

const targets = {
  chrome(m) {
    delete m.browser_specific_settings;
    m.background = { service_worker: m.background.service_worker };
    m.minimum_chrome_version = '116';
    return m;
  },
  firefox(m) {
    m.background = { scripts: m.background.scripts };
    return m;
  },
};

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal deterministic ZIP writer (deflate), enough for store uploads. */
function zipDir(dir, outFile) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (2024 - 1980) << 9 | 1 << 5 | 1; // fixed timestamp for reproducible zips
  for (const file of listFiles(dir)) {
    const name = Buffer.from(relative(dir, file).split(sep).join('/'));
    const data = readFileSync(file);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(outFile, Buffer.concat([...chunks, cdBuf, end]));
}

const wanted = process.argv.slice(2).filter((a) => targets[a]);
const names = wanted.length ? wanted : Object.keys(targets);
mkdirSync(dist, { recursive: true });

for (const name of names) {
  const out = join(dist, name);
  rmSync(out, { recursive: true, force: true });
  cpSync(src, out, { recursive: true });
  const m = targets[name](structuredClone(manifest));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  const zipFile = join(dist, `beaverbusters-${name}-${manifest.version}.zip`);
  zipDir(out, zipFile);
  console.log(`built ${relative(root, out)} and ${relative(root, zipFile)}`);
}
