import { expect, test, type BrowserContext, type Page } from "@playwright/test";

async function openOnline(page: Page, nickname: string) {
  await page.goto("/");
  await page.getByRole("button", { name: /线上联机/ }).click();
  await page.getByLabel("昵称").fill(nickname);
}

async function joinRoom(page: Page, nickname: string, roomCode: string) {
  await openOnline(page, nickname);
  await page.locator(".entry-choice.join").click();
  await page.getByLabel("6 位房间号").fill(roomCode);
  await page.getByRole("button", { name: "加入房间", exact: true }).click();
  await expect(page.locator(".room-code-card strong")).toHaveText(roomCode);
}

test("offline same-device mode stays local, resumes safely, and completes a three-player game", async ({ page }) => {
  const socketRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/socket.io/")) socketRequests.push(request.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: /线下同屏/ }).click();
  await expect(page.getByRole("heading", { name: "线下同屏" })).toBeVisible();
  await page.getByRole("button", { name: "参赛人数减一" }).click();
  await page.getByRole("button", { name: "参赛人数减一" }).click();
  await expect(page.getByText("现场共 3 人")).toBeVisible();
  await page.getByRole("button", { name: "开始发牌" }).click();
  expect(socketRequests).toHaveLength(0);

  const names = ["主持人", "玩家2", "玩家3"];
  const roles: string[] = [];
  for (const name of names) {
    await page.getByRole("button", { name: `我是 ${name}，继续` }).click();
    roles.push((await page.locator(".secret-card strong").textContent())!.trim());
    await page.locator(".secret-card").click();
  }
  await expect(page.locator(".speaker-hero")).toBeVisible();

  await page.getByRole("button", { name: "重新查看身份" }).click();
  await page.getByRole("button", { name: "交给本人" }).first().click();
  await page.getByRole("button", { name: /我是 .*，继续/ }).click();
  await expect(page.locator(".secret-card")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "继续上一局？" })).toBeVisible();
  await page.getByRole("button", { name: "继续游戏" }).click();
  await expect(page.getByRole("button", { name: /我是 .*，继续/ })).toBeVisible();
  await page.getByRole("button", { name: /我是 .*，继续/ }).click();
  await page.locator(".secret-card").click();

  for (let index = 0; index < 3; index += 1) {
    await page.getByRole("button", { name: index === 2 ? "结束发言，开始投票" : "下一位发言" }).click();
  }
  const undercoverIndex = roles.indexOf("卧底");
  expect(undercoverIndex).toBeGreaterThanOrEqual(0);
  for (let voterIndex = 0; voterIndex < names.length; voterIndex += 1) {
    await page.getByRole("button", { name: `我是 ${names[voterIndex]}，继续` }).click();
    const targetIndex = voterIndex === undercoverIndex ? (voterIndex + 1) % names.length : undercoverIndex;
    await page.locator(".private-vote-grid button").filter({ hasText: names[targetIndex]! }).click();
    await page.getByRole("button", { name: "确认匿名投票" }).click();
  }
  await expect(page.getByRole("heading", { name: "平民阵营胜利！" })).toBeVisible();
  await page.getByRole("button", { name: "再来一局" }).click();
  await expect(page.getByText("请把手机交给")).toBeVisible();
});

test("offline setup handles twelve participants and a non-playing host on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: /线下同屏/ }).click();
  for (let index = 0; index < 7; index += 1) await page.getByRole("button", { name: "参赛人数加一" }).click();
  await expect(page.getByText("现场共 12 人")).toBeVisible();
  await expect(page.locator(".offline-name-list input")).toHaveCount(12);
  await page.getByRole("switch").click();
  await expect(page.getByText("现场共 13 人")).toBeVisible();
  await expect(page.locator(".offline-name-list input")).toHaveCount(13);
  await page.locator(".offline-name-list input").last().scrollIntoViewIfNeeded();
  await expect(page.locator(".offline-name-list input").last()).toBeVisible();
  await expect(page.getByRole("button", { name: "开始发牌" })).toBeVisible();
});

test("nickname is shared by separate create and join paths", async ({ page }) => {
  await openOnline(page, "  小 明  ");
  await expect(page.getByLabel("6 位房间号")).toHaveCount(0);
  await expect(page.locator(".entry-choice.create")).toBeEnabled();
  await expect(page.locator(".entry-choice.join")).toBeEnabled();

  await page.locator(".entry-choice.join").click();
  await expect(page.getByRole("heading", { name: "加入房间" })).toBeVisible();
  await expect(page.locator(".nickname-summary")).toContainText("小 明");
  await expect(page.getByLabel("6 位房间号")).toBeFocused();
  await page.getByRole("button", { name: "修改" }).click();

  await page.locator(".entry-choice.create").click();
  await expect(page.getByRole("heading", { name: "创建房间" })).toBeVisible();
  await expect(page.locator(".nickname-summary")).toContainText("小 明");
});

