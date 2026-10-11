import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as A from '../public/analyzer.js';

const headers = '"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)"';
function csv(rows, balanceDate = '10.10.2026', balance = '1.000,00') {
  return `\uFEFF"Girokonto";"DE-test"\r\n\r\n"Kontostand vom ${balanceDate}:";"${balance} €"\r\n""\r\n${headers}\r\n${rows.join('\r\n')}`;
}
function transaction(date, amount, counterparty = 'Shop', status = 'Gebucht', description = '') {
  return `"${date}";"${date}";"${status}";"Employer";"${counterparty}";"${description}";"";"";"${amount}"`;
}

describe('DKB CSV parsing', () => {
  it('exports analyzer functions without creating a global', () => {
    // given
    const module = A;
    // when
    const result = { parseExport: typeof module.parseExport, global: Object.hasOwn(globalThis, 'AccountAnalyzer') };
    // then
    assert.deepEqual(result, { parseExport: 'function', global: false });
  });

  it('reads demo export metadata and German currency from a transaction subset', () => {
    // given
    const text = fs.readFileSync(new URL('../public/demo.csv', import.meta.url), 'utf8').split('\n').slice(0, 9).join('\n');
    // when
    const result = A.parseExport(text);
    // then
    assert.deepEqual({
      account: result.account, balance: result.balance, date: result.balanceDate,
      amounts: result.transactions.map(entry => entry.amount)
    }, {
      account: 'Girokonto · DE00XXXX00000000000000', balance: 1248020, date: A.parseDate('31.10.2026'),
      amounts: [-8943, -10442, -4080, -9369]
    });
  });

  it('reads the bundled demo export', () => {
    // given
    const text = fs.readFileSync(new URL('../public/demo.csv', import.meta.url), 'utf8');
    // when
    const result = A.parseExport(text);
    // then
    assert.equal(result.transactions.length, 336);
  });

  it('reports the line of invalid quoting, counting quoted newlines', () => {
    // given
    const text = 'a;b\r\n"multi\nline";"ok"\r\n"closed"oops';
    // when
    const action = () => A.parseCSV(text);
    // then
    assert.throws(action, /Invalid CSV quoting in line 4\./);
  });

  it('handles quoted separators, escaped quotes, newlines, BOM and CRLF', () => {
    // given
    const text = csv([transaction('01.10.26', '-10,10', 'Shop; ""West""', 'Gebucht', 'First line\nSecond line')]);
    // when
    const result = A.parseExport(text).transactions[0];
    // then
    assert.deepEqual({ name: result.counterparty, description: result.description, amount: result.amount }, { name: 'Shop; "West"', description: 'First line\nSecond line', amount: -1010 });
  });

  for (const [value, expected] of [['-1.526,39', -152639], ['3.000,54\u00A0€', 300054], ['-16,5', -1650], ['+10', 1000], ['0,01', 1]]) {
    it(`parses ${value} as exact integer cents`, () => {
      // given
      const input = value;
      // when
      const result = A.parseMoney(input);
      // then
      assert.equal(result, expected);
    });
  }

  for (const value of ['12.34', 'abc', '10,123', '', '1,2,3']) {
    it(`rejects invalid currency ${JSON.stringify(value)}`, () => {
      // given
      const input = value;
      // when
      const action = () => A.parseMoney(input);
      // then
      assert.throws(action, /Invalid EUR amount/);
    });
  }

  for (const value of ['31.02.26', '00.10.26', '10.13.2026', '2026-10-10']) {
    it(`rejects invalid booking date ${value}`, () => {
      // given
      const input = value;
      // when
      const action = () => A.parseDate(input);
      // then
      assert.throws(action, /Invalid booking date/);
    });
  }

  for (const [text, message] of [
    ['hello', /headers/],
    [csv([]), /does not contain/],
    [csv([transaction('01.10.26', '-10')]).replace('"1.000,00 €"', '""'), /balance is missing/],
    [csv([transaction('01.10.26', '-10')]).replace('"DE-test"', '""'), /Account information/],
    [csv([transaction('01.10.26', '-10')]).replace(';"IBAN"', ''), /columns/],
    [csv([transaction('01.10.26', '-10')]).replace('"Status"', '"State"'), /Missing DKB column/],
    [csv([transaction('11.10.26', '-10')]), /after the reported balance/],
    [csv([transaction('01.10.26', '-10', 'Shop', '')]), /no booking status/],
    ['"unfinished', /unclosed/],
    ['"closed"oops', /quoting/]
  ]) {
    it(`rejects malformed or inconsistent export: ${message}`, () => {
      // given
      const input = text;
      // when
      const action = () => A.parseExport(input);
      // then
      assert.throws(action, message);
    });
  }

  it('reads reordered columns by header name', () => {
    // given
    const text = '"Girokonto";"DE-test"\n"Kontostand vom 10.10.2026:";"10"\n"Betrag (€)";"Status";"Verwendungszweck";"Zahlungsempfänger*in";"Buchungsdatum";"Zahlungspflichtige*r"\n"-1";"Gebucht";"Test";"Shop";"10.10.26";"Me"';
    // when
    const result = A.parseExport(text).transactions[0];
    // then
    assert.deepEqual({ amount: result.amount, name: result.counterparty }, { amount: -100, name: 'Shop' });
  });
});

