// academic.test.mjs — 「学术」的纯函数（static/admin/js/academic.js）：BibTeX 解析、LaTeX 解码、作者名、期刊缩写、
// 一条 BibTeX → 论文字段、确定性的 YAML 写法（新文件 / 本后台写的文件 / 手改过的文件）、id、排序分组、社交链接补全、菜单小工具。
//
// 运行：node --test tests/admin/academic.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as yaml from '../../static/admin/vendor/js-yaml/js-yaml.mjs';

import {
  SECTIONS, FIELD_ORDER, parseBibtex, decodeLatex, splitAuthors, formatAuthor, parseAuthors, initialsOf, journalName,
  JOURNAL_MACROS, normalizeArxiv, normalizeDoi, normalizeAdsBibcode, isBibcode, bibToPublication, isValidId, slugId,
  uniqueId, publicationIdFor, talkIdFor, newsIdFor, todayISO, isIsoDate, dateString, dumpYaml, parseYamlEntry,
  cleanEntry, entryFileText, formValues, idFromPath, groupPublications, pubGroupOf, splitTalks, sortNews, isMyName,
  normalizeSocialUrl, socialUrlWarning, orcidChecksumOk, SOCIAL_HINTS, menuWithoutMain, nextMenuWeight,
  academicIndexDocument, AcademicDataError, isArxivId, isDoi, isHttpUrl, identifierError,
} from '../../static/admin/js/academic.js';
import { splitDocument, parseFrontMatter } from '../../static/admin/js/frontmatter.js';

const loadCore = (t) => yaml.load(t, { schema: yaml.CORE_SCHEMA });

// ---------------------------------------------------------------------------
// fixtures: real-looking exports

/** NASA ADS「Export → BibTeX」：几篇不同期刊的文章，ADS 的缩进、期刊宏、双层括号标题、adsurl / adsnote。 */
const ADS_EXPORT = String.raw`@ARTICLE{2024ApJ...960..101Z,
       author = {{Zhong}, Fangxiong and {M{\"u}ller}, J{\"o}rg and {van der Berg}, J. -P. and {{\O}stergaard}, Ren{\'e}e and {LIGO Scientific Collaboration} and others},
        title = "{Hydrostatic Equilibrium of {\ion{H}{i}} Gas in Dark Galaxies at $z\sim 0.1$}",
      journal = {\apj},
     keywords = {Astrophysics - Astrophysics of Galaxies},
         year = 2024,
        month = jan,
       volume = {960},
       number = {2},
          eid = {101},
        pages = {101},
          doi = {10.3847/1538-4357/ad0b1c},
archivePrefix = {arXiv},
       eprint = {2310.01234},
 primaryClass = {astro-ph.GA},
       adsurl = {https://ui.adsabs.harvard.edu/abs/2024ApJ...960..101Z},
      adsnote = {Provided by the SAO/NASA Astrophysics Data System}
}

@ARTICLE{2025MNRAS.536L..12Z,
       author = {{Zhong}, F. and {Garc{\'\i}a}, Jos{\'e} and {Ko{\v{s}}i{\'c}}, Ana},
        title = "{The {\em JWST} view of {H}{\sc ii} regions -- a letter}",
      journal = {\mnras},
         year = 2025,
        month = feb,
       volume = {536},
       number = {1},
        pages = {L12-L17},
          doi = {10.1093/mnrasl/slae123},
       adsurl = {https://ui.adsabs.harvard.edu/abs/2025MNRAS.536L..12Z},
}

@ARTICLE{2023A&A...671A..42Z,
       author = {{Zhong}, Fangxiong and {Stra{\ss}er}, M. and {{\L}ukasz}, K.},
        title = "{Gas kinematics in {M}~33 at 10\% precision}",
      journal = {\aap},
         year = 2023,
        month = mar,
       volume = {671},
          eid = {A42},
        pages = {A42},
          doi = {10.1051/0004-6361/202245000},
       adsurl = {https://ui.adsabs.harvard.edu/abs/2023A%26A...671A..42Z},
}

@ARTICLE{2026arXiv260301234Z,
       author = {{Zhong}, Fangxiong and {Wang}, Xiao-Ming},
        title = "{A Preprint: Using \textit{JWST} \& ALMA}",
      journal = {arXiv e-prints},
         year = 2026,
        month = mar,
          eid = {arXiv:2603.01234},
        pages = {arXiv:2603.01234},
archivePrefix = {arXiv},
       eprint = {2603.01234},
 primaryClass = {astro-ph.GA},
       adsurl = {https://ui.adsabs.harvard.edu/abs/2026arXiv260301234Z},
      adsnote = {Provided by the SAO/NASA Astrophysics Data System}
}

@INPROCEEDINGS{2025IAUS..390..123Z,
       author = {{Zhong}, F.},
        title = "{Dark galaxies in the local universe}",
    booktitle = {Galaxies Near and Far},
         year = 2025,
       editor = {{Smith}, J.},
       series = {IAU Symposium},
       volume = {390},
        pages = {123-126},
          doi = {10.1017/S1743921325000000},
       adsurl = {https://ui.adsabs.harvard.edu/abs/2025IAUS..390..123Z},
}

@PHDTHESIS{2030PhDT.........1Z,
       author = {{Zhong}, Fangxiong},
        title = "{Neutral gas in dark galaxies}",
       school = {University of California},
         year = 2030,
       adsurl = {https://ui.adsabs.harvard.edu/abs/2030PhDT.........1Z},
}
`;

/** arXiv 网页上的「Export BibTeX Citation」。 */
const ARXIV_EXPORT = `@misc{zhong2026hydrostatic,
      title={Hydrostatic equilibrium of neutral hydrogen in dark galaxies},
      author={Fangxiong Zhong and Jane Q. Doe and Ludwig van Beethoven},
      year={2026},
      eprint={2603.01234v2},
      archivePrefix={arXiv},
      primaryClass={astro-ph.GA},
      url={https://arxiv.org/abs/2603.01234},
}`;

