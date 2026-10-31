// build-zip.js — 打包成可上传到 Microsoft Edge Add-ons 的 zip
//
// Edge 商店要求：
//   · zip 根目录直接是 manifest.json（不能嵌套文件夹）
//   · 不能含测试文件、README、_metadata 缓存目录
//   · 不能含 "key" 字段（Edge 会拒绝）
//   · 必须含 128x128 图标
//   · 不能含压缩过的文件（Edge 会拒绝 .gz 等）
//
// 用法：node build-zip.js
// 输出：dist/deepseek-sidebar-v<version>.zip

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC = __dirname;
const DIST = path.join(SRC, 'dist');

// 要打包的文件（白名单，避免测试文件混入）
const INCLUDE = [
  'manifest.json',
  'background.js',
  'panel.html',
  'panel.js',
  'rules.json',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

// ============================================================
// 简易 ZIP 构建（store 模式，不压缩 —— 避免 Edge 的压缩检测）
// ============================================================

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) |
               ((d.getMinutes() & 0x3f) << 5) |
               ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) |
               (((d.getMonth() + 1) & 0x0f) << 5) |
               (d.getDate() & 0x1f);
  return { time, date };
}

function buildZip(entries) {
  // entries: [{ name, data }]
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const { time, date } = dosDateTime(now);

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const size = data.length;

    // ---- Local file header ----
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);   // signature
    lh.writeUInt16LE(20, 4);           // version needed
    lh.writeUInt16LE(0x0800, 6);       // flags: UTF-8
    lh.writeUInt16LE(0, 8);            // method: store
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18);        // compressed
    lh.writeUInt32LE(size, 22);        // uncompressed
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);           // extra len

    localParts.push(lh, nameBuf, data);

    // ---- Central directory header ----
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);           // version made by
    ch.writeUInt16LE(20, 6);           // version needed
    ch.writeUInt16LE(0x0800, 8);       // flags UTF-8
    ch.writeUInt16LE(0, 10);           // method store
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(size, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);           // extra
    ch.writeUInt16LE(0, 32);           // comment
    ch.writeUInt16LE(0, 34);           // disk
    ch.writeUInt16LE(0, 36);           // internal attrs
    ch.writeUInt32LE(0, 38);           // external attrs
    ch.writeUInt32LE(offset, 42);      // local header offset

    centralParts.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const localBuf = Buffer.concat(localParts);

  // ---- End of central directory ----
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// ============================================================
// 主流程
// ============================================================

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

// ---- 上传前检查 ----
const problems = [];

if (manifest.key) {
  problems.push('manifest 含 "key" 字段（Edge 商店会拒绝）');
}
if (!manifest.icons || !manifest.icons['128']) {
  problems.push('缺少 128x128 图标');
}
if (!manifest.name) problems.push('缺少 name');
if (!manifest.version) problems.push('缺少 version');
if (!manifest.description) problems.push('缺少 description');
if (!manifest.background && !manifest.action) {
  problems.push('既无 background 也无 action');
}

// 检查是否有残留的旧功能
for (const f of ['selection.js', 'context-bar.js', 'content.js']) {
  if (INCLUDE.includes(f)) problems.push(`不应包含 ${f}`);
}

if (problems.length) {
  console.error('❌ 打包前检查未通过：');
  problems.forEach((p) => console.error('   · ' + p));
  process.exit(1);
}

console.log('✅ 上传前检查通过');
console.log(`   名称: ${manifest.name}`);
console.log(`   版本: ${manifest.version}`);
console.log(`   权限: ${(manifest.permissions || []).join(', ')}`);
console.log(`   图标: ${Object.keys(manifest.icons).join(', ')}`);

// ---- 收集文件 ----
const entries = [];
for (const rel of INCLUDE) {
  const full = path.join(SRC, rel);
  if (!fs.existsSync(full)) {
    console.error(`❌ 缺少文件: ${rel}`);
    process.exit(1);
  }
  const data = fs.readFileSync(full);
  entries.push({ name: rel, data });
  console.log(`   + ${rel.padEnd(24)} ${String(data.length).padStart(7)} bytes`);
}

// ---- 生成 zip ----
fs.mkdirSync(DIST, { recursive: true });
const zipName = `deepseek-sidebar-v${manifest.version}.zip`;
const zipPath = path.join(DIST, zipName);
const zipBuf = buildZip(entries);
fs.writeFileSync(zipPath, zipBuf);

console.log('');
console.log('='.repeat(58));
console.log(`✅ 已生成: ${zipPath}`);
console.log(`   大小: ${zipBuf.length} bytes (${(zipBuf.length / 1024).toFixed(1)} KB)`);
console.log(`   文件数: ${entries.length}`);
console.log('='.repeat(58));
