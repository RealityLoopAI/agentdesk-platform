import { expect, test, type Page } from '@playwright/test';

async function loginViaMockFeishu(page: Page): Promise<void> {
  await page.goto('/login');
  await expect(page).toHaveTitle('RealityLoop AgentDesk');
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
  await page.getByRole('link', { name: /使用飞书登录/ }).click();
  await expect(page).toHaveURL(/\/mock-feishu\/authorize/);
  await expect(page.getByRole('heading', { name: '飞书测试身份授权' })).toBeVisible();
  await page.getByRole('link', { name: '同意并继续' }).click();
  await expect(page).toHaveURL('/conversations');
  await expect(page.getByText('Alice 实习生')).toBeVisible();
}

async function openMainConversation(page: Page): Promise<void> {
  await page.getByRole('link', { name: /研究 Agent/ }).click();
  await expect(page).toHaveURL('/conversations/lane-main');
  await expect(page.getByText('这是一条从飞书同步过来的历史消息。')).toBeVisible();
  await expect(page.getByText('来自飞书', { exact: true })).toBeVisible();
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const composer = page.getByLabel('输入消息');
  await composer.fill(text);
  await composer.press('Enter');
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.getByText(`Agent 已收到：${text.replace('[慢速]', '').trim()}`, { exact: true })).toBeVisible();
}

test('通过 Mock 飞书 SSO 登录，完成消息往返并在刷新后恢复', async ({ page }) => {
  await loginViaMockFeishu(page);
  await openMainConversation(page);
  await sendMessage(page, '请总结今天的研究进度');

  await page.reload();
  await expect(page).toHaveURL('/conversations/lane-main');
  await expect(page.getByText('请总结今天的研究进度', { exact: true })).toBeVisible();
  await expect(page.getByText('Agent 已收到：请总结今天的研究进度', { exact: true })).toBeVisible();
});

test('用户可以显式开启飞书回复提醒并在刷新后保留状态', async ({ page }) => {
  await loginViaMockFeishu(page);
  await openMainConversation(page);

  const toggle = page.getByRole('switch', { name: '同步 Agent 回复到飞书' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  await page.reload();
  await expect(page.getByRole('switch', { name: '同步 Agent 回复到飞书' })).toHaveAttribute('aria-checked', 'true');
});

test('SSE 断线后携带游标重连，Session 过期时返回登录页', async ({ page }) => {
  await loginViaMockFeishu(page);
  await openMainConversation(page);
  await sendMessage(page, '生成一个用于建立游标的回复');

  await page.evaluate(() => fetch('/__test__/disconnect-events', { method: 'POST' }));
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const response = await fetch('/__test__/state');
        const state = (await response.json()) as { eventRequests: Array<string | null> };
        return state.eventRequests.length >= 2 && state.eventRequests.at(-1) !== null;
      }),
    )
    .toBe(true);

  await page.evaluate(() => fetch('/__test__/expire-session', { method: 'POST' }));
  await expect(page).toHaveURL('/login');
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
});

test('品牌化桌面和窄屏布局保持稳定且没有页面级横向溢出', async ({ page }) => {
  await page.goto('/login');
  await expect(page).toHaveTitle('RealityLoop AgentDesk');
  await expect(page).toHaveScreenshot('login.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.05,
  });

  await loginViaMockFeishu(page);
  await openMainConversation(page);
  await expect(page.locator('main')).toHaveScreenshot('conversation.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.05,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );
});

test('窄屏可以从消息页返回列表，低动态模式会关闭 Logo 动画', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', '只在手机尺寸下验证窄屏交互');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await loginViaMockFeishu(page);
  await openMainConversation(page);

  const composer = page.getByLabel('输入消息');
  await composer.fill('[慢速] 检查低动态模式');
  await composer.press('Enter');
  const processing = page.getByText('助手正在处理…');
  await expect(processing).toBeVisible();
  const animationName = await processing
    .locator('xpath=..')
    .locator('img')
    .evaluate((logo) => getComputedStyle(logo).animationName);
  expect(animationName).toBe('none');

  await page.getByRole('link', { name: '返回会话列表' }).click();
  await expect(page).toHaveURL('/conversations');
  await expect(page.getByRole('navigation', { name: '会话列表' })).toBeVisible();
});