describe('BibTeX: parseBibtex', () => {
  test('ADS export with several entries', () => {
    const r = parseBibtex(ADS_EXPORT);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.entries.map((e) => [e.type, e.key]), [
      ['article', '2024ApJ...960..101Z'], ['article', '2025MNRAS.536L..12Z'], ['article', '2023A&A...671A..42Z'],
      ['article', '2026arXiv260301234Z'], ['inproceedings', '2025IAUS..390..123Z'], ['phdthesis', '2030PhDT.........1Z'],
    ]);
    const e = r.entries[0];
    assert.equal(e.fields.journal, '\\apj');
    assert.equal(e.fields.year, '2024');
    assert.equal(e.fields.month, 'jan', 'bare month macro keeps its name');
    assert.equal(e.fields.title, '{Hydrostatic Equilibrium of {\\ion{H}{i}} Gas in Dark Galaxies at $z\\sim 0.1$}', 'quotes stripped, inner braces kept');
    assert.ok(e.raw.startsWith('@ARTICLE{2024ApJ...960..101Z,') && e.raw.endsWith('}'));
    assert.ok(!e.raw.includes('@ARTICLE{2025'), 'raw is only this entry');
    assert.equal(e.line, 1);
    assert.equal(r.entries[1].line, 20);
  });

  test('field names are case-insensitive; first duplicate wins; ( ) delimiters; # concatenation; @string macros', () => {
    const r = parseBibtex(`@STRING{ apjname = "Astrophys. J." }
@String(series = {Lecture Notes})
@Article ( key1 ,
  TITLE = "A " # {B} # " C",
  Journal = apjname,
  NOTE = series # { in Physics},
  title = {ignored duplicate},
  year = 2020 )`);
    assert.deepEqual(r.errors, []);
    assert.equal(r.entries.length, 1);
    const f = r.entries[0].fields;
    assert.equal(r.entries[0].key, 'key1');
    assert.equal(f.title, 'A B C');
    assert.equal(f.journal, 'Astrophys. J.');
    assert.equal(f.note, 'Lecture Notes in Physics');
    assert.equal(f.year, '2020');
  });

  test('comments, @comment / @preamble, junk between entries, e-mail addresses, weird whitespace and CRLF', () => {
    const text = '\ufeff% Exported from somewhere\r\nWrite to me@example.org for questions.\r\n' +
      '@comment{ this {is} ignored @ARTICLE{fake, title={no}} }\r\n' +
      '@preamble{ "\\newcommand{\\noop}[1]{}" }\r\n' +
      '\t@article{ spaced ,\r\n\ttitle\t=\t{Tabbed   title},\r\n\r\n  author = {Doe, J.},\r\n  year={1999}\r\n}\r\n' +
      '%% @article{commented, title={x}}  — a line comment is not special to BibTeX, but this is not inside braces\r\n';
    const r = parseBibtex(text);
    const keys = r.entries.map((e) => e.key);
    assert.ok(keys.includes('spaced'));
    assert.ok(!keys.includes('fake'), '@comment body ignored');
    const e = r.entries.find((x) => x.key === 'spaced');
    assert.equal(e.fields.title, 'Tabbed   title');
    assert.equal(decodeLatex(e.fields.title), 'Tabbed title');
    assert.ok(!e.raw.includes('\r'), 'CRLF normalised');
  });

  test('nested braces and quotes inside values', () => {
    const r = parseBibtex(String.raw`@article{nest,
  title = {{The {\em JWST} view of {$z>6$} {H}{\sc ii} regions: {"}quoted{"} words}},
  author = "{\"O}zel, F. and G{\"u}ver, T.",
  note = "a } inside braces {}}{ is fine?"
}`);
    // the unbalanced note makes this entry fail cleanly; the parser must not throw
    assert.equal(r.entries.length + r.errors.length >= 1, true);
    const ok = parseBibtex(String.raw`@article{nest,
  title = {{The {\em JWST} view of {$z>6$} {H}{\sc ii} regions: {"}quoted{"} words}},
  author = "{\"O}zel, F. and G{\"u}ver, T."
}`);
    assert.deepEqual(ok.errors, []);
    const f = ok.entries[0].fields;
    assert.equal(decodeLatex(f.title), 'The JWST view of $z>6$ HII regions: "quoted" words');
    assert.deepEqual(parseAuthors(f.author), ['Özel, F.', 'Güver, T.']);
  });

  test('a broken entry is reported and the next one still parses', () => {
    const r = parseBibtex(`@article{bad,
  title = {Unclosed,
  year = 2020

@article{good, title={Fine}, year=2021}
`);
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].key, 'good');
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].line, 2, 'line of the unclosed value');
    assert.match(r.errors[0].message, /[一-龥]/, 'Chinese message');
  });

  test('missing = or value → error, not exception; empty input → nothing', () => {
    assert.equal(parseBibtex('@article{k, title {x}}').errors.length, 1);
    assert.equal(parseBibtex('@article{k, title = }').errors.length, 1);
    assert.deepEqual(parseBibtex(''), { entries: [], errors: [] });
    assert.deepEqual(parseBibtex(null), { entries: [], errors: [] });
    assert.deepEqual(parseBibtex('just text, no entries @ all').entries, []);
  });

  test('entry without fields', () => {
    const r = parseBibtex('@misc{lonely}');
    assert.deepEqual(r.entries.map((e) => [e.key, e.fields]), [['lonely', {}]]);
  });
});

