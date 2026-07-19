/**
 * 브랜드 소스 이미지 생성기 (icon/splash) → `apps/mobile/assets/*.png`.
 *
 * 브랜드: primary #35c5f0 + 흰색 credit-card 글리프(웹 BrandMark와 동일 톤).
 * 여기서 만든 소스 PNG를 @capacitor/assets가 각 플랫폼 크기로 확장한다:
 *   node scripts/gen-source-assets.cjs && npx capacitor-assets generate
 *
 * sharp로 SVG→PNG 래스터화(도구의 SVG 지원 여부와 무관하게 확실히 PNG 확보).
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const BRAND = "#35c5f0";
const DARK = "#121212";
const WHITE = "#ffffff";

const outDir = path.join(__dirname, "..", "assets");
fs.mkdirSync(outDir, { recursive: true });

/** lucide credit-card 글리프(흰색 stroke)를 SxS 캔버스 중앙에 fraction f 크기로 배치. */
function glyph(S, f) {
  const g = f * S;
  const s = g / 24; // 글리프 native viewBox = 24
  const t = (S - g) / 2;
  return `<g transform="translate(${t},${t}) scale(${s})" fill="none" stroke="${WHITE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="5" width="20" height="14" rx="2.5"/>
    <line x1="2" y1="10.5" x2="22" y2="10.5"/>
    <line x1="6" y1="15" x2="10" y2="15"/>
  </g>`;
}

/** 둥근 브랜드 타일 + 글리프(스플래시 로고용). tile은 S의 fraction. */
function logoTile(S, tileFrac) {
  const tile = Math.round(S * tileFrac);
  const t = (S - tile) / 2;
  const r = Math.round(tile * 0.22);
  const g = tile * 0.5;
  const s = g / 24;
  const gt = t + (tile - g) / 2;
  return `<rect x="${t}" y="${t}" width="${tile}" height="${tile}" rx="${r}" fill="${BRAND}"/>
  <g transform="translate(${gt},${gt}) scale(${s})" fill="none" stroke="${WHITE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="5" width="20" height="14" rx="2.5"/>
    <line x1="2" y1="10.5" x2="22" y2="10.5"/>
    <line x1="6" y1="15" x2="10" y2="15"/>
  </g>`;
}

const svg = (S, inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${inner}</svg>`;

// 소스 정의: [파일명, 크기, SVG]
const sources = [
  // iOS/legacy 아이콘: 브랜드 정사각 + 글리프(전체 채움, 코너는 OS가 마스킹)
  ["icon-only.png", 1024, svg(1024, `<rect width="1024" height="1024" fill="${BRAND}"/>${glyph(1024, 0.5)}`)],
  // Android adaptive: 전경(투명 + 글리프, 안전영역 고려해 작게) / 배경(브랜드 단색)
  ["icon-foreground.png", 1024, svg(1024, glyph(1024, 0.4))],
  ["icon-background.png", 1024, svg(1024, `<rect width="1024" height="1024" fill="${BRAND}"/>`)],
  // 스플래시: 라이트(흰 배경) / 다크(#121212) + 중앙 로고 타일
  ["splash.png", 2732, svg(2732, `<rect width="2732" height="2732" fill="${WHITE}"/>${logoTile(2732, 0.26)}`)],
  ["splash-dark.png", 2732, svg(2732, `<rect width="2732" height="2732" fill="${DARK}"/>${logoTile(2732, 0.26)}`)],
];

(async () => {
  for (const [file, size, markup] of sources) {
    await sharp(Buffer.from(markup)).resize(size, size).png().toFile(path.join(outDir, file));
    console.log("wrote", file, `${size}x${size}`);
  }
})();
