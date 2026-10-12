const DAY = 86400000;
const EXTRA_THRESHOLD = 15000;
const TREND_WINDOW = 3;

function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false, closed = false, line = 1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else {
        if (char === '\n') line++;
        field += char;
      }
    } else if (char === ';') {
      row.push(field); field = ''; closed = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      line++;
      row.push(field);
      if (row.some(value => value.trim())) rows.push(row);
      row = []; field = ''; closed = false;
    } else if (char === '"' && field === '' && !closed) {
      quoted = true;
    } else {
      if (closed || char === '"') throw new Error(`Invalid CSV quoting in line ${line}. Please use an unchanged DKB CSV export.`);
      field += char;
    }
  }
  if (quoted) throw new Error('The CSV contains an unclosed quoted field.');
  row.push(field);
  if (row.some(value => value.trim())) rows.push(row);
  return rows;
}

function parseMoney(value) {
  const cleaned = value.replace(/[\s\u00A0\u202F€]/g, '');
  if (!/^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(cleaned)) {
    throw new Error(`Invalid EUR amount: "${value}".`);
  }
  const [whole, decimals = ''] = cleaned.replace(/\./g, '').replace(/^[+-]/, '').split(',');
  const cents = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error('An amount exceeds the supported range.');
  return cleaned.startsWith('-') ? -cents : cents;
}

function parseDate(value) {
  const match = /^(\d{2})\.(\d{2})\.(\d{2}|\d{4})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid booking date: "${value}".`);
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const month = Number(match[2]) - 1, day = Number(match[1]);
  const date = Date.UTC(year, month, day);
  const check = new Date(date);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) {
    throw new Error(`Invalid booking date: "${value}".`);
  }
  return date;
}

function detectRecurring(transactions) {
  const groups = new Map();
  for (const transaction of transactions.filter(t => !t.pending)) {
    const counterparty = transaction.counterparty.trim().toLocaleLowerCase();
    if (!counterparty) continue;
    const key = `${transaction.amount < 0 ? '-' : '+'}${counterparty}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(transaction);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.date - b.date);
    if (group[0].amount < 0) {
      const similar = (a, b) => Math.abs(a.amount - b.amount) / Math.max(Math.min(Math.abs(a.amount), Math.abs(b.amount)), 1) <= 0.15;
      const unambiguous = entry => group.filter(other => monthStart(other.date) === monthStart(entry.date) && similar(entry, other)).length === 1;
      for (const first of group) {
        if (!unambiguous(first)) continue;
        const second = group.find(entry => monthStart(entry.date) === monthStart(first.date, 1) &&
          (entry.date - first.date) / DAY >= 25 && (entry.date - first.date) / DAY <= 35 && similar(first, entry));
        if (!second || !unambiguous(second)) continue;
        const third = group.find(entry => monthStart(entry.date) === monthStart(second.date, 1) &&
          (entry.date - second.date) / DAY >= 25 && (entry.date - second.date) / DAY <= 35 &&
          similar(first, entry) && similar(second, entry));
        if (!third || !unambiguous(third)) continue;
        for (const entry of [first, second, third]) {
          entry.recurring = true;
          entry.recurringReason = 'Similar recipient amounts in three consecutive months, 25–35 days apart (within 15%), without competing same-month payments';
        }
      }
      continue;
    }
    for (const [i, current] of group.entries()) for (const previous of group.slice(0, i)) {
      const similar = Math.abs(current.amount - previous.amount) / Math.max(Math.abs(previous.amount), 1) <= 0.15;
      const adjacentMonth = monthStart(current.date) === monthStart(previous.date, 1);
      if (adjacentMonth && similar) {
        for (const transaction of [previous, current]) {
          transaction.recurringReason = 'Same sender with similar amounts in adjacent calendar months (within 15%)';
          transaction.recurring = true;
        }
      }
    }
  }
}

function parseExport(text) {
  const rows = parseCSV(text);
  const headerIndex = rows.findIndex(row => row.includes('Buchungsdatum') && row.includes('Betrag (€)'));
  if (headerIndex < 0) throw new Error('DKB transaction headers were not found. Expected Buchungsdatum and Betrag (€).');
  const headers = rows[headerIndex];
  const required = ['Buchungsdatum', 'Status', 'Zahlungspflichtige*r', 'Zahlungsempfänger*in', 'Verwendungszweck', 'Betrag (€)'];
  for (const name of required) {
    if (!headers.includes(name)) throw new Error(`Missing DKB column: ${name}.`);
  }
  if (new Set(headers).size !== headers.length) throw new Error('The CSV contains duplicate column headers.');
  const metadata = rows.slice(0, headerIndex);
  const accountRow = metadata.find(row => /konto/i.test(row[0]) && !/kontostand/i.test(row[0]));
  const balanceRow = metadata.find(row => /^Kontostand vom \d{2}\.\d{2}\.\d{4}:?$/.test(row[0].trim()));
  if (!accountRow || !accountRow[1]) throw new Error('Account information is missing from the export.');
  if (!balanceRow || !balanceRow[1]) throw new Error('The dated account balance is missing; historical balances cannot be reconstructed.');
  const balanceDate = parseDate(balanceRow[0].match(/\d{2}\.\d{2}\.\d{4}/)[0]);
  const balance = parseMoney(balanceRow[1]);
  const transactions = rows.slice(headerIndex + 1).map((row, index) => {
    if (row.length !== headers.length) throw new Error(`Transaction ${index + 1} has ${row.length} columns; expected ${headers.length}.`);
    const get = name => row[headers.indexOf(name)].trim();
    const amount = parseMoney(get('Betrag (€)'));
    const date = parseDate(get('Buchungsdatum'));
    const status = get('Status');
    if (!status) throw new Error(`Transaction ${index + 1} has no booking status.`);
    const pending = status.toLocaleLowerCase() !== 'gebucht';
    if (!pending && date > balanceDate) throw new Error(`Transaction ${index + 1} is booked after the reported balance date. The balance anchor is inconsistent.`);
    const transaction = {
      id: index, date, amount, status, pending,
      counterparty: get(amount < 0 ? 'Zahlungsempfänger*in' : 'Zahlungspflichtige*r'),
      description: get('Verwendungszweck')
    };
    return { ...transaction, recurring: false, recurringReason: '' };
  });
  if (!transactions.length) throw new Error('The export does not contain any transactions.');
  detectRecurring(transactions);
  transactions.sort((a, b) => a.date - b.date || b.id - a.id);
  return {
    account: `${accountRow[0]} · ${accountRow[1]}`, balanceDate, balance, transactions,
    start: transactions[0].date,
    end: transactions[transactions.length - 1].date
  };
}