describe('BibTeX: decodeLatex', () => {
  const cases = [
    [String.raw`Caf\'{e}`, 'Café'], [String.raw`Caf\'e`, 'Café'], [String.raw`Caf{\'e}`, 'Café'],
    [String.raw`M{\"u}ller`, 'Müller'], [String.raw`M\"uller`, 'Müller'], [String.raw`{\o}ster`, 'øster'], [String.raw`{\O}`, 'Ø'],
    [String.raw`\AA ngstr\"om`, 'Ångström'], [String.raw`{\aa}`, 'å'], [String.raw`Stra{\ss}e`, 'Straße'], [String.raw`Gar\c{c}on`, 'Garçon'],
    [String.raw`Ko\v{s}i\'c`, 'Košić'], [String.raw`Erd\H{o}s`, 'Erdős'], [String.raw`Espa\~{n}a`, 'España'], [String.raw`Garc\'{\i}a`, 'García'],
    [String.raw`Garc{\'\i}a`, 'García'], [String.raw`{\L}ukasz`, 'Łukasz'], [String.raw`\l{}\'od\'z`, 'łódź'], [String.raw`{\ae}on`, 'æon'],
    [String.raw`\u{g}`, 'ğ'], [String.raw`\={a}`, 'ā'], [String.raw`\.{z}`, 'ż'], [String.raw`\k{a}`, 'ą'], [String.raw`\r{u}`, 'ů'],
    [String.raw`A \& B`, 'A & B'], [String.raw`10\%`, '10%'], [String.raw`\$5`, '$5'], [String.raw`a\_b`, 'a_b'], [String.raw`\#1`, '#1'],
    ['1--10', '1–10'], ['a---b', 'a—b'], ['``quoted\'\'', '“quoted”'], ['M~33', 'M 33'],
    [String.raw`{\ion{H}{i}} gas`, 'H I gas'], [String.raw`H{\sc ii}`, 'HII'], [String.raw`\textsc{ii}`, 'II'],
    [String.raw`\textit{JWST}`, 'JWST'], [String.raw`\emph{very}`, 'very'], [String.raw`{\em very} good`, 'very good'], [String.raw`\textbf{bold}`, 'bold'],
    [String.raw`\href{https://x.org}{link text}`, 'link text'], [String.raw`\textless{}1\textgreater{}`, '<1>'],
    [String.raw`at $z\sim 6$ and $\Lambda$CDM`, 'at $z\\sim 6$ and $\\Lambda$CDM'], [String.raw`\(x^2\)`, '\\(x^2\\)'],
    ['  lots \n of\t space  ', 'lots of space'], ['{{Double braces}}', 'Double braces'], ['方雄 ', '方雄'],
    [String.raw`unknown \foo command`, 'unknown command'], [String.raw`\LaTeX{} rocks`, 'LaTeX rocks'],
  ];
  for (const [input, want] of cases) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(want)}`, () => assert.equal(decodeLatex(input), want));
  }
  test('results are NFC', () => {
    assert.equal(decodeLatex(String.raw`\'{e}`), 'é');
    assert.equal(decodeLatex('é'), 'é');
  });
  test('unbalanced input does not throw', () => {
    assert.equal(decodeLatex('{open'), 'open');
    assert.equal(decodeLatex('close}'), 'close');
    assert.equal(decodeLatex('\\'), '');
    assert.equal(decodeLatex(null), '');
  });
});

describe('BibTeX: authors', () => {
  test('splitAuthors only splits top-level " and "', () => {
    assert.deepEqual(splitAuthors('{Smith and Wesson}, A. and Doe, J. AND Roe, R.'), ['{Smith and Wesson}, A.', 'Doe, J.', 'Roe, R.']);
    assert.deepEqual(splitAuthors('Anderson, A. and Andrews, B.'), ['Anderson, A.', 'Andrews, B.'], 'names containing "and"');
    assert.deepEqual(splitAuthors('  '), []);
    assert.deepEqual(splitAuthors('A,\n  B and\n  C, D'), ['A, B', 'C, D'], 'newlines inside the field');
  });

  const cases = [
    ['{Zhong}, Fangxiong', 'Zhong, F.'], ['{Zhong}, F.', 'Zhong, F.'], ['Zhong, F', 'Zhong, F.'],
    ['{van der Berg}, J. -P.', 'van der Berg, J.-P.'], ['Dupont, Jean-Pierre', 'Dupont, J.-P.'], ['Smith, Mary Ann', 'Smith, M. A.'],
    ['Ivanov, Yu. N.', 'Ivanov, Yu. N.'], ['Fangxiong Zhong', 'Zhong, F.'], ['Jane Q. Doe', 'Doe, J. Q.'],
    ['Ludwig van Beethoven', 'van Beethoven, L.'], ['Smith, Jr., John', 'Smith, F.'.replace('F.', 'J.') + ', Jr.'],
    ['{LIGO Scientific Collaboration}', 'LIGO Scientific Collaboration'], ['{The {Fermi}-LAT Collaboration}', 'The Fermi-LAT Collaboration'],
    ['{M{\\"u}ller}, J{\\"o}rg', 'Müller, J.'], ['{{\\O}stergaard}, Ren{\\\'e}e', 'Østergaard, R.'], ['{\\"O}zel, F.', 'Özel, F.'],
    ['{Garc{\\\'\\i}a}, Jos{\\\'e}', 'García, J.'], ['{\\\'E}mile Durand', 'Durand, É.'], ['Plato', 'Plato'],
    ['{Zhong}, 方雄', 'Zhong, 方雄'], ['{García}, José', 'García, J.'], ['{Łukasz}, K.', 'Łukasz, K.'], ['Zhong, F.~X.', 'Zhong, F. X.'],
  ];
  for (const [input, want] of cases) {
    test(`formatAuthor ${JSON.stringify(input)} → ${JSON.stringify(want)}`, () => assert.equal(formatAuthor(input), want));
  }

  test('parseAuthors: "and others" → et al.; collaborations stay whole', () => {
    assert.deepEqual(parseAuthors('{Zhong}, F. and {LIGO Scientific Collaboration} and {Virgo Collaboration} and others'),
      ['Zhong, F.', 'LIGO Scientific Collaboration', 'Virgo Collaboration', 'et al.']);
    assert.deepEqual(parseAuthors('{{LIGO Scientific Collaboration} and {Virgo Collaboration}}'), ['LIGO Scientific Collaboration and Virgo Collaboration'],
      'a single braced group is one corporate author');
  });

  test('initialsOf', () => {
    assert.equal(initialsOf('Fangxiong'), 'F.');
    assert.equal(initialsOf('J. -P.'), 'J.-P.');
    assert.equal(initialsOf('jean - pierre'), 'J.-P.');
    assert.equal(initialsOf(''), '');
    assert.equal(initialsOf('Émile'), 'É.');
  });
});

