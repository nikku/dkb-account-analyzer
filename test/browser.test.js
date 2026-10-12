import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';

let url, server;
const demoSubset = (await readFile(new URL('../public/demo.csv', import.meta.url), 'utf8')).split('\n').slice(0, 9).join('\n');
const fixture = `"Girokonto";"DE-test"
"Kontostand vom 10.10.2026:";"1.000,00 €"
"Buchungsdatum";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Betrag (€)"
"10.10.26";"Gebucht";"Employer";"Camera shop";"One-time camera";"-200"
"09.10.26";"Gebucht";"Employer";"REWE";"Groceries";"-60"
"09.10.26";"Vorgemerkt";"Employer";"Pending shop";"Pending purchase";"-25"
"11.10.26";"Vorgemerkt";"Employer";"Future shop";"Future purchase";"-30"
"08.10.26";"Gebucht";"Employer";"Me";"Salary";"500"
"09.09.26";"Gebucht";"Employer";"REWE";"Groceries";"-50"
"08.09.26";"Gebucht";"Employer";"Me";"Salary";"500"
"01.07.26";"Gebucht";"Employer";"Shop";"Earlier purchase";"-10"`;

let browser, context, page, errors;

async function upload(text = fixture, name = 'account.csv') {
  await page.locator('#file-input').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });
  await page.locator('#dashboard').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#import-status').hidden);
}