describe('Balance reconstruction', () => {
  it('reconstructs daily closing balances and excludes pending amounts', () => {
    // given
    const data = A.parseExport(csv([transaction('03.10.26', '-300'), transaction('01.10.26', '500'), transaction('02.10.26', '-200', 'Shop', 'Vorgemerkt')], '04.10.2026', '1.200'));
    // when
    const points = A.balanceSeries(data);
    // then
    assert.deepEqual(points.map(p => [p.opening, p.balance, p.transactions.length]), [[100000, 150000, 1], [150000, 150000, 0], [150000, 120000, 1], [120000, 120000, 0]]);
  });

  it('aggregates same-day transactions without inventing intraday balances', () => {
    // given
    const data = A.parseExport(csv([transaction('10.10.26', '-30'), transaction('10.10.26', '50')], '10.10.2026', '100'));
    // when
    const points = A.balanceSeries(data);
    // then
    assert.deepEqual(points.map(p => [p.opening, p.balance, p.transactions.length]), [[8000, 10000, 2]]);
  });

  it('does not invent historical balances for a pending-only export', () => {
    // given
    const data = A.parseExport(csv([transaction('11.10.26', '-30', 'Shop', 'Vorgemerkt')]));
    // when
    const points = A.balanceSeries(data);
    // then
    assert.deepEqual(points, []);
  });
});

