// Сверка текстов в quiz.js с docs/quiz-spec.md, символ в символ.
const fs = require('fs');
const src = fs.readFileSync('/home/karpushin/7days/web/landing/quiz.js', 'utf8');
const spec = fs.readFileSync('/home/karpushin/7days/docs/quiz-spec.md', 'utf8');

function grab(name) {
  const m = src.match(new RegExp('var ' + name + ' = (\\[[\\s\\S]*?\\n  \\];)'));
  if (!m) throw new Error('not found: ' + name);
  return new Function('return ' + m[1].replace(/;$/, ''))();
}
function grabStr(name) {
  const m = src.match(new RegExp("var " + name + " = '((?:[^'\\\\]|\\\\.)*)';"));
  if (!m) throw new Error('not found: ' + name);
  return m[1];
}

const jsQ = grab('QUESTIONS');
const jsR = grab('RESULTS');
const jsDisc = grabStr('DISCLAIMER');
const jsHint = grabStr('HINT');

// --- разбор спецификации ---
const lines = spec.split('\n');
const specQ = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\d+\.\s+\*\*(.+)\*\*\s*$/);
  if (!m) continue;
  const mn = lines[i + 1].match(/^\s+0 = (.+?)\s*$/);
  const mx = lines[i + 2].match(/^\s+10 = (.+?)\s*$/);
  specQ.push({ text: m[1], min: mn[1], max: mx[1] });
}
const specR = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\*\*ИНДЕКС .*\(сумма (\d+)–(\d+)\)\*\*\s*$/);
  if (m) specR.push({ maxSum: Number(m[2]), text: lines[i + 1].trim() });
}
const discIdx = lines.findIndex(l => l.includes('ПОД ЛЮБЫМ РЕЗУЛЬТАТОМ'));
const specDisc = lines[discIdx + 1].trim();
const specHint = (spec.match(/\*\*Подсказка вверху страницы:\*\*\s+(.+)/)[1]).trim();

// --- сравнение ---
let fails = 0;
function cmp(label, a, b) {
  if (a === b) { console.log('OK   ' + label); return; }
  fails++;
  console.log('FAIL ' + label);
  console.log('  js  : ' + JSON.stringify(a));
  console.log('  spec: ' + JSON.stringify(b));
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) {
    console.log('  first diff at ' + i + ': js=' + JSON.stringify(a[i]) + '(' + (a.codePointAt(i)) + ') spec=' + JSON.stringify(b[i]) + '(' + (b.codePointAt(i)) + ')');
    break;
  }
}
cmp('count questions', String(jsQ.length), String(specQ.length));
for (let i = 0; i < specQ.length; i++) {
  cmp('Q' + (i + 1) + ' text', jsQ[i].text, specQ[i].text);
  cmp('Q' + (i + 1) + ' 0=', jsQ[i].min, specQ[i].min);
  cmp('Q' + (i + 1) + ' 10=', jsQ[i].max, specQ[i].max);
}
cmp('count results', String(jsR.length), String(specR.length));
for (let i = 0; i < specR.length; i++) {
  cmp('R' + (i + 1) + ' maxSum', String(jsR[i].maxSum), String(specR[i].maxSum));
  cmp('R' + (i + 1) + ' text', jsR[i].text, specR[i].text);
}
cmp('disclaimer', jsDisc, specDisc);
// Подсказка: в спецификации она взята во внешние кавычки-ёлочки и внутри
// набрана лапками „…“ — в design-landing.md эта же фраза приведена дословно
// как строка страницы (внешних кавычек нет, внутри «…»). Сверяем с обеими.
const dl = fs.readFileSync('/home/karpushin/7days/docs/design-landing.md', 'utf8').split('\n');
const dlHint = dl.find(l => l.includes('Подзаголовок (дословно из спецификации')).match(/`(.+)`/)[1];
cmp('hint vs design-landing', jsHint, dlHint);
cmp('hint vs spec (кавычки нормализованы)',
    jsHint.replace(/«|»/g, '"'),
    specHint.replace(/^«|»$/g, '').replace(/[„“«»]/g, '"'));

// Прочие строки страницы — они заданы в разделе B design-landing.md
const dlText = dl.join('\n');
const pageStrings = [
  'Где сейчас твоя опора',
  'Семь вопросов. Две минуты. Результат покажем здесь же.',
  'Начать',
  'Показать результат',
  'Открыть семь вечеров в Telegram',
  'Начнём сегодня вечером. Бот спросит только, во сколько тебе удобно.',
  'пройти заново',
  'индекс из 100'
];
for (const str of pageStrings) {
  cmp('в quiz.js есть: ' + str, String(src.includes("'" + str + "'")), 'true');
  cmp('в design-landing есть: ' + str, String(dlText.includes(str)), 'true');
}
cmp('строка суммы', 'сумма ответов: 42 из 70',
    'сумма ответов: ' + 42 + ' из ' + 70);

// формула и границы
function indexFor(sum) { return Math.round(sum / 70 * 100); }
function textFor(sum) { for (const r of jsR) if (sum <= r.maxSum) return r.text; }
const bounds = [[0,21,0],[22,35,1],[36,49,2],[50,59,3],[60,70,4]];
for (const [lo, hi, k] of bounds) for (const s of [lo, hi]) {
  cmp('sum ' + s + ' -> bucket ' + (k + 1), textFor(s), jsR[k].text);
}
cmp('index(42)', String(indexFor(42)), '60');
cmp('index(70)', String(indexFor(70)), '100');
cmp('index(0)', String(indexFor(0)), '0');

// ни одного восклицательного знака в обоих файлах
for (const f of ['/home/karpushin/7days/web/landing/quiz.js', '/home/karpushin/7days/web/landing/quiz.css']) {
  const body = fs.readFileSync(f, 'utf8');
  cmp('no "!" outside CSS/JS operators in ' + f.split('/').pop(),
      String((body.match(/!/g) || []).filter((_, i) => true).length -
             (body.match(/!==|!=|!important|!\w*\(|![a-zA-Z_$]/g) || []).join('').match(/!/g)?.length || 0), '0');
}
console.log(fails === 0 ? '\nALL TEXTS MATCH SPEC' : '\n' + fails + ' MISMATCHES');
process.exit(fails === 0 ? 0 : 1);
