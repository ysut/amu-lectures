import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { parseLecture, resolveAsset } from '../src/parser.js';

const parse = (src, opts = {}) => parseLecture(src, { Marked, ...opts });

test('single, multiple and flash questions', () => {
  const r = parse(`# 講義

説明文

## 正しいのはどれか。

- [ ] a
- [x] b
- [ ] c

### 解説
b が正しい。

## 2つ選べ。
- [x] one
- [x] two
- [ ] three

## 定義を答えよ。

### 解答
答え
`);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.title, '講義');
  assert.match(r.descriptionHtml, /説明文/);
  assert.deepEqual(
    r.questions.map((q) => q.type),
    ['single', 'multiple', 'flash'],
  );
  const [q1, q2, q3] = r.questions;
  assert.deepEqual(
    q1.choices.map((c) => c.correct),
    [false, true, false],
  );
  assert.match(q1.explanationHtml, /b が正しい/);
  assert.equal(q2.choices.filter((c) => c.correct).length, 2);
  assert.equal(q2.explanationHtml, '');
  assert.match(q3.explanationHtml, /答え/);
});

test('multi-line stem and explanation without heading', () => {
  const r = parse(`# T
## 28歳の女性。
検査所見：
- Hb 10

最も考えられるのはどれか。
- [ ] x
- [x] y

解説を直接書く。
`);
  assert.deepEqual(r.errors, []);
  const [q] = r.questions;
  assert.match(q.stemHtml, /28歳の女性/);
  assert.match(q.stemHtml, /<li>Hb 10<\/li>/);
  assert.match(q.stemHtml, /最も考えられる/);
  assert.equal(q.choices.length, 2);
  assert.match(q.explanationHtml, /解説を直接書く/);
});

test('lenient syntax: full-width marks, typed labels, question numbers', () => {
  const r = parse(`＃ 全角タイトル
＃＃ 問1. 問題文
- ［ ］ a. ちがう
- [ｘ] b. 正解
- [　] ③ ちがう
- [○] 1.5 kg
`);
  assert.deepEqual(r.errors, []);
  const [q] = r.questions;
  assert.equal(r.title, '全角タイトル');
  assert.equal(q.stemHtml.trim(), '<p>問題文</p>');
  assert.deepEqual(
    q.choices.map((c) => [c.html, c.correct]),
    [
      ['ちがう', false],
      ['正解', true],
      ['ちがう', false],
      ['1.5 kg', true],
    ],
  );
});

test('errors are reported with line numbers', () => {
  const r = parse(`# T

## 正解なし
- [ ] a
- [ ] b

## 選択肢1つ
- [x] a

## 選択肢も解答もない

##
- [x] a
- [ ] b
`);
  assert.deepEqual(
    r.errors.map((e) => e.line),
    [3, 8, 10, 12],
  );
  assert.equal(r.questions.length, 0);
});

test('file without questions is an error; missing title is a warning', () => {
  const r = parse('ただの文章');
  assert.equal(r.errors.length, 1);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.title, null);
});

test('stray choices after explanation produce a warning', () => {
  const r = parse(`# T
## Q
- [x] a
- [ ] b
文章
- [ ] c
`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].line, 6);
  assert.equal(r.questions[0].choices.length, 2);
});

test('headings inside code fences and comments are ignored', () => {
  const r = parse(`# T
<!--
## not a question
-->
## Q
- [x] a
- [ ] b

\`\`\`
## not a question either
- [x] nope
\`\`\`
`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.questions.length, 1);
  assert.match(r.questions[0].explanationHtml, /not a question either/);
});

test('stable and unique question keys', () => {
  const src = `# T\n## Q\n- [x] a\n- [ ] b\n## Q\n- [x] a\n- [ ] b\n`;
  const a = parse(src);
  const b = parse(`# Changed title\n${src.split('\n').slice(1).join('\n')}`);
  assert.equal(a.questions.length, 2);
  assert.notEqual(a.questions[0].key, a.questions[1].key);
  assert.deepEqual(
    a.questions.map((q) => q.key),
    b.questions.map((q) => q.key),
  );
  assert.equal(a.warnings.length, 1);
});

test('relative image paths are resolved against the lecture folder', () => {
  const r = parse(`# T\n## Q ![図](images/a.png)\n- [x] a\n- [ ] b\n`, { assetBase: 'q/02_婦人科腫瘍/' });
  assert.match(r.questions[0].stemHtml, /src="q\/02_%E5%A9%A6/);
  assert.equal(resolveAsset('https://example.com/a.png', 'q/x/'), 'https://example.com/a.png');
  assert.equal(resolveAsset('../shared/a.png', 'q/x/'), 'q/shared/a.png');
});

test('all files in questions/ parse without errors', async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'questions');
  const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith('.md') && !f.endsWith('README.md'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const r = parse(await readFile(path.join(root, f), 'utf8'));
    assert.deepEqual(r.errors, [], f);
  }
});