describe('Expense classification', () => {
  it('treats non-recurring amounts from 150 EUR in either direction as extra', () => {
    // given
    const items = [{ amount: -14999, recurring: false }, { amount: -15000, recurring: false }, { amount: -150000, recurring: true }, { amount: 15000, recurring: false }, { amount: 250000, recurring: true }];
    // when
    const result = items.map(A.isExtra);
    // then
    assert.deepEqual(result, [false, true, false, true, false]);
  });

  it('matches income by sender and amount without recognizing salary keywords', () => {
    // given
    const text = csv([transaction('01.10.26', '2.500,00', 'Shop', 'Gebucht', 'Gehalt Oktober'), transaction('05.10.26', '250,00'), transaction('05.09.26', '240,00'), transaction('20.09.26', '1.200,00', 'Shop', 'Gebucht', 'Bonus')]);
    // when
    const result = A.parseExport(text).transactions.map(t => [t.amount, t.recurring]);
    // then
    assert.deepEqual(result, [[24000, true], [120000, false], [250000, false], [25000, true]]);
  });

  it('recognizes similar monthly counterparty charges as recurring', () => {
    // given
    const text = csv([transaction('05.10.26', '-200', 'Service'), transaction('05.09.26', '-210', 'Service'), transaction('05.08.26', '-205', 'Service'), transaction('06.09.26', '-350', 'Other shop')]);
    // when
    const data = A.parseExport(text);
    // then
    assert.deepEqual(data.transactions.map(t => [t.counterparty, t.recurring]), [['Service', true], ['Service', true], ['Other shop', false], ['Service', true]]);
  });

  it('recognizes all monthly income entries despite shifted dates and different recipient details', () => {
    // given
    const dates = ['16.06.26', '19.05.26', '17.04.26', '12.03.26'];
    const rows = dates.map((date, i) => transaction(date, '518', i > 1 ? 'Recipient with address' : 'Recipient', 'Gebucht', `Reference ${i}`).replace('"Employer"', '"Same sender"'));
    const data = A.parseExport(csv(rows, '30.06.2026'));
    // when
    const result = data.transactions.map(t => [t.recurring, A.isExtra(t), t.recurringReason]);
    // then
    assert.deepEqual(result, dates.map(() => [true, false, 'Same sender with similar amounts in adjacent calendar months (within 15%)']));
  });

  it('matches adjacent income months across year boundaries, not same-month or skipped-month payments', () => {
    // given
    const data = A.parseExport(csv([
      transaction('01.12.25', '500'),
      transaction('31.01.26', '520'),
      transaction('05.03.26', '510'),
      transaction('20.03.26', '510')
    ], '31.03.2026'));
    // when
    const result = data.transactions.map(t => t.recurring);
    // then
    assert.deepEqual(result, [true, true, false, false]);
  });

  it('requires similar amounts, same sender, same direction and booked matches', () => {
    // given
    const data = A.parseExport(csv([
      transaction('01.09.26', '500'),
      transaction('01.10.26', '700'),
      transaction('02.10.26', '500', 'Shop', 'Vorgemerkt'),
      transaction('03.10.26', '-500', 'Employer'),
      transaction('04.10.26', '500').replace('"Employer"', '"Other sender"')
    ]));
    // when
    const result = data.transactions.map(t => t.recurring);
    // then
    assert.deepEqual(result, [false, false, false, false, false]);
  });

  it('does not treat frequent purchases at the same shop as a monthly bill', () => {
    // given
    const text = csv([transaction('01.10.26', '-200'), transaction('02.10.26', '-200'), transaction('03.10.26', '-200')]);
    // when
    const data = A.parseExport(text);
    // then
    assert.equal(data.transactions.some(t => t.recurring), false);
  });

  it('does not infer recurring bills from keywords or assign expense categories', () => {
    // given
    const text = csv([transaction('01.10.26', '-50', 'REWE'), transaction('02.10.26', '-1500', 'Vermieter'), transaction('03.10.26', '-40', 'Internet Corp')]);
    // when
    const data = A.parseExport(text);
    // then
    assert.deepEqual(data.transactions.map(t => [Object.hasOwn(t, 'category'), t.recurring]), [[false, false], [false, false], [false, false]]);
  });

  it('reduces demo shopping false positives while retaining monthly bills', () => {
    // given
    const text = fs.readFileSync(new URL('../public/demo.csv', import.meta.url), 'utf8');
    // when
    const entries = A.parseExport(text).transactions;
    // then
    assert.deepEqual({
      shoppingMatches: entries.filter(entry => entry.counterparty === 'REWE Nordmarkt' && entry.recurring).length,
      mayShoppingMatches: entries.filter(entry => entry.counterparty === 'REWE Nordmarkt' && entry.recurring &&
        entry.date >= A.parseDate('01.05.2026') && entry.date < A.parseDate('01.06.2026')).length,
      monthlyBills: entries.filter(entry => entry.counterparty === 'Wohnbau Nord').every(entry => entry.recurring)
    }, { shoppingMatches: 3, mayShoppingMatches: 0, monthlyBills: true });
  });

  it('does not invent recurrence for an unmatched transaction', () => {
    // given
    const text = csv([transaction('01.10.26', '-200', 'Unknown recipient')]);
    // when
    const result = A.parseExport(text).transactions[0];
    // then
    assert.deepEqual({ recurring: result.recurring, reason: result.recurringReason }, { recurring: false, reason: '' });
  });

  it('does not exclude matching payments by grocery keywords', () => {
    // given
    const text = csv([transaction('05.10.26', '-200', 'REWE'), transaction('05.09.26', '-200', 'REWE'), transaction('05.08.26', '-200', 'REWE')]);
    // when
    const result = A.parseExport(text).transactions.map(t => t.recurring);
    // then
    assert.deepEqual(result, [true, true, true]);
  });

  it('records evidence for monthly recurrence detection', () => {
    // given
    const text = csv([transaction('05.10.26', '-200', 'Service'), transaction('05.09.26', '-200', 'Service'), transaction('05.08.26', '-200', 'Service')]);
    // when
    const result = A.parseExport(text).transactions.map(t => t.recurringReason);
    // then
    assert.deepEqual(result, Array(3).fill('Similar recipient amounts in three consecutive months, 25–35 days apart (within 15%), without competing same-month payments'));
  });

  for (const [name, dates, amounts, statuses] of [
    ['only two months', ['05.09.26', '05.10.26'], ['-200', '-200']],
    ['skipped month', ['05.07.26', '05.09.26', '05.10.26'], ['-200', '-200', '-200']],
    ['inconsistent timing', ['01.08.26', '20.09.26', '05.10.26'], ['-200', '-200', '-200']],
    ['different amount', ['05.08.26', '05.09.26', '05.10.26'], ['-200', '-300', '-200']],
    ['competing purchase', ['05.08.26', '05.09.26', '06.09.26', '05.10.26'], ['-200', '-200', '-210', '-200']],
    ['pending third payment', ['05.08.26', '05.09.26', '05.10.26'], ['-200', '-200', '-200'], ['Gebucht', 'Gebucht', 'Vorgemerkt']]
  ]) {
    it(`rejects expense recurrence with ${name}`, () => {
      // given
      const text = csv(dates.map((date, index) => transaction(date, amounts[index], 'Service', statuses?.[index] || 'Gebucht')));
      // when
      const result = A.parseExport(text);
      // then
      assert.equal(result.transactions.some(entry => entry.recurring), false);
    });
  }

  it('keeps a distinct subscription through a payment processor despite unrelated purchases', () => {
    // given
    const text = csv([
      transaction('05.08.26', '-20', 'PayPal'), transaction('05.09.26', '-20', 'PayPal'),
      transaction('05.10.26', '-20', 'PayPal'), transaction('06.09.26', '-200', 'PayPal')
    ]);
    // when
    const result = A.parseExport(text).transactions.map(entry => [entry.amount, entry.recurring]);
    // then
    assert.deepEqual(result, [[-2000, true], [-2000, true], [-20000, false], [-2000, true]]);
  });
});