test("three players can complete a private game and return to the same lobby", async ({ browser }) => {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  for (let index = 0; index < 3; index += 1) {
    const context = await browser.newContext();
    contexts.push(context);
    pages.push(await context.newPage());
  }
  const [host, player2, player3] = pages as [Page, Page, Page];

  await openOnline(host, "房主");
  await host.locator(".entry-choice.create").click();
  await host.getByRole("button", { name: "平民数量减一" }).click();
  await host.getByRole("button", { name: "平民数量减一" }).click();
  await host.getByRole("button", { name: "白板数量减一" }).click();
  await host.getByRole("button", { name: "创建房间", exact: true }).click();
  const roomCode = (await host.locator(".room-code-card strong").textContent())?.trim();
  expect(roomCode).toMatch(/^\d{6}$/);

  await Promise.all([joinRoom(player2, "玩家2", roomCode!), joinRoom(player3, "玩家3", roomCode!)]);
  await expect(host.getByText("3 / 3")).toBeVisible();
  await host.getByRole("button", { name: "开始游戏" }).click();

  const roles: string[] = [];
  for (const page of pages) {
    await expect(page.locator(".identity-card")).toBeVisible();
    await page.locator(".identity-card").click();
    roles.push((await page.locator(".identity-card.revealed strong").textContent())?.trim() ?? "");
  }
  const undercoverIndex = roles.indexOf("卧底");
  expect(undercoverIndex).toBeGreaterThanOrEqual(0);

  await host.getByRole("button", { name: /结束发言/ }).click();
  for (const page of pages) await expect(page.getByRole("heading", { name: /匿名投票/ })).toBeVisible();

  const names = ["房主", "玩家2", "玩家3"];
  for (let index = 0; index < pages.length; index += 1) {
    const targetIndex = index === undercoverIndex ? (index + 1) % pages.length : undercoverIndex;
    await pages[index]!.getByRole("button", { name: new RegExp(names[targetIndex]!) }).click();
    await pages[index]!.getByRole("button", { name: "确认匿名投票" }).click();
  }

  for (const page of pages) await expect(page.getByRole("heading", { name: "平民阵营胜利！" })).toBeVisible();
  await host.getByRole("button", { name: "再来一局" }).click();
  for (const page of pages) await expect(page.getByRole("heading", { name: "房间大厅" })).toBeVisible();
  await expect(host.locator(".room-code-card strong")).toHaveText(roomCode!);

  await Promise.all(contexts.map((context) => context.close()));
});

test("a tied player still sees self and the anonymous runoff tallies", async ({ browser }) => {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  for (let index = 0; index < 4; index += 1) {
    const context = await browser.newContext();
    contexts.push(context);
    pages.push(await context.newPage());
  }
  const [host, player2, player3, player4] = pages as [Page, Page, Page, Page];

  await openOnline(host, "房主");
  await host.locator(".entry-choice.create").click();
  await host.getByRole("button", { name: "平民数量减一" }).click();
  await host.getByRole("button", { name: "白板数量减一" }).click();
  await host.getByRole("button", { name: "创建房间", exact: true }).click();
  const roomCode = (await host.locator(".room-code-card strong").textContent())!.trim();

  await Promise.all([
    joinRoom(player2, "玩家2", roomCode),
    joinRoom(player3, "玩家3", roomCode),
    joinRoom(player4, "玩家4", roomCode),
  ]);
  await host.getByRole("button", { name: "开始游戏" }).click();
  await host.getByRole("button", { name: /结束发言/ }).click();

  for (const [page, target] of [
    [host, "玩家2"],
    [player2, "房主"],
    [player3, "房主"],
    [player4, "玩家2"],
  ] as const) {
    await page.getByRole("button", { name: new RegExp(target) }).click();
    await page.getByRole("button", { name: "确认匿名投票" }).click();
  }

  await expect(host.getByRole("heading", { name: "平票玩家再次发言" })).toBeVisible();
  await expect(host.locator(".vote-player")).toHaveCount(2);
  await expect(host.locator(".vote-player.self-candidate")).toContainText("房主");
  await expect(host.locator(".vote-player.self-candidate")).toContainText("我");
  await expect(host.locator(".vote-player.self-candidate")).toBeDisabled();
  await expect(host.locator(".vote-player small")).toHaveText(["上轮 2 票", "上轮 2 票"]);

  await Promise.all(contexts.map((context) => context.close()));
});

