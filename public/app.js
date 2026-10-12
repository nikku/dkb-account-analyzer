import * as A from './analyzer.js';
const $ = id => document.getElementById(id);
const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const dateFormat = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const shortDate = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
const money = cents => euro.format(cents === 0 ? 0 : cents / 100);
const date = value => dateFormat.format(value);
const iso = value => new Date(value).toISOString().slice(0, 10);
const monthShort = new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const monthFormat = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
let data, series = [], months = [];
let chartStart, chartEnd, geometry, drag = null, importVersion = 0;
const hoverPanel = document.createElement('div');
hoverPanel.id = 'hover-panel';
hoverPanel.className = 'hover-panel';
hoverPanel.setAttribute('role', 'tooltip');
hoverPanel.hidden = true;
document.body.append(hoverPanel);
let hoverOwner = null;

function hideHover() {
  hoverOwner?.removeAttribute('aria-describedby');
  hoverOwner = null;
  hoverPanel.hidden = true;
}

function showHover(source, heading, rows, event) {
  if (hoverOwner !== source) hideHover();
  hoverOwner = source;
  source.setAttribute('aria-describedby', hoverPanel.id);
  const content = typeof rows === 'string' ? [node('div', rows)] : rows.map(([label, value, numeric = false]) => {
    const row = node('div', undefined, 'hover-row');
    row.append(node('span', label, 'hover-label'), node('span', value, numeric ? 'hover-value numeric' : 'hover-value'));
    return row;
  });
  hoverPanel.replaceChildren(...(heading ? [node('strong', heading)] : []), ...content);
  hoverPanel.hidden = false;
  const bounds = source.getBoundingClientRect();
  const left = event ? event.clientX + 12 : bounds.left;
  const top = event ? event.clientY + 16 : bounds.bottom + 8;
  hoverPanel.style.left = `${Math.max(8, Math.min(left, innerWidth - hoverPanel.offsetWidth - 8))}px`;
  hoverPanel.style.top = `${Math.max(8, Math.min(top, innerHeight - hoverPanel.offsetHeight - 8))}px`;
}

function bindHover(source, heading, rows) {
  let touchPending = false, touchWasOpen = false;
  source.dataset.hover = JSON.stringify({ heading, rows });
  source.tabIndex = 0;
  source.onpointerdown = event => {
    touchPending = event.pointerType === 'touch';
    touchWasOpen = hoverOwner === source && !hoverPanel.hidden;
    if (touchPending) event.stopPropagation();
  };
  source.onpointerenter = event => {
    if (event.pointerType !== 'touch') showHover(source, heading, rows);
  };
  source.onpointerleave = event => {
    if (!hoverPanel.contains(event.relatedTarget) && document.activeElement !== source && hoverOwner === source) hideHover();
  };
  source.onfocus = () => { if (!touchPending) showHover(source, heading, rows); };
  source.onblur = () => { if (hoverOwner === source) hideHover(); };
  source.onclick = event => {
    if (source.hidden) {
      touchPending = false;
      hideHover();
      return;
    }
    if (event.pointerType === 'touch') {
      event.stopPropagation();
      if (touchWasOpen) hideHover();
      else showHover(source, heading, rows);
    }
    touchPending = false;
  };
  source.onkeydown = event => {
    if (!['Enter', ' '].includes(event.key) || source.tagName === 'BUTTON') return;
    event.preventDefault();
    if (hoverOwner === source && !hoverPanel.hidden) hideHover();
    else showHover(source, heading, rows);
  };
}

hoverPanel.addEventListener('pointerleave', event => {
  if (!hoverOwner?.contains(event.relatedTarget) && document.activeElement !== hoverOwner) hideHover();
});
document.addEventListener('pointerdown', event => {
  if (hoverOwner && !hoverOwner.contains(event.target) && !hoverPanel.contains(event.target)) hideHover();
});
window.addEventListener('scroll', hideHover, true);
window.addEventListener('resize', hideHover);

bindHover(document.querySelector('.privacy'), null,
  'Account data is analyzed locally in the browser. Nothing is uploaded or sent to a server.');

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function signed(id, value, showPlus = false) {
  $(id).textContent = `${showPlus && value > 0 ? '+' : ''}${money(value)}`;
  $(id).classList.toggle('negative', value < 0);
  $(id).classList.toggle('positive', value > 0);
}