describe('Monthly analysis', () => {
  it('uses calendar months from the balance month back to the oldest transaction', () => {
    // given
    const data = A.parseExport(csv([transaction('10.08.26', '-10'), transaction('10.10.26', '-10')]));
    // when
    const result = A.months(data);
    // then
    assert.deepEqual(result.map(p => [p.start, p.end]), [[A.parseDate('01.10.26'), A.parseDate('01.11.26')], [A.parseDate('01.09.26'), A.parseDate('01.10.26')], [A.parseDate('01.08.26'), A.parseDate('01.09.26')]]);
  });

  it('marks months not fully covered by the export as partial', () => {
    // given
    const data = A.parseExport(csv([transaction('10.08.26', '-10'), transaction('01.09.26', '-10')], '30.09.2026'));
    const early = A.parseExport(csv([transaction('01.08.26', '-10')], '10.10.2026'));
    // when
    const result = [A.months(data).map(p => p.complete), A.months(early).map(p => p.complete)];
    // then
    assert.deepEqual(result, [[true, false], [false, true, true]]);
  });

  it('handles short months and year boundaries', () => {
    // given
    const data = A.parseExport(csv([transaction('31.12.23', '-10')], '29.02.2024'));
    // when
    const result = A.months(data).map(p => [p.start, p.end, p.complete]);
    // then
    assert.deepEqual(result, [[A.parseDate('01.02.2024'), A.parseDate('01.03.2024'), true], [A.parseDate('01.01.2024'), A.parseDate('01.02.2024'), true], [A.parseDate('01.12.2023'), A.parseDate('01.01.2024'), false]]);
  });

  it('assigns each booked transaction to exactly one month', () => {
    // given
    const data = A.parseExport(csv([transaction('30.09.26', '-10'), transaction('01.10.26', '-20'), transaction('31.10.26', '-30')], '31.10.2026'));
    // when
    const result = A.months(data).map(period => A.summarize(data.transactions, period).regular);
    // then
    assert.deepEqual(result, [5000, 1000]);
  });

  it('separates booked income, extra income, regular and special expenses and ignores pending transactions', () => {
    // given
    const data = A.parseExport(csv([transaction('01.10.26', '1000', 'Shop', 'Gebucht', 'Gehalt'), transaction('07.10.26', '300', 'Shop', 'Gebucht', 'Erstattung'), transaction('02.10.26', '-50', 'REWE'), transaction('03.10.26', '-150'), transaction('04.10.26', '-800', 'Vermieter'), transaction('05.10.26', '-200', 'Shop', 'Vorgemerkt'), transaction('06.10.26', '100', 'Shop', 'Vorgemerkt')]));
    // when
    const result = A.summarize(data.transactions, A.months(data)[0]);
    // then
    assert.deepEqual({ income: result.income, extraIncome: result.extraIncome, regular: result.regular, special: result.special, net: result.net, counts: Object.values(result.entries).map(entries => entries.length) }, { income: 0, extraIncome: 130000, regular: 5000, special: 95000, net: 30000, counts: [0, 2, 1, 2] });
  });

  it('summarizes unknown extra expenses without inventing a category', () => {
    // given
    const data = A.parseExport(csv([transaction('01.10.26', '-200', 'Unknown recipient')]));
    // when
    const result = A.summarize(data.transactions, A.months(data)[0]);
    // then
    assert.deepEqual({ regular: result.regular, special: result.special, entries: result.entries.special.map(t => t.amount), categories: Object.hasOwn(result, 'categories') }, { regular: 0, special: 20000, entries: [-20000], categories: false });
  });

  it('does not invent a percentage when the previous total is zero', () => {
    // given
    const previous = 0;
    // when
    const result = A.percentage(15000, previous);
    // then
    assert.equal(result, null);
  });

  it('computes percentage change relative to the magnitude of the previous value', () => {
    // given
    const values = [[12000, 10000], [-5000, -10000]];
    // when
    const result = values.map(([current, previous]) => A.percentage(current, previous));
    // then
    assert.deepEqual(result, [20, 50]);
  });
});

