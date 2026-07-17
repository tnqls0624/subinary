/**
 * Family Memory AI — web · PostCSS (Tailwind v4)
 * Tailwind v4는 전용 PostCSS 플러그인 하나만 사용한다(별도 tailwind.config 불필요,
 * 토큰/테마는 globals.css의 @theme에서 CSS-first로 정의).
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
