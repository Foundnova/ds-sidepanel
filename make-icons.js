// make-icons.js — 从官方 DeepSeek 图标生成扩展所需的 4 个尺寸
//
// 源图：official-icons/icon-512.png（DeepSeek 官方鲸鱼标志）
// 输出：icons/icon{16,32,48,128}.png
//
// 实现说明：
//   · Node 没有内置图像处理库，不能安装依赖
//   · 自己实现 PNG 解码（仅支持 8-bit RGB/RGBA，非隔行）
//   · 缩放用「面积平均」（box filter），小尺寸下比最近邻质量好
//   · 编码沿用前面的简易 PNG 编码器

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC = process.argv[2] || path.join(__dirname, 'official-icons', 'icon-512.png');
const OUT = process.argv[3] || path.join(__dirname, 'icons');

// ============================================================
// PNG 解码（8-bit，非隔行，RGB/RGBA）
// ============================================================

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');

  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idatChunks = [];
  let palette = null;
  let trns = null;

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }

    pos += 12 + len;
  }

  if (bitDepth !== 8) throw new Error('仅支持 8-bit，实际 ' + bitDepth);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));

  // 每像素字节数
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('不支持 colorType ' + colorType);

  const bpp = channels;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);

  // 反滤波
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const rowIn = raw.subarray(rp, rp + stride);
    rp += stride;
    const rowOut = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rowOut[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
      const v = rowIn[x];

      let val;
      switch (filter) {
        case 0: val = v; break;
        case 1: val = v + a; break;
        case 2: val = v + b; break;
        case 3: val = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          val = v + pr;
          break;
        }
        default: throw new Error('未知滤波类型 ' + filter);
      }
      rowOut[x] = val & 0xff;
    }
  }

  // 统一转 RGBA
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r, g, b, a = 255;
    if (colorType === 0) {
      r = g = b = out[i];
    } else if (colorType === 2) {
      r = out[i * 3]; g = out[i * 3 + 1]; b = out[i * 3 + 2];
    } else if (colorType === 3) {
      const idx = out[i];
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      if (trns && idx < trns.length) a = trns[idx];
    } else if (colorType === 4) {
      r = g = b = out[i * 2]; a = out[i * 2 + 1];
    } else {
      r = out[i * 4]; g = out[i * 4 + 1]; b = out[i * 4 + 2]; a = out[i * 4 + 3];
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }

  return { width, height, rgba };
}

// ============================================================
// 缩放（面积平均，正确处理透明）
// ============================================================

function resize(src, srcW, srcH, dstW, dstH) {
  const dst = Buffer.alloc(dstW * dstH * 4);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const y0 = Math.floor(dy * scaleY);
    const y1 = Math.min(srcH, Math.ceil((dy + 1) * scaleY));

    for (let dx = 0; dx < dstW; dx++) {
      const x0 = Math.floor(dx * scaleX);
      const x1 = Math.min(srcW, Math.ceil((dx + 1) * scaleX));

      let rSum = 0, gSum = 0, bSum = 0, aSum = 0, count = 0;

      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const si = (sy * srcW + sx) * 4;
          const a = src[si + 3];
          // 预乘 alpha 累加，避免透明边缘发黑
          rSum += src[si] * a;
          gSum += src[si + 1] * a;
          bSum += src[si + 2] * a;
          aSum += a;
          count++;
        }
      }

      const di = (dy * dstW + dx) * 4;
      if (count === 0 || aSum === 0) {
        dst[di] = 0; dst[di + 1] = 0; dst[di + 2] = 0; dst[di + 3] = 0;
      } else {
        // 反预乘
        dst[di] = Math.round(rSum / aSum);
        dst[di + 1] = Math.round(gSum / aSum);
        dst[di + 2] = Math.round(bSum / aSum);
        dst[di + 3] = Math.round(aSum / count);
      }
    }
  }
  return dst;
}

// ============================================================
// PNG 编码
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

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const tb = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([len, tb, data, crc]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ============================================================
// 主流程
// ============================================================

console.log('源图:', SRC);
const srcBuf = fs.readFileSync(SRC);
const { width, height, rgba } = decodePNG(srcBuf);
console.log(`解码: ${width}x${height}`);

// 检查是否正方形
if (width !== height) {
  console.warn(`⚠️  源图非正方形 (${width}x${height})`);
}

fs.mkdirSync(OUT, { recursive: true });

for (const size of [16, 32, 48, 128, 256, 512]) {
  const resized = resize(rgba, width, height, size, size);
  const png = encodePNG(size, size, resized);
  const file = path.join(OUT, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`  ${file}  ${size}x${size}  ${png.length} bytes`);
}

console.log('\n✅ 图标生成完成');