describe('Trend', () => {
  // Full months from January 2025 to the balance month, each with salary and rent.
  function history(count, { rent = () => '-1.000,00', extras = [] } = {}) {
    const rows = [];
    for (let i = 0; i < count; i++) {
      const month = String(i % 12 + 1).padStart(2, '0'), year = String(25 + Math.floor(i / 12));
      rows.push(transaction(`01.${month}.${year}`, '3.000,00', 'Shop', 'Gebucht', 'Gehalt'), transaction(`02.${month}.${year}`, rent(i), 'Vermieter'));
    }
    const last = new Date(Date.UTC(2025, count, 0));
    const balanceDate = `${String(last.getUTCDate()).padStart(2, '0')}.${String(last.getUTCMonth() + 1).padStart(2, '0')}.${last.getUTCFullYear()}`;
    return A.parseExport(csv([...rows, ...extras], balanceDate));
  }

  it('averages full months only, excluding extras, without comparison for short exports', () => {
    // given
    const data = history(2, { extras: [transaction('10.02.25', '-900,00', 'Garage'), transaction('11.02.25', '500,00')] });
    // when
    const result = A.trend(data);
    // then
    assert.deepEqual({ window: result.window, points: result.points.length, current: result.current, basis: result.basis }, { window: 2, points: 1, current: { start: A.parseDate('01.01.2025'), end: A.parseDate('01.02.2025'), income: 300000, regular: 0, net: 300000, extraIncome: 50000, special: 290000 }, basis: null });
  });

  describe('Yearly extras', () => {
    it('compares year-to-date totals with the same dates last year, excluding future seasonal extras', () => {
      // given
      const data = A.parseExport(csv([
        transaction('01.01.25', '-10'),
        transaction('15.04.25', '-300', 'Garage'),
        transaction('01.12.25', '-900', 'Garage'),
        transaction('05.05.25', '200', 'Shop', 'Gebucht', 'Refund'),
        transaction('15.04.26', '-450', 'Garage'),
        transaction('05.05.26', '500', 'Shop', 'Gebucht', 'Refund'),
        transaction('10.10.26', '-900', 'Garage', 'Vorgemerkt')
      ]));
      // when
      const result = A.yearlyExtras(data);
      // then
      assert.deepEqual(result[0], {
        year: 2026, start: A.parseDate('01.01.2026'), end: A.parseDate('11.10.2026'), complete: false,
        extraIncome: 50000, special: 45000,
        previous: { start: A.parseDate('01.01.2025'), end: A.parseDate('11.10.2025'), extraIncome: 20000, special: 30000 }
      });
    });

    it('marks partial earliest years and omits comparisons without full matching coverage', () => {
      // given
      const data = A.parseExport(csv([transaction('01.11.25', '-300', 'Garage'), transaction('01.04.26', '-500', 'Garage')]));
      // when
      const result = A.yearlyExtras(data).map(period => [period.year, period.start, period.complete, period.previous]);
      // then
      assert.deepEqual(result, [[2026, A.parseDate('01.01.2026'), false, null], [2025, A.parseDate('01.11.2025'), false, null]]);
    });

    it('compares full years and retains zero-extra years', () => {
      // given
      const data = A.parseExport(csv([transaction('01.01.24', '-10'), transaction('20.12.24', '-300', 'Garage')], '31.12.2025'));
      // when
      const result = A.yearlyExtras(data);
      // then
      assert.deepEqual(result.map(period => [period.year, period.complete, period.special, period.previous?.special]), [[2025, true, 0, 30000], [2024, true, 30000, undefined]]);
    });

    it('clamps leap-day comparison to the last day of February in the previous year', () => {
      // given
      const data = A.parseExport(csv([transaction('01.01.23', '-10'), transaction('28.02.23', '-300', 'Garage'), transaction('01.03.23', '-500', 'Garage')], '29.02.2024'));
      // when
      const result = A.yearlyExtras(data)[0].previous;
      // then
      assert.deepEqual(result, { start: A.parseDate('01.01.2023'), end: A.parseDate('01.03.2023'), extraIncome: 0, special: 30000 });
    });
  });

  it('compares the latest three months with the three before from six full months', () => {
    // given
    const data = history(6, { rent: i => i < 3 ? '-1.000,00' : '-1.090,00' });
    // when
    const result = A.trend(data);
    // then
    assert.deepEqual({ basis: result.basis, current: result.current.regular, previous: result.previous.regular, previousStart: result.previous.start, points: result.points.length }, { basis: 'previous', current: 109000, previous: 100000, previousStart: A.parseDate('01.01.2025'), points: 4 });
  });

  it('compares with the same months a year earlier from fifteen full months', () => {
    // given
    const data = history(15);
    // when
    const result = A.trend(data);
    // then
    assert.deepEqual({ basis: result.basis, current: result.current.start, previous: result.previous.start }, { basis: 'year', current: A.parseDate('01.01.2026'), previous: A.parseDate('01.01.2025') });
  });

  it('ignores partial months and returns nothing without a full month', () => {
    // given
    const data = A.parseExport(csv([transaction('05.10.26', '-10')]));
    // when
    const result = A.trend(data);
    // then
    assert.equal(result, null);
  });
});