describe('Offline browser application', () => {
  before(async () => {
    const assets = {
      '/': ['index.html', 'text/html'],
      '/index.html': ['index.html', 'text/html'],
      '/styles.css': ['styles.css', 'text/css'],
      '/app.js': ['app.js', 'text/javascript'],
      '/analyzer.js': ['analyzer.js', 'text/javascript'],
      '/demo.csv': ['demo.csv', 'text/csv']
    };
    server = createServer(async (request, response) => {
      const asset = assets[new URL(request.url, 'http://localhost').pathname];
      if (!asset) { response.writeHead(404).end('Not found'); return; }
      try {
        const content = await readFile(new URL(`../public/${asset[0]}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` }).end(content);
      } catch (error) {
        response.writeHead(500).end(error.message);
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}/`;
    const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
    browser = await chromium.launch({ executablePath, headless: true });
  });
  after(async () => {
    await browser?.close();
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
    page = await context.newPage();
    errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
  });
  afterEach(async () => { await context.close(); });

  it('loads analyzer through native module imports without a browser global', async () => {
    // given
    const browserPage = page;
    // when
    const result = await browserPage.evaluate(async () => {
      const analyzer = await import('./analyzer.js');
      return {
        scripts: Array.from(document.scripts, script => ({ type: script.type, src: new URL(script.src).pathname })),
        parseExport: typeof analyzer.parseExport,
        global: Object.hasOwn(window, 'AccountAnalyzer')
      };
    });
    // then
    assert.deepEqual({ ...result, errors }, { scripts: [{ type: 'module', src: '/app.js' }], parseExport: 'function', global: false, errors: [] });
  });

  it('explains the account CSV import, purpose and browser-only processing before loading', async () => {
    // given
    const landing = page.locator('#drop-zone');
    // when
    const text = await landing.innerText();
    const result = await page.evaluate(() => ({
      landingVisible: !document.querySelector('#drop-zone').hidden,
      dashboardHidden: document.querySelector('#dashboard').hidden,
      picker: document.querySelector('#file-input').accept,
      dropText: document.querySelector('.import-target').innerText
    }));
    // then
    assert.equal(result.landingVisible && result.dashboardHidden && result.picker === '.csv,text/csv' &&
      text.includes('See how your account balance develops over time') &&
      text.includes('whether regular income covers regular expenses') &&
      text.includes('extra income and expenses affect your overall balance across the last 365 days') &&
      text.includes('Compare monthly income and spending trends') &&
      text.includes('inspect the transactions behind each total') &&
      result.dropText.includes('Drop a CSV export of your DKB account here to analyze it.') &&
      result.dropText.includes('Data stays in your browser. Nothing is uploaded.') &&
      !text.includes('See where your money goes'), true);
  });

  it('opens fictional account data from the landing demo link', async () => {
    // given
    const link = page.getByRole('link', { name: 'Explore the demo' });
    // when
    await link.click();
    await page.locator('#dashboard').waitFor({ state: 'visible' });
    const demoVisible = await page.locator('#demo-badge').isVisible();
    // then
    assert.equal(demoVisible && page.url().endsWith('?demo=1'), true);
  });

  it('uses the same width for the landing panel and loaded dashboard', async () => {
    // given
    const landing = await page.locator('#drop-zone').boundingBox();
    // when
    await upload(demoSubset);
    await page.locator('#dashboard').waitFor({ state: 'visible' });
    const dashboard = await page.locator('#insights').boundingBox();
    // then
    assert.deepEqual({ x: landing.x, width: landing.width }, { x: dashboard.x, width: dashboard.width });
  });

  it('prints a report with full account identity and monthly details on a new page', async () => {
    // given
    await page.goto(`${url}?demo=1`);
    await page.locator('#dashboard').waitFor({ state: 'visible' });
    // when
    await page.emulateMedia({ media: 'print' });
    const result = await page.evaluate(() => ({
      report: document.querySelector('#print-report-header').textContent,
      masthead: getComputedStyle(document.querySelector('.masthead')).display,
      controls: getComputedStyle(document.querySelector('.range-filter')).display,
      accountLine: getComputedStyle(document.querySelector('.account-line')).display,
      monthlyBreak: getComputedStyle(document.querySelector('#monthly-details')).breakBefore,
      monthBreak: getComputedStyle(document.querySelector('.month')).breakInside,
      transactionsVisible: document.querySelector('.sheet-transactions').getClientRects().length > 0,
      breakdown: getComputedStyle(document.querySelector('.month-breakdown')).display,
      source: document.querySelector('#print-report-footer').innerText,
      sourceDisplay: getComputedStyle(document.querySelector('#print-report-footer')).display,
      pageBackground: getComputedStyle(document.documentElement).backgroundColor
    }));
    // then
    assert.equal(
      result.report.includes('Account analysis') &&
      result.report.includes('Girokonto · DE00XXXX00000000000000') &&
      result.report.includes('Export period: 01 Nov 2024 – 31 Oct 2026') &&
      result.report.includes('Balance as of 31 Oct 2026: 12.480,20') &&
      result.masthead === 'none' && result.controls === 'none' && result.accountLine === 'none' &&
      result.monthlyBreak === 'page' && result.monthBreak === 'avoid' &&
      !result.transactionsVisible && result.breakdown === 'none' &&
      result.source === 'Generated with DKB Account Analyzer.' && result.sourceDisplay === 'block' &&
      result.pageBackground === 'rgb(255, 255, 255)', true
    );
  });

  it('explains the browser-only badge using the shared tooltip before import', async () => {
    // given
    const badge = page.locator('.privacy');
    // when
    await badge.focus();
    const text = await page.locator('#hover-panel').innerText();
    const describedBy = await badge.getAttribute('aria-describedby');
    const structuredElements = await page.locator('#hover-panel > strong, #hover-panel .hover-row').count();
    // then
    assert.deepEqual({ describedBy, structuredElements, text }, {
      describedBy: 'hover-panel', structuredElements: 0,
      text: 'Account data is analyzed locally in the browser. Nothing is uploaded or sent to a server.'
    });
  });

  it('explains recurring income in plain prose without repeating its amount or badge label', async () => {
    // given
    await page.goto(`${url}?demo=1`);
    const month = page.locator('.month').first();
    await month.waitFor();
    await month.locator('> summary').click();
    await month.locator('[data-kind="income"] > summary').click();
    // when
    await month.locator('[data-kind="income"] .badge').first().focus();
    const text = await page.locator('#hover-panel').innerText();
    const structuredElements = await page.locator('#hover-panel > strong, #hover-panel .hover-row').count();
    // then
    assert.deepEqual({ text, structuredElements }, {
      text: 'Same sender with similar amounts in adjacent calendar months (within 15%).',
      structuredElements: 0
    });
  });

  it('keeps landing copy and the CSV picker within a mobile viewport', async () => {
    // given
    await page.setViewportSize({ width: 390, height: 900 });
    // when
    const result = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    const visible = await page.locator('#file-input').isVisible();
    // then
    assert.equal(result && visible, true);
  });

  for (const width of [390, 820, 1280]) {
    it(`keeps the account CSV picker text unclipped at ${width}px`, async () => {
      // given
      await page.setViewportSize({ width, height: 900 });
      // when
      const result = await page.locator('.import-target .file-button').evaluate(element => ({
        fits: element.scrollWidth <= element.clientWidth,
        pageFits: document.documentElement.scrollWidth <= innerWidth
      }));
      // then
      assert.deepEqual(result, { fits: true, pageFits: true });
    });
  }

  it('labels the replacement action explicitly and keeps the mobile header within the viewport', async () => {
    // given
    await page.setViewportSize({ width: 390, height: 900 });
    // when
    await page.goto(`${url}?demo=1`);
    await page.locator('#replace-file').waitFor();
    const text = await page.locator('#replace-file').innerText();
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    // then
    assert.deepEqual({ text, fits }, { text: 'Open account export (CSV)', fits: true });
  });

  it('imports a fictional DKB export subset offline and displays reconstructed balance and totals', async () => {
    // given
    const text = demoSubset;
    // when
    await upload(text);
    const result = await page.evaluate(() => ({
      balance: document.querySelector('#current-balance').textContent,
      totals: Array.from(document.querySelectorAll('.month[data-period="0"] .balance-amount'), cell => cell.textContent),
      markers: document.querySelectorAll('.chart-marker').length,
      partial: document.querySelector('.month-label').textContent,
      importHidden: document.querySelector('#drop-zone').hidden && document.querySelector('#import-status').hidden
    }));
    // then
    assert.deepEqual({ ...result, errors }, { balance: '12.480,20 €', totals: ['-328,34 €', '0,00 €', '0,00 €', '-328,34 €', '0,00 €'], markers: 2, partial: 'October 2026from 22 Oct', importHidden: true, errors: [] });
  });

  it('shows one collapsed row per calendar month with its balance change, excluding pending transactions', async () => {
    // given
    const text = fixture;
    // when
    await upload(text);
    const result = await page.evaluate(() => ({
      months: Array.from(document.querySelectorAll('.month > summary'), row => [row.querySelector('.month-name').textContent, row.querySelector('.balance-amount').textContent]),
      october: Array.from(document.querySelectorAll('.month[data-period="0"] .balance-row'), row => [row.dataset.kind, row.querySelector('.balance-amount').textContent]),
      collapsed: Array.from(document.querySelectorAll('.month')).every(month => !month.open)
    }));
    // then
    assert.deepEqual(result, {
      months: [['October 2026', '+240,00 €'], ['September 2026', '+450,00 €'], ['August 2026', '0,00 €'], ['July 2026', '-10,00 €']],
      october: [['income', '+500,00 €'], ['extraIncome', '0,00 €'], ['regular', '-60,00 €'], ['special', '-200,00 €']],
      collapsed: true
    });
  });

  it('keeps the month total in its header with expandable groups nested beneath it', async () => {
    // given
    await upload();
    const month = page.locator('.month[data-period="0"]');
    const collapsedTotal = await month.locator('> summary .balance-amount').textContent();
    // when
    await month.locator('> summary').click();
    const result = await month.evaluate(element => ({
      rows: Array.from(element.querySelectorAll(':scope > .month-breakdown > .balance-row'), row => row.querySelector('.balance-label').textContent),
      duplicateTotal: Boolean(element.querySelector('.month-total')),
      headerAmount: element.querySelector(':scope > summary .balance-amount').textContent,
      headerAmountShown: getComputedStyle(element.querySelector(':scope > summary .balance-amount')).visibility === 'visible',
      nested: element.querySelector('.balance-row > summary').getBoundingClientRect().left > element.querySelector(':scope > summary').getBoundingClientRect().left
    }));
    // then
    assert.deepEqual({ collapsedTotal, ...result }, { collapsedTotal: '+240,00 €', rows: ['Income', 'Extra income', 'Expenses', 'Extra expenses'], duplicateTotal: false, headerAmount: '+240,00 €', headerAmountShown: true, nested: true });
  });

  it('shows no month-over-month percentages in the month table', async () => {
    // given
    const text = fixture;
    // when
    await upload(text);
    const result = await page.locator('#monthly-rows .change').count();
    // then
    assert.equal(result, 0);
  });

  it('keeps vertical stems continuous across expanded groups with consistent row spacing', async () => {
    // given
    await upload();
    const month = page.locator('.month[data-period="0"]');
    // when
    await month.locator('> summary').click();
    await month.locator('[data-kind="income"] > summary').click();
    await month.locator('[data-kind="extraIncome"] > summary').click();
    const result = await month.evaluate(element => {
      const rows = Array.from(element.querySelectorAll('.balance-row'));
      const summaries = [element.querySelector(':scope > summary'), ...rows.map(row => row.querySelector('summary'))];
      return {
        background: getComputedStyle(element).backgroundColor,
        continuous: rows.slice(1).every((row, i) => Math.abs(row.getBoundingClientRect().top - rows[i].getBoundingClientRect().bottom) < 1),
        padding: summaries.every((summary, index) => {
          const style = getComputedStyle(summary);
          return style.paddingTop === (index === 0 ? '8px' : '6px') &&
            style.paddingBottom === (index === 0 ? '8px' : '6px') && style.paddingLeft === '8px';
        }),
        compact: rows.every(row => row.querySelector('summary').getBoundingClientRect().height === 32),
        expandedSpacing: rows.filter(row => row.open).every(row => getComputedStyle(row).paddingBottom === '8px'),
        stem: rows.slice(0, -1).every(row => Math.abs(parseFloat(getComputedStyle(row, '::before').height) - row.getBoundingClientRect().height) < 1)
      };
    });
    // then
    assert.deepEqual(result, { background: 'rgba(0, 0, 0, 0)', continuous: true, padding: true, compact: true, expandedSpacing: true, stem: true });
  });

  it('uses consistent CSS chevrons and guide lines without emoji or text branches', async () => {
    // given
    await upload();
    const month = page.locator('.month[data-period="0"]');
    const closedIcon = await month.locator('> summary').evaluate(element => getComputedStyle(element, '::before').transform);
    // when
    await month.locator('> summary').click();
    const result = await month.evaluate(element => ({
      openIcon: getComputedStyle(element.querySelector(':scope > summary'), '::before').transform,
      iconContent: getComputedStyle(element.querySelector(':scope > summary'), '::before').content,
      font: getComputedStyle(element).fontFamily,
      branch: getComputedStyle(element.querySelector('.balance-row'), '::after').borderTopStyle,
      lastStemHeight: getComputedStyle(element.querySelector('.balance-row:last-child'), '::before').height
    }));
    // then
    assert.equal(closedIcon !== result.openIcon && result.iconContent === '""' && result.font.includes('monospace') && result.branch === 'solid' && result.lastStemHeight === '16px', true);
  });

  for (const width of [1280, 390]) {
    it(`aligns month, group and transaction amount text at ${width}px viewport width`, async () => {
      // given
      await page.setViewportSize({ width, height: 900 });
      await upload();
      const month = page.locator('.month[data-period="0"]');
      // when
      await month.locator('> summary').click();
      await month.locator('[data-kind="income"] > summary').click();
      await month.locator('[data-kind="regular"] > summary').click();
      const spread = await month.evaluate(element => {
        const amounts = Array.from(element.querySelectorAll('.balance-amount, details[open] .transaction-table td:last-child'));
        const edges = amounts.map(amount => {
          const range = document.createRange();
          range.selectNodeContents(amount);
          return range.getBoundingClientRect().right;
        });
        return Math.max(...edges) - Math.min(...edges);
      });
      // then
      assert.ok(spread < 1, `Amount text right edges differ by ${spread}px`);
    });
  }

  it('shows monthly quick facts with explicit periods and no trend for short exports', async () => {
    // given
    const text = fixture;
    // when
    await upload(text);
    const result = await page.evaluate(() => ({
      items: Array.from(document.querySelectorAll('#monthly-insights .insight'), item => [item.querySelector('.insight-value').textContent, JSON.parse(item.querySelector('.insight-value').dataset.hover).rows[0][1]]),
      trendHidden: document.querySelector('#trend').hidden
    }));
    // then
    assert.deepEqual(result, { items: [['20,00 €', 'Jul 26 – Sept 26'], ['166,67 €', 'Jul 26 – Sept 26']], trendHidden: true });
  });

  it('separates quick comparisons from full-history trend graphs', async () => {
    // given
    await page.goto(`${url}?demo=1`);
    // when
    await page.locator('.trend-spark .trend-line').first().waitFor();
    const result = await page.evaluate(() => ({
      basis: document.querySelector('#trend-basis').textContent,
      changes: Array.from(document.querySelectorAll('#monthly-insights .change'), badge => [badge.textContent, badge.className]),
      periods: Array.from(document.querySelectorAll('#monthly-insights .insight-value'), value => JSON.parse(value.dataset.hover).rows[0][1]),
      comparison: JSON.parse(document.querySelector('#monthly-insights .change').dataset.hover).heading,
      graphNumbers: document.querySelectorAll('#trend .change, #trend .trend-value').length,
      lines: document.querySelectorAll('.trend-spark .trend-line').length
    }));
    // then
    assert.deepEqual({ ...result, errors }, {
      basis: 'Rolling 3-month average', changes: [['+7.0%', 'change negative'], ['+3.8%', 'change positive']],
      periods: ['Aug 26 – Oct 26', 'Aug 26 – Oct 26'], comparison: 'Expenses',
      graphNumbers: 0, lines: 3, errors: []
    });
  });

  it('shows rolling 365-day extra totals against the preceding 365 days', async () => {
    // given
    await page.goto(`${url}?demo=1`);
    await page.locator('#extra-insights .insight').first().waitFor();
    // when
    const result = await page.evaluate(() => {
      const income = document.querySelector('#extra-insights [data-kind="extraIncome"]');
      const expense = document.querySelector('#extra-insights [data-kind="special"]');
      return {
        period: JSON.parse(expense.querySelector('.insight-value').dataset.hover).rows[0][1],
        calculation: JSON.parse(expense.querySelector('.insight-value').dataset.hover).rows.find(row => row[0] === 'Calculation')[1],
        coverage: JSON.parse(expense.querySelector('.insight-value').dataset.hover).rows.find(row => row[0] === 'Coverage')[1],
        label: expense.querySelector('.insight-heading > span').textContent,
        income: income.querySelector('.insight-value').textContent,
        expense: expense.querySelector('.insight-value').textContent,
        changes: Array.from(document.querySelectorAll('#extra-insights .change'), badge => badge.textContent),
        comparedWith: JSON.parse(expense.querySelector('.change').dataset.hover).rows.find(row => row[0] === 'Compared with')[1],
        figures: document.querySelectorAll('#extra-insights .insight strong').length,
        tables: document.querySelectorAll('#insights table').length
      };
    });
    // then
    assert.deepEqual(result, {
      period: '01 Nov 2025 – 31 Oct 2026', calculation: 'Total over 365 days', coverage: 'Full 365 days',
      label: 'Extra expenses', income: '1.840,00 €', expense: '3.513,00 €',
      changes: ['+1.5%', '+60.0%'], comparedWith: '01 Nov 2024 – 31 Oct 2025', figures: 2, tables: 0
    });
  });

  it('explains partial 365-day coverage and withholds comparison until export covers both periods', async () => {
    // given
    await upload();
    // when
    const result = await page.evaluate(() => {
      const expense = document.querySelector('#extra-insights [data-kind="special"]');
      const tooltip = JSON.parse(expense.querySelector('.insight-value').dataset.hover);
      return {
        period: tooltip.rows.find(row => row[0] === 'Period')[1],
        calculation: tooltip.rows.find(row => row[0] === 'Calculation')[1],
        coverage: tooltip.rows.find(row => row[0] === 'Coverage')[1],
        comparison: expense.querySelector('.change')
      };
    });
    // then
    assert.deepEqual({ ...result, errors }, {
      period: '11 Oct 2025 – 10 Oct 2026', calculation: 'Total over 365 days',
      coverage: 'Partial; export starts 01 Jul 2026', comparison: null, errors: []
    });
  });

  it('reconciles baseline margin, extras balance and total income margin from rolling yearly totals', async () => {
    // given
    await page.goto(`${url}?demo=1`);
    await page.locator('#yearly-insights .insight').first().waitFor();
    // when
    const result = await page.evaluate(() => {
      const cost = document.querySelector('#yearly-insights [data-kind="costOfLiving"]');
      const costHover = JSON.parse(cost.querySelector('.insight-value').dataset.hover);
      const costComparison = JSON.parse(cost.querySelector('.change').dataset.hover);
      const margin = document.querySelector('#margin-insights [data-kind="totalIncomeMargin"]');
      const components = Array.from(margin.querySelectorAll('.margin-component'), component => ({
        label: component.querySelector('span').textContent,
        amount: component.querySelector('strong').textContent,
        calculation: JSON.parse(component.dataset.hover).rows.find(row => row[0] === 'Calculation')[1]
      }));
      const totalRows = JSON.parse(margin.querySelector('.margin-primary').dataset.hover).rows;
      return {
        cost: cost.querySelector('strong').textContent,
        costChange: cost.querySelector('.change').textContent,
        costCalculation: costHover.rows.find(row => row[0] === 'Calculation')[1],
        previousCost: costComparison.rows.find(row => row[0] === 'Previous cost of living')[1],
        total: margin.querySelector('.margin-primary strong').textContent,
        totalUnit: margin.querySelector('.margin-primary .insight-unit').textContent,
        totalPercentage: margin.querySelector('.margin-primary .margin-rate').textContent,
        components,
        totalRows
      };
    });
    await page.locator('#margin-insights .margin-primary').focus();
    result.totalTooltipFits = await page.locator('#hover-panel').evaluate(panel => panel.scrollHeight <= panel.clientHeight);
    // then
    assert.deepEqual(result, {
      cost: '29.139,71 €', costChange: '+3.6%', costCalculation: 'Regular and extra expenses over 365 days', previousCost: '28.126,64 €',
      total: '458,36 €', totalUnit: '/ month', totalPercentage: '+15.9% of income',
      components: [
        { label: 'Baseline margin', amount: '597,77 €', calculation: '(Recurring income − regular expenses) ÷ 12' },
        { label: '+ Extras balance', amount: '-139,42 €', calculation: '(Extra income − extra expenses) ÷ 12' },
        { label: '= Total', amount: '458,36 €', calculation: '(All income − all expenses) ÷ 12' }
      ],
      totalRows: [
        ['Period', '01 Nov 2025 – 31 Oct 2026'],
        ['Calculation', '(All income − all expenses) ÷ 12'],
        ['Coverage', 'Full 365 days'],
        ['Annual baseline margin', '7.173,29 €', true],
        ['Annual extras balance', '-1.673,00 €', true],
        ['Annual total income margin', '5.500,29 €', true],
        ['Monthly total income margin', '458,36 €', true],
        ['Total income margin', '+15.9%']
      ],
      totalTooltipFits: true
    });
  });

  it('keeps yearly insights within a mobile viewport', async () => {
    // given
    await page.setViewportSize({ width: 390, height: 900 });
    // when
    await page.goto(`${url}?demo=1`);
    await page.locator('#extra-insights .insight').first().waitFor();
    const result = await page.evaluate(() => ({
      fits: document.documentElement.scrollWidth <= innerWidth,
      figures: document.querySelectorAll('#extra-insights .insight').length
    }));
    // then
    assert.deepEqual({ ...result, errors }, { fits: true, figures: 2, errors: [] });
  });

  it('groups five supporting insight cards beneath the monthly and yearly headings', async () => {
    // given
    await page.goto(`${url}?demo=1`);
    await page.locator('#extra-insights .insight').first().waitFor();
    // when
    const result = await page.evaluate(() => ({
      labels: Array.from(document.querySelectorAll('.insights-cards .insight'), item => item.querySelector('.insight-heading > span').textContent),
      sections: Array.from(document.querySelectorAll('.insight-section-head'), heading => [heading.querySelector('h3').textContent, heading.querySelector('span')?.textContent ?? null]),
      bordered: Array.from(document.querySelectorAll('.insights-cards .insight')).every(item => getComputedStyle(item).borderTopStyle === 'solid' && parseFloat(getComputedStyle(item).paddingTop) > 0),
      layout: getComputedStyle(document.querySelector('.insights-cards')).display
    }));
    // then
    assert.deepEqual(result, {
      labels: ['Expenses', 'Income', 'Extra expenses', 'Extra income', 'Cost of living'],
      sections: [['Monthly budget', 'Rolling 3-month average · extras excluded'], ['Last 365 days', null]],
      bordered: true, layout: 'grid'
    });
  });

  it('keeps monthly tooltip titles simple and explains excluded extras in calculation rows', async () => {
    // given
    await page.goto(`${url}?demo=1`);
    const values = page.locator('#monthly-insights .insight-value');
    await values.first().waitFor();
    // when
    const hovers = await values.evaluateAll(elements => elements.map(element => JSON.parse(element.dataset.hover)));
    // then
    assert.deepEqual(hovers.map(hover => ({
      heading: hover.heading,
      calculation: hover.rows.find(row => row[0] === 'Calculation')[1]
    })), [
      { heading: 'Expenses', calculation: 'Average of 3 full months; extras excluded' },
      { heading: 'Income', calculation: 'Average of 3 full months; extras excluded' }
    ]);
  });

  it('places changes above amounts and explains an unavailable percentage with its period and totals', async () => {
    // given
    await page.goto(`${url}?demo=1`);
    await page.locator('#extra-insights .change').first().waitFor();
    // when
    const aligned = await page.evaluate(() => Array.from(document.querySelectorAll('.insight')).filter(item => item.querySelector('.change')).every(item => {
      const change = item.querySelector('.change').getBoundingClientRect();
      const amount = item.querySelector('strong').getBoundingClientRect();
      return change.bottom <= amount.top && Math.abs(change.right - amount.right) < 1;
    }));
    await page.locator('#extra-insights [data-kind="extraIncome"] .change').focus();
    const rows = await page.locator('#hover-panel .hover-row').evaluateAll(elements => elements.map(element => [element.firstElementChild.textContent, element.lastElementChild.textContent]));
    // then
    assert.deepEqual({ aligned, rows }, { aligned: true, rows: [
      ['Period', '01 Nov 2025 – 31 Oct 2026'],
      ['Calculation', 'Total over 365 days'],
      ['Coverage', 'Full 365 days'],
      ['Extras', 'Non-recurring payments of 150,00 € or more'],
      ['Current total', '1.840,00 €'],
      ['Compared with', '01 Nov 2024 – 31 Oct 2025'],
      ['Previous total', '1.150,00 €'],
      ['Difference', '+690,00 €']
    ] });
  });

  it('keeps amount tooltips descriptive and shows comparisons and differences only on badges', async () => {
    // given
    await page.goto(`${url}?demo=1`);
    await page.locator('#extra-insights .change').first().waitFor();
    // when
    const cards = await page.locator('.insights-cards .insight').evaluateAll(items => items.map(item => ({
      label: item.querySelector('.insight-heading > span').textContent,
      amountTitle: JSON.parse(item.querySelector('.insight-value').dataset.hover).heading,
      amount: JSON.parse(item.querySelector('.insight-value').dataset.hover).rows,
      comparison: item.querySelector('.change') && JSON.parse(item.querySelector('.change').dataset.hover).rows,
      rate: item.querySelector('.margin-rate')?.textContent
    })));
    // then
    const comparisons = cards.filter(card => card.comparison);
    assert.equal(cards.length === 5 && comparisons.length === 5 && comparisons.every(card =>
      card.label === card.amountTitle &&
      ['Period', 'Calculation'].every(label => card.amount.some(row => row[0] === label)) &&
      card.amount.some(row => row[0].startsWith('Current') || row[0] === 'Total cost of living') &&
      !card.amount.some(row => ['Compared with', 'Difference'].includes(row[0]) || row[0].startsWith('Previous')) &&
      ['Compared with', 'Difference'].every(label => card.comparison.some(row => row[0] === label)) &&
      card.comparison.some(row => row[0].startsWith('Previous'))
    ), true);
  });

  it('reuses a right-aligned hover panel for keyboard-focused values, comparisons and IBAN', async () => {
    // given
    await page.goto(`${url}?demo=1`);
    const expense = page.locator('#monthly-insights [data-kind="regular"] .insight-value');
    await expense.waitFor();
    // when
    await expense.focus();
    const numericAlignment = await page.locator('#hover-panel .numeric').first().evaluate(element => getComputedStyle(element).textAlign);
    await page.locator('#monthly-insights [data-kind="regular"] .change').focus();
    const heading = await page.locator('#hover-panel > strong').textContent();
    await page.keyboard.press('Escape');
    const dismissed = await page.locator('#hover-panel').isHidden();
    await page.locator('#account code').focus();
    const result = await page.evaluate(() => ({
      panels: document.querySelectorAll('[role="tooltip"]').length,
      nativeTooltips: document.querySelectorAll('#dashboard [title]').length,
      iban: document.querySelector('#account code').textContent,
      describedBy: document.querySelector('#account code').getAttribute('aria-describedby'),
      amountAlignment: getComputedStyle(document.querySelector('.insight-value strong')).textAlign
    }));
    // then
    assert.deepEqual({ ...result, numericAlignment, heading, dismissed }, {
      panels: 1, nativeTooltips: 0, iban: 'DE00XXXX00000000000000', describedBy: 'hover-panel',
      amountAlignment: 'right', numericAlignment: 'right', heading: 'Expenses', dismissed: true
    });
  });

  it('opens and dismisses the shared hover panel by tapping on mobile', async () => {
    // given
    const touchContext = await browser.newContext({ viewport: { width: 390, height: 900 }, hasTouch: true });
    const touchPage = await touchContext.newPage();
    try {
      await touchPage.goto(`${url}?demo=1`);
      const value = touchPage.locator('#monthly-insights [data-kind="income"] .insight-value');
      await value.waitFor();
      // when
      await value.tap();
      const opened = await touchPage.locator('#hover-panel').isVisible();
      const heading = await touchPage.locator('#hover-panel > strong').textContent();
      await touchPage.locator('#monthly-insights [data-kind="income"] .change').tap();
      const comparisonHeading = await touchPage.locator('#hover-panel > strong').textContent();
      await touchPage.locator('#insights-title').tap();
      const dismissed = await touchPage.locator('#hover-panel').isHidden();
      // then
      assert.deepEqual({ opened, heading, comparisonHeading, dismissed }, { opened: true, heading: 'Income', comparisonHeading: 'Income', dismissed: true });
    } finally {
      await touchContext.close();
    }
  });

  it('navigates trend values with arrow keys using the shared hover panel', async () => {
    // given
    await page.goto(`${url}?demo=1`);
    const spark = page.locator('.trend-income .trend-spark');
    await spark.waitFor();
    await spark.scrollIntoViewIfNeeded();
    // when
    await spark.focus();
    const latest = await page.locator('#hover-panel > strong').textContent();
    await page.keyboard.press('ArrowLeft');
    const previous = await page.locator('#hover-panel > strong').textContent();
    await page.keyboard.press('Escape');
    const dismissed = await page.locator('#hover-panel').isHidden();
    // then
    assert.deepEqual({ latest, previous, dismissed }, { latest: 'Ø Aug 26 – Oct 26', previous: 'Ø Jul 26 – Sept 26', dismissed: true });
  });

  it('clears trend graphs and comparisons when replaced with a partial-month export', async () => {
    // given
    await page.goto(`${url}?demo=1`);
    await page.locator('.trend-spark').first().waitFor();
    const text = demoSubset;
    // when
    await page.locator('#replacement-input').setInputFiles({ name: 'partial.csv', mimeType: 'text/csv', buffer: Buffer.from(text) });
    await page.waitForFunction(() => document.querySelector('#trend').hidden);
    const result = await page.evaluate(() => ({
      graphs: document.querySelectorAll('.trend-spark').length,
      changes: document.querySelectorAll('#insights .change').length,
      years: Array.from(document.querySelectorAll('#extra-insights .insight'), item => item.dataset.year)
    }));
    // then
    assert.deepEqual({ ...result, errors }, { graphs: 0, changes: 0, years: ['2026', '2026'], errors: [] });
  });

  it('shows the rolling average window and values of the hovered month in all trend lines', async () => {
    // given
    await page.goto(`${url}?demo=1`);
    const spark = page.locator('.trend-regular .trend-spark');
    await spark.waitFor();
    await spark.scrollIntoViewIfNeeded();
    const box = await spark.boundingBox();
    // when
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    const result = await page.evaluate(() => ({
      tooltip: document.querySelector('#hover-panel > strong').textContent,
      guides: Array.from(document.querySelectorAll('.trend-guide')).filter(guide => guide.getAttribute('visibility') === 'visible').length
    }));
    // then
    assert.deepEqual(result, { tooltip: 'Ø Nov 24 – Jan 25', guides: 3 });
  });

  it('hides the trend when no month is fully covered', async () => {
    // given
    const text = demoSubset;
    // when
    await upload(text);
    const result = await page.locator('#trend').isHidden();
    // then
    assert.equal(result, true);
  });

  it('expands extra expenses into individual transactions without categories', async () => {
    // given
    await upload();
    // when
    await page.locator('.month[data-period="0"] > summary').click();
    await page.locator('[data-kind="special"] summary').first().click();
    const result = await page.evaluate(() => ({
      extras: document.querySelector('[data-kind="special"] .sheet-transactions').innerText,
      label: document.querySelector('[data-kind="special"] .balance-label').textContent,
      categories: /Categor/.test(document.querySelector('#dashboard').textContent)
    }));
    // then
    assert.equal(result.extras.includes('Camera shop') && result.extras.includes('-200,00 €') && result.label === 'Extra expenses' && !result.categories, true);
  });

  for (const [kind, name, amount] of [['income', 'Employer', '+500,00 €'], ['regular', 'REWE', '-60,00 €']]) {
    it(`expands ${kind} into booked transactions with amounts`, async () => {
      // given
      await upload();
      const row = page.locator(`.month[data-period="0"] [data-kind="${kind}"]`);
      // when
      await page.locator('.month[data-period="0"] > summary').click();
      await row.locator('summary').click();
      const result = { text: await row.locator('.sheet-transactions').innerText(), label: await row.locator('.balance-label').innerText(), countColumn: await row.locator('.transaction-volume').count() };
      // then
      assert.equal(result.text.includes(name) && result.text.includes(amount.replace('+', '')) && result.label === (kind === 'income' ? 'Income' : 'Expenses') && result.countColumn === 0 && !result.text.includes('Pending shop'), true);
    });
  }

  it('has no transaction list and no native chart title tooltip', async () => {
    // given
    await upload();
    // when
    const result = await page.evaluate(() => ({
      list: Boolean(document.querySelector('#transaction-rows, #transaction-search, #pagination')),
      title: document.querySelectorAll('#balance-chart title').length
    }));
    // then
    assert.deepEqual(result, { list: false, title: 0 });
  });

  it('shows empty months alongside all other months without a period switcher', async () => {
    // given
    await upload();
    // when
    const result = await page.evaluate(() => ({
      totals: Array.from(document.querySelectorAll('.month[data-period="2"] .balance-amount'), cell => cell.textContent),
      switcher: document.querySelector('#period-select') !== null,
      rows: document.querySelectorAll('.month').length
    }));
    // then
    assert.deepEqual(result, { totals: ['0,00 €', '0,00 €', '0,00 €', '0,00 €', '0,00 €'], switcher: false, rows: 4 });
  });

  it('zooms into transaction markers with date controls and resets to the full range', async () => {
    // given
    await upload();
    const overviewMarkers = await page.locator('.chart-marker').count();
    // when
    await page.locator('#range-button').click();
    const modal = await page.locator('#range-dialog').evaluate(dialog => dialog.open && dialog.matches(':modal'));
    await page.locator('#chart-from').fill('2026-10-08');
    await page.locator('#chart-to').fill('2026-10-10');
    await page.locator('#range-apply').click();
    const filter = await page.locator('#range-button').innerText();
    const markers = await page.locator('.chart-marker').count();
    await page.locator('.chart-marker').first().focus();
    const tooltip = await page.locator('#hover-panel').innerText();
    await page.locator('#clear-range').click();
    const reset = await page.locator('#range-button').innerText();
    const resetHidden = await page.locator('#clear-range').isHidden();
    // then
    assert.deepEqual({ overviewMarkers, modal, filter, markers, salary: tooltip.includes('Salary'), reset, resetHidden }, { overviewMarkers: 0, modal: true, filter: '08 Oct 2026 – 10 Oct 2026', markers: 3, salary: true, reset: '01 Jul 2026 – 10 Oct 2026', resetHidden: true });
  });

  it('keeps the entry under the mouse in place when zooming with the wheel', async () => {
    // given
    await upload();
    const bounds = await page.locator('#balance-chart').boundingBox();
    const position = { x: bounds.x + bounds.width * .8, y: bounds.y + 120 };
    const dateAt = () => page.evaluate(({ x, y }) => {
      const chart = document.querySelector('#balance-chart');
      chart.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
      return document.querySelector('#hover-panel strong')?.textContent;
    }, position);
    const before = await dateAt();
    // when
    await page.mouse.move(position.x, position.y);
    await page.mouse.wheel(0, -100);
    await page.waitForFunction(() => document.querySelector('#range-button').textContent !== '01 Jul 2026 – 10 Oct 2026');
    const after = await dateAt();
    // then
    assert.deepEqual({ found: Boolean(before), after }, { found: true, after: before });
  });

  it('zooms into a selected range by dragging', async () => {
    // given
    await upload();
    const bounds = await page.locator('#balance-chart').boundingBox();
    // when
    await page.mouse.move(bounds.x + bounds.width * .6, bounds.y + 120);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * .9, bounds.y + 120, { steps: 5 });
    await page.mouse.up();
    const result = await page.locator('#range-button').innerText();
    // then
    assert.equal(/^\d{2} \w+ 2026 – \d{2} \w+ 2026$/.test(result) && result !== '01 Jul 2026 – 10 Oct 2026', true);
  });

  it('rejects an invalid chart range without changing the chart', async () => {
    // given
    await upload();
    // when
    await page.locator('#range-button').click();
    await page.locator('#chart-from').fill('2026-10-10');
    await page.locator('#chart-to').fill('2026-10-01');
    await page.locator('#range-apply').click();
    const result = { error: await page.locator('#chart-error').innerText(), open: await page.locator('#range-dialog').evaluate(dialog => dialog.open), filter: await page.locator('#range-button').innerText() };
    // then
    assert.deepEqual({ ...result, error: /From on or before To/.test(result.error) }, { error: true, open: true, filter: '01 Jul 2026 – 10 Oct 2026' });
  });

  it('loads demo data with ?demo=1 and indicates it in the header', async () => {
    // given
    const demoUrl = `${url}?demo=1`;
    // when
    await page.goto(demoUrl);
    await page.locator('#dashboard').waitFor({ state: 'visible' });
    const result = { badge: await page.locator('#demo-badge').innerText(), account: await page.locator('#account').innerText() };
    // then
    assert.deepEqual({ badge: result.badge, account: Boolean(result.account), errors }, { badge: 'Demo data', account: true, errors: [] });
  });

  it('removes the demo indicator once a real export replaces the demo', async () => {
    // given
    await page.goto(`${url}?demo=1`);
    await page.locator('#demo-badge').waitFor({ state: 'visible' });
    // when
    await page.locator('#replacement-input').setInputFiles({ name: 'account.csv', mimeType: 'text/csv', buffer: Buffer.from(fixture) });
    await page.locator('#demo-badge').waitFor({ state: 'hidden' });
    const result = await page.locator('#current-balance').innerText();
    // then
    assert.equal(result.replace(/\s/g, ' '), '1.000,00 €');
  });

  it('does not load or indicate demo data without the parameter', async () => {
    // given
    await upload();
    // when
    const result = await page.locator('#demo-badge').isHidden();
    // then
    assert.equal(result, true);
  });

  it('reports malformed files while preserving the previous analysis', async () => {
    // given
    await upload();
    // when
    await page.locator('#replacement-input').setInputFiles({ name: 'broken.csv', mimeType: 'text/csv', buffer: Buffer.from('not a DKB export') });
    await page.locator('#error').waitFor({ state: 'visible' });
    const result = await page.locator('#error').innerText();
    const balance = await page.locator('#current-balance').innerText();
    // then
    assert.equal(result.includes('Previous analysis is unchanged') && balance === '1.000,00 €', true);
  });

  it('imports a dropped file', async () => {
    // given
    const text = fixture;
    // when
    await page.locator('#drop-zone').evaluate((element, content) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([content], 'dropped.csv', { type: 'text/csv' }));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, text);
    await page.locator('#dashboard').waitFor({ state: 'visible' });
    const result = await page.locator('#drop-zone').isHidden();
    // then
    assert.equal(result, true);
  });

  it('accepts a replacement dropped anywhere after hiding the import panel', async () => {
    // given
    await upload();
    const replacement = fixture.replace('1.000,00 €', '2.000,00 €');
    // when
    await page.locator('#balance-title').evaluate((element, content) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([content], 'other.csv', { type: 'text/csv' }));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, replacement);
    await page.waitForFunction(() => document.querySelector('#current-balance').textContent === '2.000,00 €');
    const result = await page.locator('#drop-zone').isHidden();
    // then
    assert.equal(result, true);
  });

  it('shows current balance beside the chart title and keeps insights date-free', async () => {
    // given
    await upload();
    // when
    const result = await page.evaluate(() => ({
      balanceChange: Boolean(document.querySelector('#balance-change')),
      dates: /\b(?:2026|Jul|Oct|Sept)\b/.test(document.querySelector('#insights').textContent),
      balanceDate: JSON.parse(document.querySelector('#current-balance').dataset.hover).rows[0][1],
      balanceHeading: document.querySelector('#current-balance').parentElement.classList.contains('balance-heading'),
      chartNumbers: document.querySelector('#balance-title').closest('section').querySelectorAll('strong').length,
      sections: Array.from(document.querySelectorAll('#dashboard > .panel h2'), heading => heading.textContent),
      title: document.querySelector('#balance-title').textContent,
      range: document.querySelector('#export-range').textContent,
      redundantMetadata: Boolean(document.querySelector('#export-date, #transaction-count')),
      datesCollapsed: !document.querySelector('#range-dialog').open && document.querySelector('#clear-range').hidden && !document.querySelector('#zoom-in, #zoom-out, #reset-zoom'),
      applyButton: Boolean(document.querySelector('#apply-range')),
      pendingCard: Boolean(document.querySelector('#pending-net')),
      text: document.querySelector('#dashboard').textContent
    }));
    // then
    assert.equal(!result.balanceChange && !result.dates && result.balanceDate === '10 Oct 2026' && result.balanceHeading && result.chartNumbers === 1 && result.title === 'Balance' && result.sections.join(',') === 'Insights,Balance,Trend,Monthly details' && result.range === '01 Jul 2026 – 10 Oct 2026' && !result.redundantMetadata && result.datesCollapsed && !result.applyButton && !result.pendingCard && !/As reported|Cash increased|Make it yours|The big picture/.test(result.text), true);
  });

  it('flags recurring transactions with the detection reason', async () => {
    // given
    const text = fixture.replace('Camera shop', 'Vermieter').replace('One-time camera', 'Mietforderung') + '\n"10.09.26";"Gebucht";"Employer";"Vermieter";"Previous payment";"-200"\n"10.08.26";"Gebucht";"Employer";"Vermieter";"Earlier payment";"-200"';
    // when
    await upload(text);
    await page.locator('.month[data-period="0"] > summary').click();
    await page.locator('.month[data-period="0"] [data-kind="regular"] > summary').click();
    const flag = page.locator('.month[data-period="0"] [data-kind="regular"] tr').filter({ hasText: 'Vermieter' }).locator('.badge');
    await flag.focus();
    const result = { text: await flag.innerText(), reason: await page.locator('#hover-panel').innerText() };
    // then
    assert.deepEqual(result, { text: 'Recurring', reason: 'Similar recipient amounts in three consecutive months, 25–35 days apart (within 15%), without competing same-month payments.' });
  });

  it('omits percentages involving partial periods', async () => {
    // given
    const text = fixture.split('\n').filter(line => !line.includes('01.07.26') && !line.includes('08.09.26')).join('\n');
    // when
    await upload(text);
    const result = await page.evaluate(() => ({
      changes: document.querySelectorAll('.change').length,
      partial: document.querySelectorAll('.month-label .pending').length
    }));
    // then
    assert.deepEqual(result, { changes: 0, partial: 2 });
  });

  it('renders CSV text literally rather than as markup', async () => {
    // given
    const text = fixture.replace('One-time camera', '<img src=x onerror=alert(1)>');
    // when
    await upload(text);
    const result = await page.locator('#monthly-rows').textContent();
    const images = await page.locator('#monthly-rows img').count();
    // then
    assert.equal(result.includes('<img src=x onerror=alert(1)>') && images === 0, true);
  });

  it('supports Windows-1252 exports without mangling umlauts', async () => {
    // given
    const text = fixture.replaceAll('€', '\x80').replace('Camera shop', 'Müller');
    // when
    await page.locator('#file-input').setInputFiles({ name: 'legacy.csv', mimeType: 'text/csv', buffer: Buffer.from(text, 'latin1') });
    await page.locator('#dashboard').waitFor({ state: 'visible' });
    const result = await page.locator('#monthly-rows').textContent();
    // then
    assert.match(result, /Müller/);
  });

  it('handles a pending-only export with no historical chart', async () => {
    // given
    const text = fixture.split('\n').filter((line, index) => index < 3 || line.includes('Vorgemerkt')).join('\n');
    // when
    await upload(text);
    const result = await page.locator('#balance-chart').textContent();
    // then
    assert.match(result, /No booked transactions to reconstruct/);
  });

  it('keeps the page within a mobile viewport with expanded month details', async () => {
    // given
    await page.setViewportSize({ width: 390, height: 844 });
    // when
    await upload();
    await page.locator('.month[data-period="0"] > summary').click();
    await page.locator('.month[data-period="0"] [data-kind="special"] > summary').click();
    const result = await page.evaluate(() => ({
      fits: document.documentElement.scrollWidth <= window.innerWidth,
      chart: document.querySelector('#balance-chart').getBoundingClientRect().width > 0
    }));
    // then
    assert.deepEqual({ ...result, errors }, { fits: true, chart: true, errors: [] });
  });
});