describe('BibTeX: journals and identifiers', () => {
  test('journal macros', () => {
    for (const [m, name] of [['\\apj', 'ApJ'], ['\\apjl', 'ApJL'], ['\\apjs', 'ApJS'], ['\\aj', 'AJ'], ['\\mnras', 'MNRAS'], ['\\aap', 'A&A'],
      ['\\pasp', 'PASP'], ['\\nat', 'Nature'], ['\\araa', 'ARA&A'], ['\\prd', 'Phys. Rev. D'], ['\\jcap', 'JCAP'], ['{\\apj}', 'ApJ'], [' \\MNRAS ', 'MNRAS']]) {
      assert.equal(journalName(m), name, m);
    }
    assert.equal(journalName('\\unknownmacro'), 'unknownmacro');
    assert.equal(journalName('{Physical Review D}'), 'Physical Review D');
    assert.equal(journalName('Astron. \\& Astrophys.'), 'Astron. & Astrophys.');
    assert.ok(Object.keys(JOURNAL_MACROS).length > 40);
  });

  test('normalizeArxiv / normalizeDoi / normalizeAdsBibcode / isBibcode', () => {
    assert.equal(normalizeArxiv('arXiv:2603.01234v2'), '2603.01234');
    assert.equal(normalizeArxiv('https://arxiv.org/abs/2603.01234'), '2603.01234');
    assert.equal(normalizeArxiv('https://arxiv.org/pdf/2603.01234v3.pdf'), '2603.01234');
    assert.equal(normalizeArxiv('astro-ph/0601001v1'), 'astro-ph/0601001');
    assert.equal(normalizeArxiv(' 1501.0001 '), '1501.0001');
    assert.equal(normalizeArxiv(''), '');
    assert.equal(normalizeDoi('https://doi.org/10.3847/1538-4357/ad0b1c'), '10.3847/1538-4357/ad0b1c');
    assert.equal(normalizeDoi('doi:10.1051/0004-6361/202245000'), '10.1051/0004-6361/202245000');
    assert.equal(normalizeDoi('https://dx.doi.org/10.1000/a%3Cb%3E'), '10.1000/a<b>');
    assert.equal(normalizeAdsBibcode('https://ui.adsabs.harvard.edu/abs/2023A%26A...671A..42Z/abstract'), '2023A&A...671A..42Z');
    assert.equal(normalizeAdsBibcode('2024ApJ...960..101Z'), '2024ApJ...960..101Z');
    for (const b of ['2024ApJ...960..101Z', '2023A&A...671A..42Z', '2026arXiv260301234Z', '2017PhRvL.119p1101A', '2030PhDT.........1Z']) assert.ok(isBibcode(b), b);
    for (const b of ['zhong2026', '2024ApJ...960..101', 'not a bibcode at all!']) assert.ok(!isBibcode(b), b);
  });
});

describe('BibTeX: bibToPublication', () => {
  const [apj, mnras, aa, preprint, proc, thesis] = parseBibtex(ADS_EXPORT).entries.map(bibToPublication);

  test('ApJ article: every field', () => {
    const { bibtex, ...rest } = apj;
    assert.deepEqual(rest, {
      title: 'Hydrostatic Equilibrium of H I Gas in Dark Galaxies at $z\\sim 0.1$',
      authors: ['Zhong, F.', 'Müller, J.', 'van der Berg, J.-P.', 'Østergaard, R.', 'LIGO Scientific Collaboration', 'et al.'],
      year: 2024, month: 1, venue: 'ApJ', volume: '960', pages: '101', status: 'published', kind: 'refereed',
      arxiv: '2310.01234', ads: '2024ApJ...960..101Z', doi: '10.3847/1538-4357/ad0b1c', key: '2024ApJ...960..101Z',
    });
    assert.ok(bibtex.startsWith('@ARTICLE{2024ApJ...960..101Z,\n       author = {{Zhong}') && bibtex.endsWith('System}\n}'), 'raw kept verbatim');
  });

  test('MNRAS letter, A&A (eid pages, %26 in adsurl), arXiv preprint, proceedings, thesis', () => {
    assert.equal(mnras.venue, 'MNRAS');
    assert.equal(mnras.pages, 'L12-L17');
    assert.equal(mnras.title, 'The JWST view of HII regions – a letter');
    assert.deepEqual(mnras.authors, ['Zhong, F.', 'García, J.', 'Košić, A.']);
    assert.equal(mnras.arxiv, '');
    assert.equal(aa.venue, 'A&A');
    assert.equal(aa.ads, '2023A&A...671A..42Z');
    assert.equal(aa.pages, 'A42');
    assert.equal(aa.title, 'Gas kinematics in M 33 at 10% precision');
    assert.deepEqual(aa.authors, ['Zhong, F.', 'Straßer, M.', 'Łukasz, K.']);
    assert.deepEqual([preprint.kind, preprint.status, preprint.venue, preprint.arxiv, preprint.pages, preprint.title],
      ['preprint', 'submitted', 'arXiv e-prints', '2603.01234', '', 'A Preprint: Using JWST & ALMA']);
    assert.deepEqual([proc.kind, proc.status, proc.venue, proc.pages, proc.month], ['proceedings', 'published', 'Galaxies Near and Far', '123-126', null]);
    assert.deepEqual(proc.authors, ['Zhong, F.'], 'editor is not an author');
    assert.deepEqual([thesis.kind, thesis.venue, thesis.year, thesis.ads], ['thesis', 'University of California', 2030, '2030PhDT.........1Z']);
  });

  test('arXiv export (no ADS fields, "First Last" names, eprint with version)', () => {
    const p = bibToPublication(parseBibtex(ARXIV_EXPORT).entries[0]);
    assert.deepEqual([p.kind, p.status, p.arxiv, p.ads, p.venue, p.year], ['preprint', 'submitted', '2603.01234', '', '', 2026]);
    assert.deepEqual(p.authors, ['Zhong, F.', 'Doe, J. Q.', 'van Beethoven, L.']);
    assert.equal(p.title, 'Hydrostatic equilibrium of neutral hydrogen in dark galaxies');
    assert.equal(publicationIdFor(p), 'arxiv-2603-01234');
  });

  test('month variants; non-ASCII authors written directly', () => {
    const mk = (month) => bibToPublication({ type: 'article', key: 'k', fields: { title: 't', month, year: '2020' }, raw: '' }).month;
    assert.equal(mk('{March}'), 3);
    assert.equal(mk('11'), 11);
    assert.equal(mk('Sept.'), 9);
    assert.equal(mk('13'), null);
    assert.equal(mk('{spring}'), null);
    const p = bibToPublication(parseBibtex('@article{k, author = {{Zhong}, 方雄 and {García}, José and {Łukasz}, K.}, title={中文 标题}, year={2025}}').entries[0]);
    assert.deepEqual(p.authors, ['Zhong, 方雄', 'García, J.', 'Łukasz, K.']);
    assert.equal(p.title, '中文 标题');
  });
});