// One-off amounts in either direction: non-recurring and at least €150.
function isExtra(transaction) {
  return Math.abs(transaction.amount) >= EXTRA_THRESHOLD && !transaction.recurring;
}

function balanceSeries(data) {
  const booked = data.transactions.filter(t => !t.pending);
  if (!booked.length) return [];
  const start = booked[0].date;
  const daily = new Map();
  for (const transaction of booked) {
    if (!daily.has(transaction.date)) daily.set(transaction.date, []);
    daily.get(transaction.date).push(transaction);
  }
  let balance = data.balance - booked.reduce((sum, t) => sum + t.amount, 0);
  const points = [];
  for (let date = start; date <= data.balanceDate; date += DAY) {
    const transactions = daily.get(date) || [];
    const opening = balance;
    balance += transactions.reduce((sum, t) => sum + t.amount, 0);
    points.push({ date, opening, balance, transactions });
  }
  return points;
}

function monthStart(value, offset = 0) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1);
}

// Calendar months from the balance date's month back to the oldest transaction's month, newest first.
function months(data) {
  const result = [];
  const oldest = monthStart(Math.min(data.start, data.balanceDate));
  for (let start = monthStart(data.balanceDate); start >= oldest; start = monthStart(start, -1)) {
    const end = monthStart(start, 1);
    result.push({ start, end, complete: data.start <= start && data.balanceDate >= end - DAY });
  }
  return result;
}

function summarize(transactions, period) {
  const result = { income: 0, extraIncome: 0, regular: 0, special: 0, net: 0, entries: { income: [], extraIncome: [], regular: [], special: [] } };
  for (const transaction of transactions) {
    if (transaction.pending || transaction.date < period.start || transaction.date >= period.end) continue;
    result.net += transaction.amount;
    const kind = transaction.amount >= 0 ? (isExtra(transaction) ? 'extraIncome' : 'income') : (isExtra(transaction) ? 'special' : 'regular');
    result[kind] += Math.abs(transaction.amount);
    result.entries[kind].push(transaction);
  }
  return result;
}

function percentage(current, previous) {
  return previous === 0 ? null : (current - previous) / Math.abs(previous) * 100;
}

// Rolling averages of standard income and expenses (plus extra totals) over full months, oldest first.
// The latest window is compared with the same window a year earlier when the export allows it,
// otherwise with the directly preceding window.
function trend(data) {
  const full = months(data).filter(period => period.complete).reverse();
  const window = Math.min(TREND_WINDOW, full.length);
  if (!window) return null;
  const totals = full.map(period => summarize(data.transactions, period));
  const points = [];
  for (let end = window; end <= full.length; end++) {
    const slice = totals.slice(end - window, end);
    const income = Math.round(slice.reduce((sum, total) => sum + total.income, 0) / window);
    const regular = Math.round(slice.reduce((sum, total) => sum + total.regular, 0) / window);
    const extraIncome = slice.reduce((sum, total) => sum + total.extraIncome, 0);
    const special = slice.reduce((sum, total) => sum + total.special, 0);
    points.push({ start: full[end - window].start, end: full[end - 1].start, income, regular, net: income - regular, extraIncome, special });
  }
  const current = points.at(-1);
  let basis = null, previous = null;
  if (points.length > 12) {
    basis = 'year';
    previous = points.at(-13);
  } else if (window === TREND_WINDOW && points.length > window) {
    basis = 'previous';
    previous = points.at(-1 - window);
  }
  return { window, points, current, previous, basis };
}

function yearlyTotals(data) {
  const end = data.balanceDate + DAY;
  const start = end - 365 * DAY;
  const previousStart = start - 365 * DAY;
  const current = summarize(data.transactions, { start, end });
  const previous = data.start <= previousStart ? summarize(data.transactions, { start: previousStart, end: start }) : null;
  return [{
    year: new Date(data.balanceDate).getUTCFullYear(), start, end, complete: data.start <= start,
    income: current.income, extraIncome: current.extraIncome, regular: current.regular, special: current.special,
    previous: previous && {
      start: previousStart, end: start,
      income: previous.income, extraIncome: previous.extraIncome, regular: previous.regular, special: previous.special
    }
  }];
}

const yearlyExtras = yearlyTotals;

export { DAY, parseCSV, parseMoney, parseDate, parseExport, isExtra, balanceSeries, months, summarize, percentage, trend, yearlyExtras, yearlyTotals };