test("six-player game preserves identity on refresh and lets an eliminated host keep control", async ({ browser }) => {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  for (let index = 0; index < 6; index += 1) {
    const context = await browser.newContext();
    contexts.push(context);
    pages.push(await context.newPage());
  }
  const host = pages[0]!;
  await openOnline(host, "房主");
  await host.locator(".entry-choice.create").click();
  await host.getByRole("button", { name: "平民数量减一" }).click();
  await host.getByRole("button", { name: "卧底数量加一" }).click();
  await host.getByRole("button", { name: "创建房间", exact: true }).click();
  const roomCode = (await host.locator(".room-code-card strong").textContent())!.trim();

  await Promise.all(pages.slice(1).map((page, index) => joinRoom(page, `玩家${index + 2}`, roomCode)));
  await expect(host.getByText("6 / 6")).toBeVisible();
  await host.getByRole("button", { name: "开始游戏" }).click();

  const roles: string[] = [];
  for (const page of pages) {
    await page.locator(".identity-card").click();
    roles.push((await page.locator(".identity-card.revealed strong").textContent())!.trim());
  }
  expect(roles.filter((role) => role === "卧底")).toHaveLength(2);
  expect(roles).toContain("白板");

  const recoveredRole = roles[5]!;
  await pages[5]!.reload();
  await expect(pages[5]!.locator(".identity-card")).toBeVisible();
  await pages[5]!.locator(".identity-card").click();
  await expect(pages[5]!.locator(".identity-card.revealed strong")).toHaveText(recoveredRole);

  const hostIsUndercover = roles[0] === "卧底";
  const leaverIndex = roles.findIndex((role, index) => index > 0 && (hostIsUndercover ? role !== "卧底" : role === "卧底"));
  expect(leaverIndex).toBeGreaterThan(0);
  const leaver = pages[leaverIndex]!;
  await leaver.getByRole("button", { name: "房间操作" }).click();
  await leaver.getByRole("button", { name: "退出房间" }).click();
  await leaver.getByRole("button", { name: "确认", exact: true }).click();
  await expect(leaver.getByRole("heading", { name: "线上联机" })).toBeVisible();

  await host.getByRole("button", { name: /结束发言/ }).click();
  for (let index = 0; index < pages.length; index += 1) {
    if (index === leaverIndex) continue;
    const page = pages[index]!;
    const targetName = index === 0 ? `玩家${[1, 2, 3, 4, 5].find((candidate) => candidate !== leaverIndex)! + 1}` : "房主";
    await page.getByRole("button", { name: new RegExp(targetName) }).click();
    await page.getByRole("button", { name: "确认匿名投票" }).click();
  }

  await expect(host.getByRole("button", { name: /结束发言/ })).toBeVisible({ timeout: 10_000 });
  await expect(host.locator(".speaking-list")).not.toContainText("房主");
  await host.getByRole("button", { name: "房间操作" }).click();
  await expect(host.getByRole("button", { name: "解散房间" })).toBeVisible();

  await Promise.all(contexts.map((context) => context.close()));
});

test("a non-playing host can run a three-player game without receiving a role or vote", async ({ browser }) => {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  for (let index = 0; index < 4; index += 1) {
    const context = await browser.newContext();
    contexts.push(context);
    pages.push(await context.newPage());
  }
  const host = pages[0]!;
  await openOnline(host, "主持人");
  await host.locator(".entry-choice.create").click();
  await host.getByRole("button", { name: "平民数量减一" }).click();
  await host.getByRole("button", { name: "平民数量减一" }).click();
  await host.getByRole("button", { name: "白板数量减一" }).click();
  await host.getByRole("switch").click();
  await host.getByRole("button", { name: "创建房间", exact: true }).click();
  const roomCode = (await host.locator(".room-code-card strong").textContent())!.trim();

  await Promise.all(pages.slice(1).map((page, index) => joinRoom(page, `参赛者${index + 1}`, roomCode)));
  await expect(host.getByText("3 / 3")).toBeVisible();
  await host.getByRole("button", { name: "开始游戏" }).click();
  await expect(host.getByText("你本局只负责主持")).toBeVisible();
  await expect(host.locator(".identity-card")).toHaveCount(0);
  await expect(host.locator(".speaking-list .speaker-row")).toHaveCount(3);

  await host.getByRole("button", { name: /结束发言/ }).click();
  await expect(host.getByText("等待房主", { exact: false })).toHaveCount(0);
  await expect(host.getByRole("button", { name: "确认匿名投票" })).toHaveCount(0);
  await expect(host.getByText("已提交：0 / 3")).toBeVisible();

  await Promise.all(contexts.map((context) => context.close()));
});