describe('ids', () => {
  test('isValidId / slugId / uniqueId', () => {
    assert.ok(isValidId('2024apj-960-101z'));
    assert.ok(!isValidId('-x') && !isValidId('A') && !isValidId('a b') && !isValidId('') && !isValidId('a'.repeat(81)));
    assert.equal(slugId('Østergaard Straße Æon'), 'ostergaard-strasse-aeon');
    assert.equal(slugId('中文'), '');
    assert.equal(uniqueId('a', ['a', 'A-2']), 'a-3');
    assert.equal(uniqueId('', []), 'item');
  });

  test('publicationIdFor: bibcode → arXiv → author+year+word; unique', () => {
    assert.equal(publicationIdFor({ ads: '2024ApJ...960..101Z' }), '2024apj-960-101z');
    assert.equal(publicationIdFor({ ads: '2023A&A...671A..42Z' }), '2023a-a-671a-42z');
    assert.equal(publicationIdFor({ ads: 'not-bibcode', arxiv: 'arXiv:2603.01234v1' }), 'arxiv-2603-01234');
    assert.equal(publicationIdFor({ authors: ['van der Berg, J.'], year: 2025, title: 'On the Dark Galaxies' }), 'vanderberg2025dark');
    assert.equal(publicationIdFor({ authors: [], title: '中文' }), 'paper');
    assert.equal(publicationIdFor({ ads: '2024ApJ...960..101Z' }, ['2024apj-960-101z']), '2024apj-960-101z-2');
  });

  test('talkIdFor / newsIdFor', () => {
    assert.equal(talkIdFor({ date: '2026-01-08', event: 'AAS 247', title: 'x' }), '2026-01-08-aas-247');
    assert.equal(talkIdFor({ date: 'bad', title: 'Dark galaxies' }), 'dark-galaxies');
    assert.equal(talkIdFor({ date: '2026-01-08', event: '天文年会' }), '2026-01-08-talk');
    assert.equal(newsIdFor({ date: '2026-11-02', text: 'Our paper was **accepted** by [ApJ](https://x)!' }), '2026-11-02-our-paper-was-accepted-by-apj');
    assert.equal(newsIdFor({ date: '2026-11-02', text: '论文被接收了', text_en: 'Paper accepted' }), '2026-11-02-paper-accepted');
    assert.equal(newsIdFor({ date: '2026-11-02', text: '论文被接收了' }, ['2026-11-02-news']), '2026-11-02-news-2');
  });

  test('idFromPath', () => {
    assert.equal(idFromPath('data/publications/abc.yaml', 'data/publications'), 'abc');
    assert.equal(idFromPath('data/publications/abc.YML', 'data/publications'), 'abc');
    assert.equal(idFromPath('data/publications/README.md', 'data/publications'), null);
    assert.equal(idFromPath('data/publications/sub/x.yaml', 'data/publications'), null);
    assert.equal(idFromPath('data/talks/x.yaml', 'data/publications'), null);
  });
});

