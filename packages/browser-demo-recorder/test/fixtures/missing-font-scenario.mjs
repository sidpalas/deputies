export default async ({ page }) => {
  await page.goto(
    'data:text/html,<style>@font-face{font-family:MissingCaptureFont;src:url(http://127.0.0.1:9/missing.woff2)}body{font-family:MissingCaptureFont}</style><h1>Missing font</h1>',
  );
  await page.locator('h1').waitFor();
};