function showError(id, message) {
  $(id).textContent = message;
  $(id).hidden = !message;
}

async function importFile(file, demo = false) {
  const version = ++importVersion;
  showError('error', '');
  $('import-status').textContent = `Reading ${file.name}…`;
  $('import-status').hidden = false;
  try {
    const buffer = await file.arrayBuffer();
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      text = new TextDecoder('windows-1252').decode(buffer);
    }
    const parsed = A.parseExport(text);
    if (version !== importVersion) return;
    data = parsed;
    hideHover();
    series = A.balanceSeries(data);
    months = A.months(data);
    const [accountName, iban] = data.account.split(' · ');
    const accountCode = node('code', iban, 'iban-chip');
    bindHover(accountCode, 'Account', [['IBAN', iban]]);
    $('account').replaceChildren(`${accountName} · `, accountCode);
    $('export-range').textContent = `${date(data.start)} – ${date(data.balanceDate)}`;
    if ($('range-dialog').open) $('range-dialog').close();
    signed('current-balance', data.balance);
    bindHover($('current-balance'), 'Current balance', [['As of', date(data.balanceDate)], ['Balance', money(data.balance), true]]);
    $('demo-badge').hidden = !demo;
    $('drop-zone').hidden = true;
    $('replace-file').hidden = false;
    $('dashboard').hidden = false;
    $('import-status').textContent = '';
    $('import-status').hidden = true;
    setChartRange(series.length ? series[0].date : data.balanceDate, data.balanceDate);
    renderAnalysis();
  } catch (error) {
    if (version !== importVersion) return;
    $('import-status').textContent = '';
    $('import-status').hidden = true;
    showError('error', `Could not import ${file.name}: ${error.message}${data ? ' Previous analysis is unchanged.' : ''}`);
  }
}

const KINDS = { income: 'Income', extraIncome: 'Extra income', regular: 'Expenses', special: 'Extra expenses' };
const INCOME_KINDS = new Set(['income', 'extraIncome']);
const TREND_LINES = { income: 'Income', regular: 'Expenses', net: 'Net' };

function signedMoney(value) {
  return node('span', `${value > 0 ? '+' : ''}${money(value)}`, `balance-amount ${value < 0 ? 'negative' : value > 0 ? 'positive' : ''}`);
}