describe('dates', () => {
  test('todayISO / isIsoDate / dateString', () => {
    assert.equal(todayISO(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
    assert.ok(isIsoDate('2024-02-29'));
    assert.ok(!isIsoDate('2023-02-29') && !isIsoDate('2026-13-01') && !isIsoDate('2026-1-1') && !isIsoDate(''));
    assert.equal(dateString('2026-3-5'), '2026-03-05');
    assert.equal(dateString(new Date(Date.UTC(2026, 2, 5))), '2026-03-05');
    assert.equal(dateString('2026-03-05T10:00:00Z'), '2026-03-05');
    assert.equal(dateString('soon'), 'soon');
  });
});

describe('YAML writer', () => {
  const pub = {
    id: '2024apj-960-101z', title: 'A "quoted" title: with # hash, \\ backslash and $z\\sim 6$', authors: ['Zhong, F.', 'Müller, J.', 'et al.'],
    year: '2024', month: '1', venue: 'ApJ', volume: '960', pages: '101', status: 'published', kind: 'refereed', selected: true,
    arxiv: '', ads: '2024ApJ...960..101Z', doi: '10.3847/x', pdf: '/documents/papers/zhong-2024.pdf', code: '', slides: '', note: 'line 1\nline 2',
    bibtex: '@ARTICLE{k,\n   title = {x}\n}\n\n',
  };

  test('new file: exact text (order, quoting, block list, |- blocks, empty fields dropped)', () => {
    assert.equal(entryFileText('publications', pub), [
      'id: "2024apj-960-101z"',
      'title: "A \\"quoted\\" title: with # hash, \\\\ backslash and $z\\\\sim 6$"',
      'authors:',
      '  - "Zhong, F."',
      '  - "Müller, J."',
      '  - "et al."',
      'year: 2024',
      'month: 1',
      'venue: "ApJ"',
      'volume: "960"',
      'pages: "101"',
      'status: "published"',
      'kind: "refereed"',
      'selected: true',
      'ads: "2024ApJ...960..101Z"',
      'doi: "10.3847/x"',
      'pdf: "/documents/papers/zhong-2024.pdf"',
      'note: |-',
      '  line 1',
      '  line 2',
      'bibtex: |-',
      '  @ARTICLE{k,',
      '     title = {x}',
      '  }',
      '',
    ].join('\n'));
  });

  test('round trip through js-yaml (what Hugo reads) equals cleanEntry', () => {
    const text = entryFileText('publications', pub);
    assert.deepEqual(loadCore(text), cleanEntry('publications', pub));
    assert.deepEqual(yaml.load(text), cleanEntry('publications', pub), 'default schema too');
  });

  test('tricky strings: leading - / @ / *, yes/no/null, numbers as strings, unicode separators, tabs in blocks', () => {
    const vals = { date: '2026-01-02', text: '- starts with dash', text_en: 'yes', text_zh: '@at *star null 007 \u2028 sep', link: '#anchor' };
    const t = entryFileText('news', vals);
    assert.deepEqual(loadCore(t), vals);
    const tabbed = entryFileText('talks', { id: 'x', title: 't', date: '2026-01-02', kind: 'talk', abstract: 'a\n\tb' });
    assert.match(tabbed, /^abstract: "a\\n\\tb"$/m, 'tabs → quoted instead of a block');
    assert.equal(loadCore(tabbed).abstract, 'a\n\tb');
    const lead = entryFileText('talks', { id: 'x', title: 't', date: '2026-01-02', abstract: ' indented first\nline' });
    assert.equal(loadCore(lead).abstract, ' indented first\nline', 'a leading space is content: kept, written quoted');
    assert.match(lead, /^abstract: " indented first\\nline"$/m);
    const blank = entryFileText('talks', { id: 'x', title: 't', date: '2026-01-02', abstract: 'p1\n\np2' });
    assert.match(blank, /abstract: \|-\n {2}p1\n\n {2}p2\n/);
    assert.equal(loadCore(blank).abstract, 'p1\n\np2');
  });

  test('cleanEntry: types and empties', () => {
    assert.deepEqual(cleanEntry('publications', { title: ' T ', authors: 'A\n\n B ', year: ' 2020 ', month: '', selected: false, arxiv: '  ' }),
      { title: 'T', authors: ['A', 'B'], year: 2020 });
    assert.deepEqual(cleanEntry('publications', { year: 'abc', selected: 'true' }), { selected: true });
    assert.deepEqual(Object.keys(cleanEntry('talks', { note: 'n', id: 'i', title: 't', date: '2026-01-01' })), ['id', 'title', 'date', 'note']);
  });

  test('editing a file written by the admin rewrites it canonically and keeps unknown keys', () => {
    const v1 = entryFileText('publications', pub);
    const withExtra = v1 + 'award: "Best paper"\n';
    const v2 = entryFileText('publications', { ...pub, title: 'New title', selected: false }, withExtra);
    const data = loadCore(v2);
    assert.equal(data.title, 'New title');
    assert.equal(data.selected, undefined);
    assert.equal(data.award, 'Best paper', 'unknown key kept');
    assert.ok(v2.endsWith('award: "Best paper"\n'), 'unknown keys after the known ones');
    assert.equal(entryFileText('publications', pub, v1), v1, 'no change → identical text');
  });

  test('editing a hand-written file only touches the changed keys (comments kept)', () => {
    const hand = [
      '# my favourite paper',
      'id: dark',
      'title: Old title   # keep this comment',
      'authors: [Zhong, F., "Doe, J."]',
      'year: 2024',
      'date_added: 2026-01-01',
      'selected: false',
      '',
    ].join('\n');
    const values = formValues('publications', loadCore(hand));
    assert.deepEqual(values.authors, ['Zhong', 'F.', 'Doe, J.'], 'flow list as YAML reads it');
    const out = entryFileText('publications', { ...values, title: 'New title', venue: 'ApJ' }, hand);
    assert.ok(out.startsWith('# my favourite paper\nid: dark\ntitle: "New title"   # keep this comment\nauthors: [Zhong, F., "Doe, J."]\nyear: 2024\n'), out);
    assert.ok(out.includes('date_added: 2026-01-01'), 'unknown keys untouched');
    assert.ok(out.includes('selected: false'), 'selected: false is not removed just because the form omits false');
    assert.ok(/venue: "ApJ"\n$/.test(out), 'new key appended');
    assert.equal(entryFileText('publications', values, hand), hand, 'no change → byte-identical');
    // removing a value deletes only that line
    const out2 = entryFileText('publications', { ...values, year: '' }, hand);
    assert.ok(!/^year:/m.test(out2) && out2.includes('# my favourite paper'));
  });

  test('a hand-written file with quoted numbers / unquoted dates does not produce spurious changes', () => {
    const hand = 'id: t\ntitle: Talk\ndate: 2026-03-05\nkind: talk\n';
    assert.equal(entryFileText('talks', formValues('talks', loadCore(hand)), hand), hand);
    const pubHand = 'id: p\ntitle: P\nyear: "2024"\nauthors:\n- A\n';
    assert.equal(entryFileText('publications', formValues('publications', loadCore(pubHand)), pubHand), pubHand);
  });

  test('dumpYaml rejects odd keys and lone surrogates; parseYamlEntry errors are Chinese', () => {
    assert.throws(() => dumpYaml({ 'bad key': 'x' }), AcademicDataError);
    assert.throws(() => dumpYaml({ a: 'x\uD800' }), AcademicDataError);
    assert.throws(() => parseYamlEntry('a: [unclosed'), (e) => e instanceof AcademicDataError && /第 \d+ 行/.test(e.message));
    assert.throws(() => parseYamlEntry('- a list'), AcademicDataError);
    assert.deepEqual(parseYamlEntry(''), {});
    assert.equal(dumpYaml({}), '\n');
  });

  test('formValues fills every field', () => {
    const v = formValues('talks', { title: 'T', date: '2026-3-5' });
    assert.deepEqual(Object.keys(v), [...FIELD_ORDER.talks]);
    assert.equal(v.date, '2026-03-05');
    assert.equal(v.video, '');
    assert.deepEqual(formValues('publications', { authors: 'Solo, A.' }).authors, ['Solo, A.']);
    assert.equal(formValues('publications', {}).selected, false);
  });

  test('field order matches the data contract', () => {
    assert.deepEqual([...FIELD_ORDER.news], ['date', 'text', 'text_en', 'text_zh', 'link']);
    assert.equal(SECTIONS.publications.dataDir, 'data/publications');
    assert.equal(SECTIONS.talks.uploadDir, 'static/documents/talks');
  });
});

describe('sorting and grouping', () => {
  const pubs = [
    { id: 'a', title: 'A', year: 2024, month: 3, kind: 'refereed', status: 'published' },
    { id: 'b', title: 'B', year: 2025, month: 1, kind: 'refereed', status: 'accepted' },
    { id: 'c', title: 'C', year: 2026, kind: 'preprint', status: 'submitted' },
    { id: 'd', title: 'D', kind: 'refereed', status: 'in-prep' },
    { id: 'e', title: 'E', year: 2024, month: 3, kind: 'proceedings' },
    { id: 'f', title: 'F', year: 2023, venue: 'arXiv e-prints' },
    { id: 'g', title: 'G', year: 2023, venue: 'ApJ' },
  ];
  test('groupBy kind: refereed / pending / other like the site', () => {
    const g = groupPublications(pubs, 'kind');
    assert.deepEqual(g.map((x) => [x.key, x.label, x.items.map((p) => p.id)]), [
      ['refereed', '同行评审', ['b', 'a', 'g']],
      ['pending', '已投稿与准备中', ['d', 'c']],
      ['other', '会议论文与其他', ['e', 'f']],
    ]);
    assert.equal(pubGroupOf({ venue: 'arXiv e-prints' }), 'other');
    assert.equal(pubGroupOf({}), 'refereed');
  });
  test('groupBy year: undated first, then newest', () => {
    const g = groupPublications(pubs, 'year');
    assert.deepEqual(g.map((x) => [x.key, x.items.map((p) => p.id)]), [['', ['d']], ['2026', ['c']], ['2025', ['b']], ['2024', ['a', 'e']], ['2023', ['f', 'g']]]);
    assert.equal(g[0].label, '年份未填');
    assert.deepEqual(groupPublications([], 'kind'), []);
  });
  test('splitTalks / sortNews', () => {
    const talks = [{ id: '1', date: '2026-01-01' }, { id: '2', date: '2026-11-02' }, { id: '3', date: '2027-01-01' }, { id: '4', date: '2025-05-05' }];
    const { upcoming, past } = splitTalks(talks, '2026-11-02');
    assert.deepEqual(upcoming.map((t) => t.id), ['2', '3']);
    assert.deepEqual(past.map((t) => t.id), ['1', '4']);
    assert.deepEqual(sortNews([{ id: 'a', date: '2026-01-01' }, { id: 'c', date: '2026-02-01' }, { id: 'b', date: '2026-02-01' }]).map((n) => n.id), ['c', 'b', 'a']);
  });
  test('isMyName', () => {
    const my = ['Zhong, F.', 'Zhong, Fangxiong'];
    assert.ok(isMyName('Zhong, F.', my));
    assert.ok(isMyName('zhong,  f', my));
    assert.ok(isMyName('ZHONG, Fangxiong', my));
    assert.ok(!isMyName('Zhong, X.', my));
    assert.ok(!isMyName('', my));
    assert.ok(isMyName('Müller, J.', ['Muller, J.']), 'accents ignored');
  });
});

describe('social links (首页设置)', () => {
  test('normalizeSocialUrl', () => {
    const cases = [
      ['orcid', '0000-0002-1825-0097', 'https://orcid.org/0000-0002-1825-0097'],
      ['orcid', '0000000218250097', 'https://orcid.org/0000-0002-1825-0097'],
      ['orcid', 'orcid.org/0000-0002-1694-233x', 'https://orcid.org/0000-0002-1694-233X'],
      ['orcid', 'https://orcid.org/0000-0002-1825-0097', 'https://orcid.org/0000-0002-1825-0097'],
      ['googlescholar', 'AbCdEfGAAAAJ', 'https://scholar.google.com/citations?user=AbCdEfGAAAAJ'],
      ['googlescholar', 'user=AbCdEfGAAAAJ', 'https://scholar.google.com/citations?user=AbCdEfGAAAAJ'],
      ['googlescholar', 'scholar.google.com/citations?user=x', 'https://scholar.google.com/citations?user=x'],
      ['ads', 'Zhong, F.', 'https://ui.adsabs.harvard.edu/search/q=author%3A%22Zhong%2C%20F.%22&sort=date%20desc'],
      ['ads', 'https://ui.adsabs.harvard.edu/public-libraries/abc', 'https://ui.adsabs.harvard.edu/public-libraries/abc'],
      ['arxiv', 'zhong_f_1', 'https://arxiv.org/a/zhong_f_1'],
      ['arxiv', 'arxiv.org/a/zhong_f_1', 'https://arxiv.org/a/zhong_f_1'],
      ['bluesky', '@me.bsky.social', 'https://bsky.app/profile/me.bsky.social'],
      ['mastodon', '@me@astrodon.social', 'https://astrodon.social/@me'],
      ['linkedin', 'in/fangxiong-zhong', 'https://www.linkedin.com/in/fangxiong-zhong'],
      ['linkedin', 'fangxiong-zhong', 'https://www.linkedin.com/in/fangxiong-zhong'],
      ['researchgate', 'Fangxiong-Zhong', 'https://www.researchgate.net/profile/Fangxiong-Zhong'],
      ['email', 'me@example.org', 'mailto:me@example.org'],
      ['github', 'github.com/me', 'https://github.com/me'],
      ['cv', ' /documents/cv/cv.pdf ', '/documents/cv/cv.pdf'],
      ['zhihu', ' https://x ', 'https://x'],
      ['orcid', 'not an id', 'not an id'],
    ];
    for (const [name, input, want] of cases) assert.equal(normalizeSocialUrl(name, input), want, `${name} ${input}`);
  });
  test('ORCID checksum and warnings', () => {
    assert.ok(orcidChecksumOk('0000-0002-1825-0097'));
    assert.ok(orcidChecksumOk('0000-0002-1694-233X'));
    assert.ok(!orcidChecksumOk('0000-0002-1825-0098'));
    assert.equal(socialUrlWarning('orcid', 'https://orcid.org/0000-0002-1825-0097'), null);
    assert.match(socialUrlWarning('orcid', 'https://orcid.org/0000-0002-1825-0098'), /校验位/);
    assert.match(socialUrlWarning('orcid', 'https://example.com'), /orcid\.org/);
    assert.match(socialUrlWarning('googlescholar', 'https://example.com'), /scholar/);
    assert.equal(socialUrlWarning('googlescholar', 'https://scholar.google.com/citations?user=x'), null);
    assert.equal(socialUrlWarning('ads', 'https://ui.adsabs.harvard.edu/x'), null);
    assert.match(socialUrlWarning('arxiv', 'https://example.com'), /arxiv/);
    assert.equal(socialUrlWarning('cv', '/documents/cv/x.pdf'), null);
    assert.equal(socialUrlWarning('github', 'https://anything'), null);
    assert.ok(SOCIAL_HINTS.orcid && SOCIAL_HINTS.ads && SOCIAL_HINTS.arxiv);
  });
});

describe('menu helpers', () => {
  test('menuWithoutMain', () => {
    assert.equal(menuWithoutMain('main'), undefined);
    assert.equal(menuWithoutMain(['main']), undefined);
    assert.deepEqual(menuWithoutMain(['main', 'footer']), ['footer']);
    assert.equal(menuWithoutMain({ main: { weight: 10 } }), undefined);
    assert.deepEqual(menuWithoutMain({ main: { weight: 10 }, footer: {} }), { footer: {} });
    assert.equal(menuWithoutMain(undefined), undefined);
  });
  test('nextMenuWeight', () => {
    assert.equal(nextMenuWeight([]), 10);
    assert.equal(nextMenuWeight([20, 40, 30]), 50);
    assert.equal(nextMenuWeight([45]), 50);
    assert.equal(nextMenuWeight([null, 'x', 5]), 10);
  });
  test('academicIndexDocument', () => {
    const en = academicIndexDocument('talks', 'en', 50);
    const doc = splitDocument(en);
    assert.deepEqual(parseFrontMatter(doc.fmText), { title: 'Talks & Posters', description: 'Talks, posters and seminars.', menu: { main: { weight: 50 } } });
    assert.equal(doc.body, '');
    assert.deepEqual(parseFrontMatter(splitDocument(academicIndexDocument('news', 'zh')).fmText), { title: '近况', description: '最近的动态。' });
    assert.equal(parseFrontMatter(splitDocument(academicIndexDocument('publications', 'fr', 10)).fmText).title, 'Publications');
  });
});

describe('hostile input (verifier regressions)', () => {
  const EVIL = String.raw`@ARTICLE{evil</script>,
  author = {{Zhong}, F. and {<img src=x onerror=alert(1)>}, A.},
  title = "{</script><script>alert(1)</script>}",
  journal = {javascript:alert(1)},
  year = {2025},
  doi = {javascript:alert(1)},
  adsurl = {javascript:alert(1)},
  eprint = {javascript:alert(1)},
  url = {javascript:alert(1)},
}`;

  test('BibTeX: identifiers that are not identifiers are dropped (no javascript: arxiv / doi / ads, no arxiv-javascript-… id)', () => {
    const [e] = parseBibtex(EVIL).entries;
    const p = bibToPublication(e);
    assert.equal(p.arxiv, '');
    assert.equal(p.doi, '');
    assert.equal(p.ads, '');
    assert.ok(!publicationIdFor(p).startsWith('arxiv-'), publicationIdFor(p));
    assert.ok(isValidId(publicationIdFor(p)));
    // text fields stay text: written as quoted YAML, read back identical (the site escapes them)
    const text = entryFileText('publications', { ...p, id: 'evil', year: String(p.year) });
    const back = parseYamlEntry(text);
    assert.equal(back.title, '</script><script>alert(1)</script>');
    assert.deepEqual(back.authors, ['Zhong, F.', '<img src=x onerror=alert(1)>, A.']);
    assert.equal(back.arxiv, undefined);
  });

  test('BibTeX: real identifiers still pass (ADS URL with %26, arXiv old style, DOI)', () => {
    const [e] = parseBibtex('@article{k, title={T}, author={A, B.}, year=2023, eprint={astro-ph/0601001}, doi={10.1051/0004-6361/202245000},'
      + ' adsurl={https://ui.adsabs.harvard.edu/abs/2023A%26A...671A..42Z}}').entries;
    const p = bibToPublication(e);
    assert.deepEqual([p.arxiv, p.doi, p.ads], ['astro-ph/0601001', '10.1051/0004-6361/202245000', '2023A&A...671A..42Z']);
  });

  test('identifierError: ids, URLs and empty pass; junk and javascript: do not', () => {
    for (const [f, v] of [['arxiv', ''], ['arxiv', '2603.01234'], ['arxiv', 'arXiv:2603.01234v2'], ['arxiv', 'https://arxiv.org/abs/2603.01234'],
      ['ads', '2024ApJ...960..101Z'], ['ads', 'https://ui.adsabs.harvard.edu/abs/2023A%26A...671A..42Z/abstract'],
      ['doi', '10.3847/1538-4357/ad0b1c'], ['doi', 'doi:10.3847/x'], ['doi', 'https://doi.org/10.3847/x']]) {
      assert.equal(identifierError(f, v), null, `${f} ${v}`);
    }
    for (const [f, v] of [['arxiv', 'javascript:alert(1)'], ['arxiv', 'see paper'], ['ads', 'javascript:alert(1)'], ['ads', 'Zhong 2024'],
      ['doi', 'javascript:alert(1)'], ['doi', 'not-a-doi'], ['doi', 'https://example.org/x']]) {
      assert.match(identifierError(f, v) || '', /./, `${f} ${v}`);
    }
    assert.ok(isArxivId('2603.01234') && !isArxivId('2603.01234v2') && isDoi('10.1000/x') && !isDoi('10.1/x'));
    assert.ok(isHttpUrl('https://a.org/x?y=1&z=2') && !isHttpUrl('https://a.org/"x') && !isHttpUrl('javascript:alert(1)'));
  });

  test('BibTeX: 5000 authors parse and write quickly', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `{Author${i}}, X.`).join(' and ');
    const t0 = Date.now();
    const [e] = parseBibtex(`@misc{big, author = {${many}}, title = {Huge}, year = 2024}`).entries;
    const p = bibToPublication(e);
    const text = entryFileText('publications', { ...p, id: 'big', year: '2024' });
    assert.equal(p.authors.length, 5000);
    assert.equal(parseYamlEntry(text).authors.length, 5000);
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  });

  test('YAML: form values with newlines, quotes, colons, --- and odd unicode round-trip as data (never become keys)', () => {
    const nasty = ['line1\n---\nkey: injected', 'a: b # c', '"q" \'s\'', '---', '- x', '{ a: 1 }', 'tab\there', 'yes', 'null', '~', '2024-01-01',
      'ls\u2028ps\u2029bom\ufeff', 'nul\u0000', ' lead\nnext', 'trail \nnext', '...', '#hash'];
    for (const t of nasty) {
      const text = entryFileText('publications', { id: 'x', title: t, authors: [t, 'B, C.'], year: '2024', note: t, venue: t });
      const back = parseYamlEntry(text);
      assert.deepEqual(Object.keys(back), ['id', 'title', 'authors', 'year', 'venue', 'note'], JSON.stringify(t));
      assert.equal(back.title, t.trim());
      assert.deepEqual(back.authors, [t.trim(), 'B, C.']);
    }
  });

  test('YAML: editing a hand-written file keeps comments and unknown keys', () => {
    const hand = '# my paper\nid: hand\ntitle: Old title   # keep me\nauthors: [ "A, B." ]\nyear: 2020\ncustom_field: {nested: [1, 2]}\nanother: "x"\n';
    const out = entryFileText('publications', { id: 'hand', title: 'New: title\n---', authors: ['A, B.'], year: '2020', note: 'n' }, hand);
    assert.ok(out.startsWith('# my paper\n'), out);
    assert.match(out, /^title: "New: title\\n---" {3}# keep me$/m);
    const back = parseYamlEntry(out);
    assert.deepEqual(back.custom_field, { nested: [1, 2] });
    assert.equal(back.another, 'x');
    assert.equal(back.note, 'n');
  });
});
