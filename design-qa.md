# Maskword V1 Design QA

## Evidence

- Source visual truth: `/mnt/c/Users/duanap/Downloads/ChatGPT Image 2026年8月11日 11_55_02.png`
- Implementation screenshot: `/mnt/c/Users/duanap/Documents/ChatGPT/谁是卧底/apps/web/test-results/home-visual.png`
- Side-by-side comparison: `/mnt/c/Users/duanap/Documents/ChatGPT/谁是卧底/apps/web/test-results/home-comparison.png`
- State: initial mode-selection screen, disconnected room state not involved
- Browser viewport: 412 × 839 CSS px, Pixel 7 profile
- Source pixels: 1536 × 1024 design board; home panel crop: 302 × 506 px
- Implementation pixels: 1082 × 2202 px at device scale factor 2.625
- Normalization: source home panel and implementation full viewport were aspect-fit to equal 900 px comparison height; the reference is a shorter concept frame, while the implementation preserves the real Pixel 7 viewport.

## Verification

- Page loaded with title `谁是卧底`, meaningful body content, and two primary interactive mode controls.
- No Vite error overlay, console error, horizontal overflow, or blank state was detected.
- Playwright exercised mode selection, nickname and room inputs, creation, joining, identity reveal, voting, game result, rematch, room management, refresh recovery, and active exit.
- Full-view comparison confirms the same hierarchy: centered brand, dominant online card with illustration and CTA, then a visually quieter disabled offline card.
- A focused region comparison was not required: the home screen contains large type, one hero image, two cards, and standard library icons, all readable in the normalized full-view comparison.

## Findings

- No actionable P0, P1, or P2 mismatch remains.
- Intentional deviation: product copy is reduced to the confirmed V1 scope, and the implementation omits the reference settings shortcut because no homepage setting is required.
- Intentional deviation: the generated party illustration is original and uses the reference only for art direction and layout weight.

## Comparison History

- Initial browser capture passed the five fidelity surfaces without code changes: typography hierarchy is consistent; spacing and card rhythm are stable; violet, pale-lavender, white, and muted tokens match the reference direction; the hero uses a sharp project-local raster asset; and all visible copy matches the confirmed product behavior.

## Follow-up Polish

- P3: a future brand pass could create a custom wordmark, but the current icon-library mark and live text are sharper and more accessible than rasterized logo text.

final result: passed

---

## 2026-08-11 Entry Flow and Desktop Background QA

### Evidence

- Source visual truth: `/mnt/c/Users/duanap/Downloads/ChatGPT Image 2026年8月11日 13_47_19.png`
- Converted asset: `/mnt/c/Users/duanap/Documents/ChatGPT/谁是卧底/apps/web/public/assets/maskword-desktop-bg.webp`
- Desktop implementation screenshot: `/mnt/c/Users/duanap/Documents/ChatGPT/谁是卧底/artifacts/qa/desktop-home.png`
- Public desktop screenshot: `/mnt/c/Users/duanap/Documents/ChatGPT/谁是卧底/artifacts/qa/public-desktop-home.png`
- Desktop side-by-side comparison: `/mnt/c/Users/duanap/Documents/ChatGPT/谁是卧底/artifacts/qa/desktop-background-comparison.jpg`
- Mobile entry screenshot: `/mnt/c/Users/duanap/Documents/ChatGPT/谁是卧底/artifacts/qa/mobile-online.png`
- Mobile join screenshot: `/mnt/c/Users/duanap/Documents/ChatGPT/谁是卧底/artifacts/qa/mobile-join.png`
- Public runoff screenshot: `/mnt/c/Users/duanap/Documents/ChatGPT/谁是卧底/artifacts/qa/public-runoff-self.png`
- State: desktop mode selection; mobile nickname/action selection; mobile join-room form
- Viewports: 1440 × 900 CSS px desktop and 412 × 915 CSS px mobile, device scale factor 1
- Source pixels: 1672 × 941; implementation pixels: 1440 × 900 desktop and 412 × 915 mobile
- Normalization: the source image was resized with `cover` semantics and center-cropped to 1440 × 900 before the side-by-side comparison, matching the implemented desktop CSS.

### Verification

- The WebP is 1672 × 941 and 32 KiB; the source composition, color, subject placement, and image sharpness are preserved.
- Desktop uses the source as a cover background while the 430 px game surface remains centered and readable. Mobile does not apply the desktop background.
- Mobile entry presents nickname first and two equally prominent, distinct paths. The room-code field appears only after choosing “加入房间”, is focused automatically, and retains the normalized nickname summary.
- Browser captures found no console errors or horizontal overflow. Desktop body width was 1440 px; both mobile states were exactly 412 px wide.
- Public HTTPS and WebSocket acceptance completed a four-player tie: the host saw both tied candidates, saw itself marked “我” and disabled, and saw `上轮 2 票` for both candidates. The test room was dissolved and public health returned `roomCount: 0`.
- Focused comparison was not needed for the desktop background because the normalized full-view comparison shows the entire source composition and crop. Mobile controls were inspected separately at readable 1:1 density.

### Required Fidelity Surfaces

- Fonts and typography: existing Chinese system font stack, hierarchy, weights, wrapping, and line heights remain consistent and readable.
- Spacing and layout rhythm: two action cards align to one grid; nickname support text, summaries, and join form maintain the existing 18 px section rhythm.
- Colors and visual tokens: the new entry cards reuse violet, lavender, green success, line, and muted tokens; no unapproved palette was introduced.
- Image quality and asset fidelity: the supplied raster background is used directly after WebP conversion; it is not recreated with CSS, SVG, or placeholders.
- Copy and content: labels describe the confirmed flow and do not introduce new rules or functionality.

### Findings and Comparison History

- No actionable P0, P1, or P2 mismatch remains.
- The first rendered pass preserved the source crop, avoided mobile leakage, showed no overflow, and required no visual correction.
- P3 follow-up: the centered app surface intentionally covers the source image's empty center on desktop; this is acceptable because the illustration was composed with that low-detail center as a content-safe area.

final result: passed
