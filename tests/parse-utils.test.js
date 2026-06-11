'use strict';

const {
  extractTypeId,
  parseDoctrinesHtml,
  parseDoctrineDetail,
  parseFitDetail,
  fmtIsk,
  fmtMillions,
} = require('../renderer/parse-utils');

// ── extractTypeId ─────────────────────────────────────────────────────────────

describe('extractTypeId', () => {
  test('extracts type id from ESI image URL', () => {
    expect(extractTypeId('https://images.evetech.net/types/11993/render?size=64')).toBe(11993);
  });

  test('returns null for null input', () => {
    expect(extractTypeId(null)).toBeNull();
  });

  test('returns null when no /types/ segment', () => {
    expect(extractTypeId('https://images.evetech.net/alliances/1234/logo')).toBeNull();
  });
});

// ── fmtIsk ────────────────────────────────────────────────────────────────────

describe('fmtIsk', () => {
  test('formats whole number with commas', () => {
    expect(fmtIsk(2592605)).toBe('2,592,605');
  });

  test('truncates decimals', () => {
    expect(fmtIsk(1000000.9)).toBe('1,000,001');
  });
});

// ── fmtMillions ───────────────────────────────────────────────────────────────

describe('fmtMillions', () => {
  // fmtMillions rounds to the nearest 1M and emits a compact "<N>M" string
  // (no decimal places, no space). Matches the runtime use on the Contracts
  // tab where bar labels need to stay short. See PR #3 (commit 4cd049d).

  test('rounds to nearest 1M', () => {
    expect(fmtMillions(2981496)).toBe('3M');   // 2,981,496 → rounds up to 3M
  });

  test('rounds down when below midpoint', () => {
    expect(fmtMillions(3140000)).toBe('3M');   // 3.14M → 3M
  });

  test('rounds up at the half-million mark', () => {
    expect(fmtMillions(3500000)).toBe('4M');   // banker-agnostic — Math.round → 4
  });

  test('exact millions render with no decimal', () => {
    expect(fmtMillions(5000000)).toBe('5M');
  });
});

// ── parseDoctrinesHtml ────────────────────────────────────────────────────────

describe('parseDoctrinesHtml', () => {
  const html = `
    <table id="docTable">
      <tbody>
        <tr>
          <td>
            <a href="/fittings/doctrine/42/">Navy Assault</a>
            <img src="/static/icon.png" alt="">
          </td>
          <td><a href="/fittings/cat/3/">PvP</a></td>
          <td>Fast tackle doctrine</td>
          <td>
            <img alt="Malediction" src="https://images.evetech.net/types/11174/render?size=32">
            <img alt="Crusader"    src="https://images.evetech.net/types/11178/render?size=32">
            <img alt="Malediction" src="https://images.evetech.net/types/11174/render?size=32">
          </td>
        </tr>
      </tbody>
    </table>`;

  test('parses doctrine id and name', () => {
    const [d] = parseDoctrinesHtml(html);
    expect(d.id).toBe(42);
    expect(d.name).toBe('Navy Assault');
  });

  test('parses category', () => {
    const [d] = parseDoctrinesHtml(html);
    expect(d.category).toBe('PvP');
  });

  test('parses unique ship names from images', () => {
    const [d] = parseDoctrinesHtml(html);
    expect(d.ships).toEqual(['Malediction', 'Crusader']);
  });

  test('returns empty array for empty table', () => {
    expect(parseDoctrinesHtml('<table id="docTable"><tbody></tbody></table>')).toEqual([]);
  });
});

// ── parseDoctrineDetail ───────────────────────────────────────────────────────

describe('parseDoctrineDetail', () => {
  const html = `
    <div class="card-body">
      <img alt="Navy Assault" src="/static/icon.png">
      <a href="/fittings/cat/3/">PvP</a>
    </div>
    <table id="fitTable">
      <tbody>
        <tr>
          <td><a href="/fittings/fit/99/"><span>Malediction Navy Tackle Mk3</span></a></td>
          <td>Malediction</td>
          <td><a href="/fittings/cat/3/">PvP</a></td>
          <td>Fast interceptor</td>
        </tr>
      </tbody>
    </table>`;

  test('parses doctrine name from header image alt', () => {
    expect(parseDoctrineDetail(html).name).toBe('Navy Assault');
  });

  test('parses fit id and name', () => {
    const { fits } = parseDoctrineDetail(html);
    expect(fits).toHaveLength(1);
    expect(fits[0].id).toBe(99);
    expect(fits[0].name).toBe('Malediction Navy Tackle Mk3');
  });

  test('parses fit ship type', () => {
    const { fits } = parseDoctrineDetail(html);
    expect(fits[0].shipType).toBe('Malediction');
  });
});

// ── parseFitDetail ────────────────────────────────────────────────────────────

describe('parseFitDetail', () => {
  const buyText = 'Malediction x1\nJ5b Enduring Warp Scrambler x1\nSmall Ancillary Armor Repairer x1\n1MN Afterburner II x1';

  const html = `
    <h3>Malediction Navy Tackle Mk3</h3>
    <div id="bigship">
      <img alt="Malediction" src="https://images.evetech.net/types/11174/render?size=64">
    </div>
    <dl>
      <dd><a href="/fittings/doctrine/42/">Navy Assault</a></dd>
    </dl>
    <button id="buyAllButton" data-clipboard-text="${buyText}"></button>
    <img alt="J5b Enduring Warp Scrambler" src="https://images.evetech.net/types/28827/render?size=32">
    <img alt="Small Ancillary Armor Repairer" src="https://images.evetech.net/types/28668/render?size=32">
    <img alt="1MN Afterburner II" src="https://images.evetech.net/types/12058/render?size=32">`;

  test('parses fit name', () => {
    expect(parseFitDetail(html).name).toBe('Malediction Navy Tackle Mk3');
  });

  test('parses hull name and type id', () => {
    const { hullName, hullTypeId } = parseFitDetail(html);
    expect(hullName).toBe('Malediction');
    expect(hullTypeId).toBe(11174);
  });

  test('parses doctrines list', () => {
    const { doctrines } = parseFitDetail(html);
    expect(doctrines).toEqual([{ id: 42, name: 'Navy Assault' }]);
  });

  test('parses items from buy-all button with type ids resolved from images', () => {
    const { items } = parseFitDetail(html);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ name: 'Malediction', qty: 1, typeId: 11174 });
    expect(items[1]).toMatchObject({ name: 'J5b Enduring Warp Scrambler', qty: 1, typeId: 28827 });
    expect(items[2]).toMatchObject({ name: 'Small Ancillary Armor Repairer', qty: 1, typeId: 28668 });
  });

  test('returns empty items for missing buy button', () => {
    const { items } = parseFitDetail('<h3>Test</h3>');
    expect(items).toEqual([]);
  });
});