function changeBadge(current, previous, higherIsGood, title, rows) {
  if (previous === undefined) return [];
  const value = A.percentage(current, previous);
  const tone = current === previous ? 'muted' : (current > previous) === higherIsGood ? 'positive' : 'negative';
  const change = value === null ? (current === 0 ? '—' : 'N/A') : `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
  const badge = node('span', change, `change ${tone}`);
  bindHover(badge, title, [...rows, ['Difference', `${current - previous > 0 ? '+' : ''}${money(current - previous)}`, true]]);
  return [badge];
}

function percentageOf(value, total) {
  return total === 0 ? null : value / total * 100;
}

function periodLabel(period) {
  return `${date(period.start)} – ${date(period.end - A.DAY)}`;
}

function coverageLabel(period) {
  return period.complete ? 'Full 365 days' : `Partial; export starts ${date(data.start)}`;
}

function coverage(period) {
  if (data.start > period.start) return `from ${shortDate.format(data.start)}`;
  if (data.balanceDate < period.end - A.DAY) return `to ${shortDate.format(data.balanceDate)}`;
  return '';
}

function renderAnalysis() {
  renderInsights();
  renderTrend();
  $('monthly-rows').replaceChildren(...months.map((period, index) => {
    const current = A.summarize(data.transactions, period);
    const month = node('details', undefined, 'month');
    month.dataset.period = String(index);
    const summary = node('summary');
    const label = node('span', undefined, 'month-label');
    label.append(node('span', monthFormat.format(period.start), 'month-name'));
    if (!period.complete) label.append(node('span', coverage(period), 'badge pending'));
    summary.append(label, signedMoney(current.net));
    const breakdown = node('div', undefined, 'month-breakdown');
    for (const [key, name] of Object.entries(KINDS)) {
      const entries = current.entries[key];
      const row = node('details', undefined, 'balance-row');
      row.dataset.kind = key;
      const rowSummary = node('summary');
      rowSummary.append(node('span', name, 'balance-label'), signedMoney(INCOME_KINDS.has(key) ? current[key] : -current[key]));
      row.append(rowSummary, transactionDetails(entries));
      breakdown.append(row);
    }
    month.append(summary, breakdown);
    return month;
  }));
}

function windowLabel(point) {
  return point.start === point.end ? monthShort.format(point.start) : `${monthShort.format(point.start)} – ${monthShort.format(point.end)}`;
}

let trendPoints = [];

function renderInsights() {
  const result = A.trend(data);
  $('monthly-insights').replaceChildren();
  if (result) {
    const { current, previous } = result;
    const currentLabel = windowLabel(current);
    const previousLabel = previous && windowLabel(previous);
    $('monthly-insights').append(...['regular', 'income'].map(key => {
      const item = node('div', undefined, 'insight');
      item.dataset.kind = key;
      const value = node('div', undefined, 'insight-value');
      const rows = [
        ['Period', currentLabel],
        ['Calculation', `Average of ${result.window} full ${result.window === 1 ? 'month' : 'months'}; extras excluded`],
        ['Current average', money(current[key]), true]
      ];
      const comparisonRows = [...rows, ['Compared with', previousLabel], ['Previous average', previous && money(previous[key]), true]];
      if (previous && previous[key] === 0) comparisonRows.push(['Percentage', current[key] === 0 ? 'No change; both amounts are zero' : 'Unavailable; previous average is zero']);
      const title = key === 'income' ? 'Income' : 'Expenses';
      bindHover(value, title, rows);
      value.append(node('strong', money(current[key])));
      const heading = node('div', undefined, 'insight-heading');
      heading.append(node('span', title, 'muted small'), ...(previous ? changeBadge(current[key], previous[key], key === 'income', title, comparisonRows) : []));
      item.append(heading, value);
      return item;
    }));
  } else {
    $('monthly-insights').append(node('p', 'Monthly income and spending: no full month available.', 'muted small'));
  }
  const period = A.yearlyTotals(data)[0];
  $('extra-insights').replaceChildren(...['special', 'extraIncome'].map(key => {
    const item = node('div', undefined, 'insight');
    item.dataset.kind = key;
    item.dataset.year = String(period.year);
    const value = node('div', undefined, 'insight-value');
    const previous = period.previous;
    const previousLabel = previous && periodLabel(previous);
    const rows = [
      ['Period', periodLabel(period)],
      ['Calculation', 'Total over 365 days'],
      ['Coverage', coverageLabel(period)],
      ['Extras', `Non-recurring payments of ${money(15000)} or more`],
      ['Current total', money(period[key]), true]
    ];
    const comparisonRows = [...rows, ['Compared with', previousLabel], ['Previous total', previous && money(previous[key]), true]];
    if (previous && previous[key] === 0) comparisonRows.push(['Percentage', period[key] === 0 ? 'No change; both amounts are zero' : 'Unavailable; previous total is zero']);
    const title = key === 'extraIncome' ? 'Extra income' : 'Extra expenses';
    bindHover(value, title, rows);
    value.append(node('strong', money(period[key])));
    const heading = node('div', undefined, 'insight-heading');
    heading.append(node('span', title, 'muted small'), ...(previous ? changeBadge(period[key], previous[key], key === 'extraIncome', title, comparisonRows) : []));
    item.append(heading, value);
    return item;
  }));
  const costOfLiving = period.regular + period.special;
  const previousCostOfLiving = previous => previous.regular + previous.special;
  const baselineMargin = period.income - period.regular;
  const extrasBalance = period.extraIncome - period.special;
  const totalIncome = period.income + period.extraIncome;
  const totalMargin = baselineMargin + extrasBalance;
  const totalMarginPercentage = percentageOf(totalMargin, totalIncome);
  $('margin-insights').replaceChildren(marginSummary({
    baselineMargin,
    extrasBalance,
    totalMargin,
    totalMarginPercentage,
    period,
    costOfLiving,
    totalIncome
  }));
  $('yearly-insights').replaceChildren(
    yearlyInsight({
      kind: 'costOfLiving',
      title: 'Cost of living',
      value: costOfLiving,
      previous: period.previous && previousCostOfLiving(period.previous),
      higherIsGood: false,
      rows: [
        ['Period', periodLabel(period)],
        ['Calculation', 'Regular and extra expenses over 365 days'],
        ['Coverage', coverageLabel(period)],
        ['Regular expenses', money(period.regular), true],
        ['Extra expenses', money(period.special), true],
        ['Total cost of living', money(costOfLiving), true]
      ],
      previousLabel: period.previous && periodLabel(period.previous),
      previousValueLabel: 'Previous cost of living'
    })
  );
}

function marginSummary({ baselineMargin, extrasBalance, totalMargin, totalMarginPercentage, period, costOfLiving, totalIncome }) {
  const totalMonthly = Math.round(totalMargin / 12);
  const totalRows = [
    ['Period', periodLabel(period)],
    ['Calculation', '(All income − all expenses) ÷ 12'],
    ['Coverage', coverageLabel(period)],
    ['Annual baseline margin', money(baselineMargin), true],
    ['Annual extras balance', money(extrasBalance), true],
    ['Annual total income margin', money(totalMargin), true],
    ['Monthly total income margin', money(totalMonthly), true],
    ['Total income margin', totalMarginPercentage === null ? 'Unavailable; total income is zero' : `${totalMarginPercentage > 0 ? '+' : ''}${totalMarginPercentage.toFixed(1)}%`]
  ];
  const summary = node('div', undefined, 'margin-summary');
  summary.dataset.kind = 'totalIncomeMargin';
  const primary = node('div', undefined, 'margin-primary');
  bindHover(primary, 'Total income margin', totalRows);
  const heading = node('div', undefined, 'insight-heading');
  const rate = node('span', totalMarginPercentage === null ? 'N/A' : `${totalMarginPercentage > 0 ? '+' : ''}${totalMarginPercentage.toFixed(1)}% of income`, `margin-rate ${totalMargin < 0 ? 'negative' : totalMargin > 0 ? 'positive' : 'muted'}`);
  bindHover(rate, 'Total income margin', totalRows);
  heading.append(node('span', 'Total income margin', 'muted small'), rate);
  primary.append(heading, node('strong', money(totalMonthly)), node('span', '/ month', 'insight-unit'));
  const breakdown = node('div', undefined, 'margin-breakdown');
  for (const [index, [label, value, rows]] of [
    ['Baseline margin', baselineMargin, [
      ['Period', periodLabel(period)], ['Calculation', '(Recurring income − regular expenses) ÷ 12'], ['Coverage', coverageLabel(period)],
      ['Recurring income', money(period.income), true], ['Regular expenses', money(period.regular), true],
      ['Annual baseline margin', money(baselineMargin), true], ['Monthly baseline margin', money(Math.round(baselineMargin / 12)), true]
    ]],
    ['Extras balance', extrasBalance, [
      ['Period', periodLabel(period)], ['Calculation', '(Extra income − extra expenses) ÷ 12'], ['Coverage', coverageLabel(period)],
      ['Extra income', money(period.extraIncome), true], ['Extra expenses', money(period.special), true],
      ['Annual extras balance', money(extrasBalance), true], ['Monthly extras balance', money(Math.round(extrasBalance / 12)), true]
    ]],
    ['Total', totalMargin, totalRows]
  ].entries()) {
    const component = node('div', undefined, 'margin-component');
    bindHover(component, label, rows);
    const operator = index === 1 ? '+ ' : index === 2 ? '= ' : '';
    component.append(node('span', `${operator}${label}`), node('strong', money(Math.round(value / 12)), value < 0 ? 'negative' : value > 0 ? 'positive' : ''));
    breakdown.append(component);
  }
  summary.append(primary, breakdown);
  return summary;
}

function yearlyInsight({ kind, title, value, previous, higherIsGood, rows, previousLabel, previousValueLabel }) {
  const item = node('div', undefined, 'insight');
  item.dataset.kind = kind;
  const amount = node('div', undefined, 'insight-value');
  bindHover(amount, title, rows);
  amount.append(node('strong', money(value)));
  const heading = node('div', undefined, 'insight-heading');
  heading.append(node('span', title, 'muted small'));
  if (previous != null) {
    const comparisonRows = [...rows, ['Compared with', previousLabel], [previousValueLabel, money(previous), true]];
    if (previous === 0) comparisonRows.push(['Percentage', value === 0 ? 'No change; both amounts are zero' : 'Unavailable; previous total is zero']);
    heading.append(...changeBadge(value, previous, higherIsGood, title, comparisonRows));
  }
  item.append(heading, amount);
  return item;
}

function renderTrend() {
  const result = A.trend(data);
  trendPoints = result ? result.points : [];
  $('trend').hidden = trendPoints.length < 2;
  if (!result) {
    $('trend-summary').replaceChildren();
    hideHover();
    return;
  }
  $('trend-basis').textContent = `Rolling ${result.window}-month average`;
  $('trend-summary').replaceChildren(...Object.entries(TREND_LINES).map(([key, name]) => {
    const item = node('div', undefined, `trend-item trend-${key}`);
    item.dataset.key = key;
    item.append(node('span', name, 'trend-name'));
    if (trendPoints.length > 1) {
      const axis = node('div', undefined, 'trend-axis muted');
      axis.append(node('span', monthShort.format(trendPoints[0].end)), node('span', monthShort.format(trendPoints.at(-1).end)));
      item.append(svgNode('svg', { class: 'trend-spark', role: 'img', tabindex: 0 }), axis);
    }
    return item;
  }));
  renderSparklines();
}

// Each line gets its own scale so changes stay visible. A shared minimum span (relative to income and
// expenses) keeps small wiggles small, including on the comparatively small net line.
function renderSparklines() {
  hideHover();
  const minimumSpan = Math.max(2000, ...trendPoints.flatMap(point => [point.income, point.regular])) * .2;
  for (const svg of document.querySelectorAll('.trend-spark')) {
    const key = svg.parentElement.dataset.key;
    const values = trendPoints.map(point => point[key]);
    const width = Math.max(120, svg.parentElement.clientWidth), height = 56, inset = 4;
    const low = Math.min(...values), high = Math.max(...values);
    const span = Math.max(high - low, minimumSpan) * 1.15;
    const min = (low + high) / 2 - span / 2;
    const x = index => inset + index / (values.length - 1) * (width - 2 * inset);
    const y = value => height - inset - (value - min) / span * (height - 2 * inset);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('aria-label', `${TREND_LINES[key]}, rolling average from ${money(values[0])} to ${money(values.at(-1))}`);
    const children = [svgNode('path', { d: values.map((value, index) => `${index ? 'L' : 'M'} ${x(index)} ${y(value)}`).join(' '), class: `trend-line trend-${key}` })];
    if (min < 0 && min + span > 0) children.unshift(svgNode('line', { x1: 0, x2: width, y1: y(0), y2: y(0), class: 'chart-zero' }));
    children.push(svgNode('circle', { cx: x(values.length - 1), cy: y(values.at(-1)), r: 3, class: `trend-dot trend-${key}` }), svgNode('line', { y1: 0, y2: height, class: 'trend-guide', visibility: 'hidden' }));
    svg.replaceChildren(...children);
    const showAtPointer = event => {
      const index = Math.round(Math.max(0, Math.min(1, (event.clientX - svg.getBoundingClientRect().left) / svg.getBoundingClientRect().width)) * (values.length - 1));
      svg.dataset.index = String(index);
      showTrendPoint(index, svg, event);
    };
    svg.onpointermove = event => { if (event.pointerType !== 'touch') showAtPointer(event); };
    svg.onclick = showAtPointer;
    svg.onpointerleave = event => { if (!hoverPanel.contains(event.relatedTarget) && document.activeElement !== svg) hideTrendPoint(); };
    svg.onfocus = () => {
      svg.dataset.index = String(values.length - 1);
      showTrendPoint(values.length - 1, svg);
    };
    svg.onblur = hideTrendPoint;
    svg.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const index = Math.max(0, Math.min(values.length - 1, Number(svg.dataset.index ?? values.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1)));
      svg.dataset.index = String(index);
      showTrendPoint(index, svg);
    };
  }
}

function showTrendPoint(index, source, event) {
  for (const svg of document.querySelectorAll('.trend-spark')) {
    const width = svg.viewBox.baseVal.width, position = 4 + index / (trendPoints.length - 1) * (width - 8);
    const guide = svg.querySelector('.trend-guide');
    guide.setAttribute('x1', position);
    guide.setAttribute('x2', position);
    guide.setAttribute('visibility', 'visible');
  }
  const point = trendPoints[index];
  showHover(source, `Ø ${windowLabel(point)}`, Object.entries(TREND_LINES).map(([key, name]) => [name, money(point[key]), true]), event);
}

function hideTrendPoint() {
  for (const guide of document.querySelectorAll('.trend-guide')) guide.setAttribute('visibility', 'hidden');
  hideHover();
}

function transactionDetails(transactions) {
  const container = node('div', undefined, 'sheet-transactions');
  if (!transactions.length) {
    container.append(node('p', 'No transactions.', 'muted small'));
    return container;
  }
  const table = node('table', undefined, 'transaction-table');
  const body = node('tbody');
  body.append(...transactions.slice().sort((a, b) => b.date - a.date || a.id - b.id).map(transactionRow));
  table.append(body); container.append(table);
  return container;
}

function transactionRow(transaction) {
  const row = node('tr'), details = node('td');
  details.append(node('div', transaction.counterparty || 'Unknown counterparty'));
  if (transaction.description) details.append(node('p', transaction.description, 'description'));
  if (transaction.recurring) {
    const flag = node('span', 'Recurring', 'badge');
    bindHover(flag, null, `${transaction.recurringReason}.`);
    details.append(flag);
  }
  row.append(node('td', shortDate.format(transaction.date)), details, node('td', money(transaction.amount), transaction.amount < 0 ? 'negative' : 'positive'));
  return row;
}

function svgNode(tag, attrs = {}, text) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
}

function setChartRange(start, end) {
  const first = series.length ? series[0].date : data.balanceDate;
  chartStart = Math.max(first, Math.min(start, data.balanceDate));
  chartEnd = Math.max(chartStart, Math.min(end, data.balanceDate));
  const full = chartStart === first && chartEnd === data.balanceDate;
  $('range-button').textContent = `${date(chartStart)} – ${date(chartEnd)}`;
  $('range-button').classList.toggle('active', !full);
  $('clear-range').hidden = full;
  hideHover();
  renderChart();
}

function renderChart() {
  if (!data || $('dashboard').hidden) return;
  const svg = $('balance-chart');
  const width = Math.max(280, $('chart-wrap').clientWidth), height = 320;
  const left = width < 500 ? 66 : 80, right = width - 18, top = 25, bottom = height - 40;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const visible = series.filter(point => point.date >= chartStart && point.date <= chartEnd);
  svg.replaceChildren();
  svg.setAttribute('aria-label', `Booked account balance, ${date(chartStart)} to ${date(chartEnd)}`);
  if (!visible.length) {
    svg.append(svgNode('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle' }, 'No booked transactions to reconstruct.'));
    $('chart-hint').textContent = 'Pending transactions do not establish historical account balances.';
    geometry = null;
    return;
  }
  let min = Infinity, max = -Infinity;
  for (const point of visible) {
    min = Math.min(min, point.opening, point.balance);
    max = Math.max(max, point.opening, point.balance);
  }
  const padding = Math.max(1000, (max - min) * .15);
  min -= padding; max += padding;
  const xStart = chartStart, xEnd = chartEnd === chartStart ? chartEnd + A.DAY : chartEnd;
  const x = value => left + (value - xStart) / (xEnd - xStart) * (right - left);
  const y = value => bottom - (value - min) / (max - min) * (bottom - top);
  geometry = { left, right, top, bottom, xStart, xEnd, width, x, y };
  for (let i = 0; i <= 4; i++) {
    const value = min + (max - min) * i / 4;
    svg.append(svgNode('line', { x1: left, x2: right, y1: y(value), y2: y(value), class: 'chart-grid' }));
    svg.append(svgNode('text', { x: left - 10, y: y(value) + 4, 'text-anchor': 'end' }, euro.format(Math.round(value / 100))));
  }
  if (min < 0 && max > 0) svg.append(svgNode('line', { x1: left, x2: right, y1: y(0), y2: y(0), class: 'chart-zero' }));
  const ticks = Math.min(width < 500 ? 2 : 5, Math.max(1, (chartEnd - chartStart) / A.DAY));
  const used = new Set();
  for (let i = 0; i <= ticks; i++) {
    const value = chartStart + Math.round((chartEnd - chartStart) / A.DAY * i / ticks) * A.DAY;
    if (used.has(value)) continue;
    used.add(value);
    svg.append(svgNode('text', { x: x(value), y: height - 12, 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle' }, shortDate.format(value)));
  }
  let path = `M ${left} ${y(visible[0].opening)}`;
  for (const point of visible) path += ` H ${x(point.date)} V ${y(point.balance)}`;
  path += ` H ${right}`;
  svg.append(svgNode('path', { d: `${path} V ${bottom} H ${left} Z`, class: 'chart-area' }));
  svg.append(svgNode('path', { d: path, class: 'chart-line' }));
  const detail = (chartEnd - chartStart) / A.DAY <= 45;
  if (detail) {
    for (const point of visible.filter(point => point.transactions.length)) {
      const marker = svgNode('circle', { cx: x(point.date), cy: y(point.balance), r: 5, class: 'chart-marker', tabindex: 0, 'aria-label': `${date(point.date)}: closing balance ${money(point.balance)}, ${point.transactions.length} transactions` });
      marker.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') showTooltip(point, detail, marker); });
      marker.addEventListener('pointerleave', event => { if (!hoverPanel.contains(event.relatedTarget) && document.activeElement !== marker) hideHover(); });
      marker.addEventListener('focus', () => showTooltip(point, detail, marker));
      marker.addEventListener('blur', hideHover);
      marker.addEventListener('click', () => showTooltip(point, detail, marker));
      marker.addEventListener('pointerdown', event => event.stopPropagation());
      svg.append(marker);
    }
  }
  $('chart-hint').textContent = detail ? 'Hover dots for transactions · Drag to zoom' : 'Drag to zoom and reveal transactions';
}

function showTooltip(point, detail, source = $('balance-chart'), event) {
  const rows = [['Closing balance', money(point.balance), true], ['Daily opening', money(point.opening), true]];
  if (detail) {
    for (const transaction of point.transactions) {
      rows.push([`${transaction.counterparty || 'Unknown counterparty'}${transaction.description ? ` — ${transaction.description}` : ''}`, money(transaction.amount), true]);
    }
  }
  showHover(source, date(point.date), rows, event);
}

function zoom(factor, anchor) {
  if (!series.length) return;
  const days = Math.max(1, Math.round(((chartEnd - chartStart) / A.DAY + 1) * factor));
  const first = series[0].date, last = data.balanceDate;
  // keep the anchor date at the same relative chart position
  const ratio = chartEnd > chartStart ? (anchor - chartStart) / (chartEnd - chartStart) : .5;
  let start = Math.round((anchor - ratio * (days - 1) * A.DAY) / A.DAY) * A.DAY;
  let end = start + (days - 1) * A.DAY;
  if (start < first) { end += first - start; start = first; }
  if (end > last) { start -= end - last; end = last; }
  setChartRange(start, end);
}

function pointerDate(event) {
  const bounds = $('balance-chart').getBoundingClientRect();
  const position = (event.clientX - bounds.left) * geometry.width / bounds.width;
  return Math.round((geometry.xStart + (Math.max(geometry.left, Math.min(position, geometry.right)) - geometry.left) / (geometry.right - geometry.left) * (geometry.xEnd - geometry.xStart)) / A.DAY) * A.DAY;
}

for (const id of ['file-input', 'replacement-input']) $(id).addEventListener('change', event => {
  const file = event.target.files[0];
  if (file) importFile(file);
  event.target.value = '';
});
let dragDepth = 0;
for (const type of ['dragenter', 'dragover']) document.addEventListener(type, event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  if (type === 'dragenter') dragDepth++;
  document.body.classList.add('file-dragging');
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('file-dragging');
});
document.addEventListener('drop', event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault(); dragDepth = 0; document.body.classList.remove('file-dragging');
  const files = event.dataTransfer.files;
  if (files.length !== 1) {
    showError('error', 'Drop exactly one DKB CSV export at a time. Files are not merged.');
    return;
  }
  importFile(files[0]);
});
$('clear-range').addEventListener('click', () => setChartRange(series.length ? series[0].date : data.balanceDate, data.balanceDate));
$('range-button').addEventListener('click', () => {
  hideTrendPoint();
  const first = series.length ? series[0].date : data.balanceDate;
  for (const id of ['chart-from', 'chart-to']) {
    $(id).min = iso(first); $(id).max = iso(data.balanceDate);
  }
  $('chart-from').value = iso(chartStart); $('chart-to').value = iso(chartEnd);
  showError('chart-error', '');
  $('range-dialog').showModal();
});
$('range-cancel').addEventListener('click', () => $('range-dialog').close());
$('range-form').addEventListener('submit', event => {
  const start = Date.parse($('chart-from').value), end = Date.parse($('chart-to').value);
  const first = series.length ? series[0].date : data.balanceDate;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < first || end > data.balanceDate) {
    event.preventDefault();
    showError('chart-error', 'Choose valid dates within the available balance range, with From on or before To.');
    return;
  }
  setChartRange(start, end);
});
$('balance-chart').addEventListener('wheel', event => {
  if (!geometry) return;
  event.preventDefault();
  zoom(event.deltaY < 0 ? .75 : 1.5, pointerDate(event));
}, { passive: false });
$('balance-chart').addEventListener('pointerdown', event => {
  if (!geometry || event.button !== 0 || event.pointerType === 'touch') return;
  const selection = svgNode('rect', { x: 0, y: geometry.top, width: 0, height: geometry.bottom - geometry.top, class: 'chart-selection' });
  drag = { start: pointerDate(event), selection };
  hideHover();
  $('balance-chart').append(selection);
  $('balance-chart').setPointerCapture(event.pointerId);
});
$('balance-chart').addEventListener('pointermove', event => {
  if (!geometry) return;
  if (drag) {
    const end = pointerDate(event);
    drag.selection.setAttribute('x', geometry.x(Math.min(end, drag.start)));
    drag.selection.setAttribute('width', Math.abs(geometry.x(end) - geometry.x(drag.start)));
  } else if (event.target.tagName !== 'circle') {
    const target = pointerDate(event);
    const point = series.find(point => point.date === target);
    if (point && target >= chartStart && target <= chartEnd && event.pointerType !== 'touch') showTooltip(point, (chartEnd - chartStart) / A.DAY <= 45, $('balance-chart'), event);
  }
});
$('balance-chart').addEventListener('pointerup', event => {
  if (!drag) return;
  const start = drag.start, end = pointerDate(event);
  drag.selection.remove(); drag = null;
  if ($('balance-chart').hasPointerCapture(event.pointerId)) $('balance-chart').releasePointerCapture(event.pointerId);
  if (start !== end) setChartRange(Math.min(start, end), Math.max(start, end));
});
$('balance-chart').addEventListener('pointercancel', () => { if (drag) { drag.selection.remove(); drag = null; } });
$('balance-chart').addEventListener('pointerleave', event => { if (!hoverPanel.contains(event.relatedTarget) && !drag && document.activeElement !== $('balance-chart') && !document.activeElement?.classList.contains('chart-marker')) hideHover(); });
let balanceFocusDate;
$('balance-chart').addEventListener('focus', () => {
  balanceFocusDate = chartEnd;
  const point = series.find(point => point.date === balanceFocusDate);
  if (point) showTooltip(point, (chartEnd - chartStart) / A.DAY <= 45);
});
$('balance-chart').addEventListener('blur', hideHover);
$('balance-chart').addEventListener('keydown', event => {
  if (event.target !== $('balance-chart') || !geometry || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  balanceFocusDate = Math.max(chartStart, Math.min(chartEnd, (balanceFocusDate ?? chartEnd) + (event.key === 'ArrowLeft' ? -A.DAY : A.DAY)));
  showTooltip(series.find(point => point.date === balanceFocusDate), (chartEnd - chartStart) / A.DAY <= 45);
});
$('balance-chart').addEventListener('click', event => {
  if (event.pointerType !== 'touch' || event.target.tagName === 'circle' || !geometry) return;
  const point = series.find(point => point.date === pointerDate(event));
  if (point) showTooltip(point, (chartEnd - chartStart) / A.DAY <= 45, $('balance-chart'), event);
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') { hideTrendPoint(); if (drag) { drag.selection.remove(); drag = null; } } });
bindHover($('clear-range'), 'Date range', [['Action', 'Show full range']]);
new ResizeObserver(() => { if (data) { hideHover(); renderChart(); } }).observe($('chart-wrap'));
new ResizeObserver(() => { if (data) renderSparklines(); }).observe($('trend-summary'));

if (new URLSearchParams(location.search).get('demo') === '1') {
  fetch('demo.csv')
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.blob();
    })
    .then(blob => importFile(new File([blob], 'demo.csv', { type: 'text/csv' }), true))
    .catch(error => showError('error', `Could not load demo data: ${error.message}`));
}
