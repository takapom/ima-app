#!/usr/bin/env node
// フォーマットの機械検査（レンダリングが必要な項目）— slide-rules §8 の目視QAを一部機械化
//   1. フッター（.foot / .footer）と本文要素の重なり
//   2. タイトル（h1 / .title）の右端はみ出し（nowrap + overflow:hidden の黙殺検出）
//   3. スライド外への要素はみ出し
//   4. 空きの多いページ（タイトル下〜フッター上の版面のうち、本文が占める縦の範囲の外側が40%超。上下に寄せた空きも数える）
// 使い方: node scripts/check_layout.mjs deck.html   （playwright 必須: リポ直下で `npm run setup`。PLAYWRIGHT_MODULE_DIR でも解決可）
import path from "node:path";
import { pathToFileURL } from "node:url";

async function loadPlaywright() {
  const cands = [
    process.env.PLAYWRIGHT_MODULE_DIR,
    path.join(process.cwd(), "node_modules", "playwright"),
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "node_modules", "playwright"),
  ].filter(Boolean);
  for (const c of cands) {
    try { return (await import(pathToFileURL(path.join(c, "index.mjs")).href)); } catch {}
    try { const m = await import(pathToFileURL(path.join(c, "index.js")).href); return m.default ?? m; } catch {}
  }
  return await import("playwright");
}

const file = process.argv[2];
if (!file) { console.error("usage: node check_layout.mjs deck.html"); process.exit(2); }

const pw = await loadPlaywright();
const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
// 印刷レイアウトで検査（ビューポート追従スケーラーの影響を受けない）
await page.emulateMedia({ media: "print" });
await page.goto(pathToFileURL(path.resolve(file)).href);
await page.waitForTimeout(300);

const issues = await page.evaluate(() => {
  const out = [];
  const slides = [...document.querySelectorAll("section.s, section.slide, .slide")];
  slides.forEach((s, i) => {
    const n = i + 1;
    const sr = s.getBoundingClientRect();
    const foot = s.querySelector(".foot, .footer, footer");
    const fr = foot ? foot.getBoundingClientRect() : null;
    const els = [...s.querySelectorAll("*")].filter((el) => {
      if (foot && (el === foot || foot.contains(el))) return false;
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return false;
      return (el.textContent || "").trim().length > 0 || el.tagName === "IMG";
    });
    // 4. 版面の下側の空き（表紙・章扉・裏表紙は対象外）
    if (!s.matches(".cover, .chap")) {
      const ttl = s.querySelector("h1, .title, .ttl");
      const top = ttl ? ttl.getBoundingClientRect().bottom : sr.top;
      const bottom = fr ? fr.top : sr.bottom;
      let contentBottom = -Infinity, contentTop = Infinity;
      for (const el of els) {
        if (el === ttl || (ttl && ttl.contains(el))) continue;
        if (el.closest(".src, .bar")) continue; // 出典行・上部バーは本文に数えない
        if (el.children.length > 0 && el.tagName !== "IMG" && el.tagName !== "svg") continue;
        const r = el.getBoundingClientRect();
        if (r.height === 0 || r.width === 0) continue;
        contentBottom = Math.max(contentBottom, r.bottom);
        contentTop = Math.min(contentTop, r.top);
      }
      // 図形（svg・画像・塗りや罫線のある箱）も本文に数える
      const isShape = (el) => {
        if (/^(svg|img|canvas)$/i.test(el.tagName)) return true;
        const st = getComputedStyle(el);
        const bg = st.backgroundColor;
        const filled = bg && bg !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(bg);
        const bordered = ["Top", "Right", "Bottom", "Left"].some((k) => parseFloat(st[`border${k}Width`]) > 0 && st[`border${k}Style`] !== "none");
        return filled || bordered || st.clipPath !== "none";
      };
      for (const el of s.querySelectorAll("*")) {
        if (el.closest(".bar, .src") || (foot && foot.contains(el))) continue;
        if (el.closest("h1, .title, .ttl")) continue;
        if (!isShape(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.bottom <= bottom + 1 && r.top >= top - 1) {
          contentBottom = Math.max(contentBottom, r.bottom);
          contentTop = Math.min(contentTop, r.top);
        }
      }
      const area = bottom - top;
      const span = contentBottom > contentTop ? contentBottom - contentTop : 0;
      const empty = area > 0 ? 1 - span / area : 0;
      if (empty > 0.4) {
        out.push(`p${n}: 版面の ${Math.round(empty * 100)}% が空いている（40%超。表を割る・図を足す・2枚を1枚に統合する）`);
      }
    }
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.height === 0 || r.width === 0) continue;
      // 葉要素だけ見る（コンテナの巨大rectでの誤検出を避ける）
      if (el.children.length > 0 && el.tagName !== "IMG") continue;
      if (fr && r.bottom > fr.top + 1 && r.top < fr.top) {
        out.push(`p${n}: フッターと本文が重なる: <${el.tagName.toLowerCase()}> 「${(el.textContent || "").trim().slice(0, 30)}」`);
      }
      if (r.right > sr.right + 1) {
        out.push(`p${n}: 右端はみ出し ${Math.round(r.right - sr.right)}px: <${el.tagName.toLowerCase()}> 「${(el.textContent || "").trim().slice(0, 30)}」`);
      }
      if (r.bottom > sr.bottom + 1) {
        out.push(`p${n}: 下端はみ出し ${Math.round(r.bottom - sr.bottom)}px: <${el.tagName.toLowerCase()}> 「${(el.textContent || "").trim().slice(0, 30)}」`);
      }
    }
  });
  return [...new Set(out)];
});

await browser.close();
if (issues.length) {
  for (const m of issues.slice(0, 20)) console.log("FAIL  " + m);
  console.log(`\n${issues.length} layout FAIL`);
  process.exit(1);
}
console.log("layout OK（フッター重なり・はみ出し・下半分の空きなし）");
