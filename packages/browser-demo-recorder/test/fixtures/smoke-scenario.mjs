export default async ({ page, caption, click }) => {
  await page.goto('data:text/html,<button>Record demo</button><h1>Ready</h1>');
  await caption('Browser capture smoke test', 300);
  await click(page.getByRole('button', { name: 'Record demo' }));
  await page.waitForTimeout(300);
};
