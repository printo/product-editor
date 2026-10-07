import { expect, test } from '@playwright/test';

// The form is checked, never submitted: submitting sends credentials to the
// production PIA service, which a test must not do.
test.describe('login', () => {
  test('the login page renders its form', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByPlaceholder('Enter your username')).toBeVisible();
    await expect(page.getByPlaceholder('Enter your password')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('staff pages send a signed-out visitor to /login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });
});
