#!/usr/bin/env node
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-web-security'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, bypassCSP: true });
  const page = await context.newPage();
  
  // Go to the live tunnel URL (same as Daniel sees)
  await page.goto('https://drill-reads-mathematical-margaret.trycloudflare.com', { waitUntil: 'networkidle', timeout: 30000 });
  await page.screenshot({ path: '/workspace/agent-themes/screenshots/live-01-landing.png', fullPage: true });
  console.log('Landing done');
  
  // Switch to Create tab
  await page.click('.tab[data-tab="create"]');
  await page.waitForTimeout(300);
  
  // Type Breaking Bad and submit
  await page.fill('#theme-input', 'Breaking Bad');
  await page.click('#generate-btn');
  
  // Wait for the tree
  try {
    await page.waitForSelector('.org-tree', { timeout: 20000 });
    await page.waitForTimeout(1000);
    console.log('Tree rendered');
  } catch(e) {
    console.log('Tree NOT found after 20s');
    // Check what's visible
    const html = await page.evaluate(() => document.querySelector('#step-preview')?.innerHTML?.slice(0, 500) || 'no preview');
    console.log('Preview:', html);
  }
  
  await page.screenshot({ path: '/workspace/agent-themes/screenshots/live-02-fulltree.png', fullPage: true });
  
  const tree = await page.$('.org-tree');
  if (tree) {
    await tree.screenshot({ path: '/workspace/agent-themes/screenshots/live-03-treeonly.png' });
  }
  
  // Also check what's in the org-tree div
  const treeHTML = await page.evaluate(() => {
    const el = document.getElementById('org-tree');
    return el ? el.innerHTML.slice(0, 1000) : 'NOT FOUND';
  });
  console.log('Tree HTML:', treeHTML);
  
  // Check for any JS errors
  const logs = [];
  page.on('console', msg => logs.push(msg.text()));
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('.tab[data-tab="create"]');
  await page.click('button.pick[data-theme="Breaking Bad"]');
  await page.waitForTimeout(5000);
  
  if (logs.length) console.log('Console:', logs.join('\n'));
  
  await page.screenshot({ path: '/workspace/agent-themes/screenshots/live-04-reloaded.png', fullPage: true });
  
  await browser.close();
  console.log('All done');
})();
