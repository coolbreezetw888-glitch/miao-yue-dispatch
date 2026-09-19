// 模組 7(排班與休假管理)§6.3:PWA 圖示產生腳本。
//
// 目前 public/ 沒有任何現成的高解析度品牌 logo 素材(規格書 6.3 已明講的既知限制),這裡用純
// Node.js 內建模組(zlib)手刻一個最簡單的 PNG 編碼器,不依賴任何額外套件(canvas/sharp 都沒有
// 安裝,也不想為了一次性產生三張佔位圖示而新增專案依賴)。畫面內容:品牌主色(#2563EB,對應
// src/modules/merchant/constants.ts 的「沉穩藍」預設色)實心背景 + 置中白色圓形,是最簡單堪用的
// 品牌識別圖案佔位,之後有正式品牌識別素材時直接替換 public/icons/ 底下的檔案即可,不影響任何
// 程式碼或設定(manifest.json 只認檔名)。
//
// 用法:node scripts/generate-pwa-icons.mjs(一次性腳本,不是 build pipeline 的一部分)。

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "public", "icons");
mkdirSync(outDir, { recursive: true });

const BRAND_HEX = "#2563EB";
const [BR, BG, BB] = [
  parseInt(BRAND_HEX.slice(1, 3), 16),
  parseInt(BRAND_HEX.slice(3, 5), 16),
  parseInt(BRAND_HEX.slice(5, 7), 16),
];

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * 產生一張 size×size 的 PNG:品牌色底 + 置中白色圓形(半徑比例可調,maskable 版本用較小比例
 * 確保落在安全區內,避免各平台裁切成圓形圖示時把圖案切掉)。
 */
function buildPng(size, circleRadiusRatio) {
  const width = size;
  const height = size;
  const cx = width / 2;
  const cy = height / 2;
  const r = (Math.min(width, height) / 2) * circleRadiusRatio;

  const rowBytes = width * 3; // RGB,無 alpha
  const raw = Buffer.alloc((rowBytes + 1) * height); // 每列前面加 1 byte filter type(0)

  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const inCircle = dx * dx + dy * dy <= r * r;
      const off = rowStart + 1 + x * 3;
      if (inCircle) {
        raw[off] = 255;
        raw[off + 1] = 255;
        raw[off + 2] = 255;
      } else {
        raw[off] = BR;
        raw[off + 1] = BG;
        raw[off + 2] = BB;
      }
    }
  }

  const compressed = deflateSync(raw);

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB (truecolor)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const icon192 = buildPng(192, 0.62);
const icon512 = buildPng(512, 0.62);
// maskable 版本:各平台可能裁切成圓形/圓角方形等各種形狀,官方建議把重要內容留在「安全區」
// (中心 80% 直徑的圓形範圍內),所以整個圖示範圍改成純色底,圖案畫得更小一點更保守。
const icon512Maskable = buildPng(512, 0.4);

writeFileSync(path.join(outDir, "icon-192.png"), icon192);
writeFileSync(path.join(outDir, "icon-512.png"), icon512);
writeFileSync(path.join(outDir, "icon-512-maskable.png"), icon512Maskable);

console.log("PWA 佔位圖示已產生:", outDir);
