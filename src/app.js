// Self-study quiz app. Plain ES modules, no framework, hash-based routing
// (works on GitHub Pages without any server configuration).

import { initAuth } from './auth.js';

const app = document.getElementById('app');
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
// Several GitHub Pages sites can share one origin (user.github.io/<repo>/),
// so scope stored data by path.
const STORAGE_PREFIX = `quiz:${location.pathname}:`;
const PREVIEW_ID = '__preview__';
const RANDOM_SIZE = 20;
const MAX_PREFILL_URL = 7500;

const EDITOR_TEMPLATE = `# 講義名をここに書く

この講義の説明（省略できます）

## 問題文をここに書く。正しいのはどれか。

- [ ] 選択肢1
- [x] 選択肢2（正解の行は [x] にする）
- [ ] 選択肢3
- [ ] 選択肢4
- [ ] 選択肢5

### 解説
解説をここに書きます（省略できます）。

## 正解が2つ以上ある問題の例。2つ選べ。

- [x] 正解の選択肢
- [ ] 選択肢
- [x] 正解の選択肢
- [ ] 選択肢
- [ ] 選択肢

### 解説
[x] が2つ以上あると、自動的に「2つ選ぶ」問題になります。

## 記述式（一問一答）の例：〇〇の定義を答えよ。

### 解答
選択肢を書かずに「### 解答」の下に答えを書くと、「答えを見る → 自己採点」のカード形式になります。
`;

// ---------------------------------------------------------------------------
// Storage (wrapped: it can be unavailable in private mode etc.)

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch {
      // Ignore: progress just won't persist.
    }
  },
};

const state = {
  config: {},
  lectures: [],
  lectureById: new Map(),
  questionById: new Map(), // id -> { q, lecture }
  problems: [],
  progress: store.get('progress', {}), // id -> { n, c, last, t }
  options: { shuffleQuestions: false, shuffleChoices: false, ...store.get('options', {}) },
  session: null,
  auth: null,
  editor: null, // { parseLecture, Marked } once loaded
  draft: {
    text: store.get('editorDraft', null) ?? EDITOR_TEMPLATE,
    path: store.get('editorPath', null) ?? '新しい講義.md',
  },
};

// ---------------------------------------------------------------------------
// Helpers

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const enc = encodeURIComponent;

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function excerpt(html, max = 48) {
  const div = document.createElement('div');
  div.innerHTML = html;
  const text = div.textContent.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function render(html, { wide = false } = {}) {
  app.innerHTML = html;
  document.body.classList.toggle('wide', wide);
  enhance(app);
}

/** Open external links found in question text in a new tab. */
function enhance(root) {
  for (const a of root.querySelectorAll('.md a[href^="http"]')) {
    a.target = '_blank';
    a.rel = 'noopener';
  }
}

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 2400);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url} を読み込めませんでした（${res.status}）`);
  return res.json();
}

function githubFileUrl(kind, filePath) {
  const { repository, branch } = state.config;
  if (!repository) return '';
  const p = filePath.split('/').map(enc).join('/');
  return `https://github.com/${repository}/${kind}/${enc(branch)}/questions/${p}`;
}

const allQuestions = () => state.lectures.flatMap((l) => l.questions);
const correctCount = (q) => q.choices.filter((c) => c.correct).length;
const correctLetters = (q, order) =>
  order
    .map((ci, k) => (q.choices[ci].correct ? LETTERS[k] : null))
    .filter(Boolean)
    .join(', ');
const defaultOrder = (q) => q.choices.map((_, i) => i);

// ---------------------------------------------------------------------------
// Progress

function record(id, ok) {
  if (id.startsWith(PREVIEW_ID)) return;
  const prev = state.progress[id] || { n: 0, c: 0 };
  state.progress[id] = { n: prev.n + 1, c: prev.c + (ok ? 1 : 0), last: ok ? 1 : 0, t: Date.now() };
  store.set('progress', state.progress);
}

function stats(questions) {
  let answered = 0;
  let correct = 0;
  for (const q of questions) {
    const p = state.progress[q.id];
    if (p) {
      answered++;
      if (p.last) correct++;
    }
  }
  return { total: questions.length, answered, correct, wrong: answered - correct };
}

// ---------------------------------------------------------------------------
// Boot & routing

async function boot() {
  try {
    state.config = await fetchJSON('config.json');
    document.title = state.config.title;
    document.getElementById('brand').textContent = state.config.title;

    if (state.config.auth?.enabled) {
      state.auth = await initAuth(state.config.auth);
      if (!state.auth.account) return renderLogin(state.auth.error);
      renderUser();
      if (!state.auth.allowed) return renderNotAllowed();
    }

    const data = await fetchJSON('data/questions.json');
    state.problems = data.problems || [];
    state.lectures = data.lectures || [];
    for (const lecture of state.lectures) registerLecture(lecture);

    window.addEventListener('hashchange', route);
    route();
  } catch (e) {
    console.error(e);
    render(`<section class="card"><h1>読み込みに失敗しました</h1><p class="error-text">${esc(e.message)}</p>
      <button class="btn" onclick="location.reload()">再読み込み</button></section>`);
  }
}

function registerLecture(lecture) {
  state.lectureById.set(lecture.id, lecture);
  for (const q of lecture.questions) state.questionById.set(q.id, { q, lecture });
}

function route() {
  const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const arg = rest.length ? decodeURIComponent(rest.join('/')) : '';
  window.scrollTo(0, 0);
  switch (name) {
    case '':
      return renderHome();
    case 'lecture':
      return renderLecture(arg);
    case 'list':
      return renderList(arg);
    case 'quiz':
      return renderQuiz();
    case 'result':
      return renderResult();
    case 'editor':
      return renderEditor();
    default:
      return renderNotFound();
  }
}

// ---------------------------------------------------------------------------
// Auth views

function renderUser() {
  const a = state.auth?.account;
  document.getElementById('user').innerHTML = a
    ? `<span class="user-name">${esc(a.name || a.username)}</span>
       <button class="btn-link" data-action="logout">サインアウト</button>`
    : '';
}

function renderLogin(error) {
  render(`
    <section class="card login">
      <h1>${esc(state.config.title)}</h1>
      <p>このサイトは学内専用です。<br>大学の Microsoft 365 アカウントでサインインしてください。</p>
      ${error ? `<p class="error-text">サインインできませんでした：${esc(error.errorMessage || error.message)}</p>` : ''}
      <button class="btn primary" data-action="login">Microsoft アカウントでサインイン</button>
    </section>`);
}

function renderNotAllowed() {
  render(`
    <section class="card login">
      <h1>このアカウントでは利用できません</h1>
      <p>${esc(state.auth.account.username)} でサインインしています。<br>大学のアカウントでサインインし直してください。</p>
      <button class="btn primary" data-action="logout">サインアウト</button>
    </section>`);
}

// ---------------------------------------------------------------------------
// Home

function renderHome() {
  const { config, lectures } = state;
  const all = allQuestions();
  const s = stats(all);
  const weak = all.filter((q) => state.progress[q.id]?.last === 0).length;
  const rate = s.answered ? Math.round((s.correct / s.answered) * 100) : null;
  const groups = groupBy(lectures, (l) => l.category);

  const summary = all.length
    ? `<section class="card summary">
        <div class="summary-stats">
          <div class="stat"><span class="stat-num">${s.answered}<small> / ${s.total}</small></span><span class="stat-label">解いた問題</span></div>
          <div class="stat"><span class="stat-num">${rate ?? '–'}<small>${rate === null ? '' : '%'}</small></span><span class="stat-label">直近の正答率</span></div>
        </div>
        <div class="summary-actions">
          <button class="btn primary" data-action="weak" ${weak ? '' : 'disabled'}>間違えた問題を復習（${weak}問）</button>
          <button class="btn" data-action="random">全講義からランダムに ${Math.min(RANDOM_SIZE, all.length)} 問</button>
        </div>
      </section>`
    : `<section class="card empty">
        <p>まだ問題がありません。</p>
        <p class="muted">questions フォルダに Markdown ファイルを追加すると、ここに講義が表示されます。</p>
      </section>`;

  render(`
    ${problemsBanner()}
    <section class="hero">
      <h1>${esc(config.title)}</h1>
      ${config.description ? `<p class="muted">${esc(config.description)}</p>` : ''}
    </section>
    ${summary}
    ${groups
      .map(
        ([name, items]) => `
      <section class="category">
        ${name || groups.length > 1 ? `<h2 class="category-title">${esc(name || 'その他')}</h2>` : ''}
        <div class="lecture-list">${items.map(lectureCard).join('')}</div>
      </section>`,
      )
      .join('')}
    <footer class="foot">
      <a href="#/editor">問題を作成する（エディタ）</a>
      <button class="btn-link" data-action="reset-progress">学習記録をリセット</button>
    </footer>`);
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return [...map];
}

function lectureCard(l) {
  const s = stats(l.questions);
  const pct = (n) => (s.total ? (n / s.total) * 100 : 0);
  return `
    <a class="lecture-card" href="#/lecture/${enc(l.id)}">
      <span class="lc-title">${esc(l.title)}</span>
      <span class="lc-meta">${s.total}問 ・ 解答 ${s.answered} ・ 正解 ${s.correct}</span>
      <span class="meter" aria-hidden="true">
        <span class="meter-ok" style="width:${pct(s.correct)}%"></span><span class="meter-ng" style="width:${pct(s.wrong)}%"></span>
      </span>
    </a>`;
}

function problemsBanner() {
  if (!state.problems.length) return '';
  return `
    <section class="card problems">
      <h2>問題ファイルの確認事項（ローカルプレビューのみ表示）</h2>
      <ul class="problem-list">${state.problems
        .map(
          (p) => `<li class="${p.level}">${p.level === 'error' ? 'エラー' : '注意'}：
            questions/${esc(p.file)} ${p.line}行目 — ${esc(p.message)}</li>`,
        )
        .join('')}</ul>
    </section>`;
}

function renderNotFound() {
  render(`<section class="card"><h1>ページが見つかりません</h1><p><a href="#/">講義一覧へ戻る</a></p></section>`);
}

// ---------------------------------------------------------------------------
// Lecture page & list view

function renderLecture(id) {
  const l = state.lectureById.get(id);
  if (!l) return renderNotFound();
  const s = stats(l.questions);
  const unanswered = s.total - s.answered;
  const editUrl = githubFileUrl('edit', l.path);
  const lid = esc(l.id);
  render(`
    <nav class="crumbs"><a href="#/">← 講義一覧</a></nav>
    <header class="page-head">
      ${l.category ? `<p class="eyebrow">${esc(l.category)}</p>` : ''}
      <h1>${esc(l.title)}</h1>
    </header>
    ${l.descriptionHtml ? `<div class="md desc">${l.descriptionHtml}</div>` : ''}
    <section class="card">
      <p class="lc-meta">全 ${s.total} 問 ・ 解答済み ${s.answered} ・ 正解 ${s.correct} ・ 不正解 ${s.wrong}</p>
      <div class="options">
        ${optionToggle('shuffleQuestions', '問題の順番をシャッフルする')}
        ${optionToggle('shuffleChoices', '選択肢の順番をシャッフルする', '解説中の a〜e の記号とずれることがあります')}
      </div>
      <div class="btn-col">
        <button class="btn primary" data-action="start" data-mode="all" data-lecture="${lid}" ${s.total ? '' : 'disabled'}>全 ${s.total} 問に挑戦</button>
        <button class="btn" data-action="start" data-mode="unanswered" data-lecture="${lid}" ${unanswered ? '' : 'disabled'}>まだ解いていない問題（${unanswered}問）</button>
        <button class="btn" data-action="start" data-mode="wrong" data-lecture="${lid}" ${s.wrong ? '' : 'disabled'}>前回間違えた問題（${s.wrong}問）</button>
        <a class="btn ghost" href="#/list/${enc(l.id)}">問題と解答を一覧で見る</a>
      </div>
    </section>
    ${editUrl ? `<p class="edit-link"><a href="${esc(editUrl)}" target="_blank" rel="noopener">この講義の問題ファイルを GitHub で編集する ↗</a></p>` : ''}`);
}

function optionToggle(key, label, hint = '') {
  return `<label class="check">
    <input type="checkbox" data-option="${key}" ${state.options[key] ? 'checked' : ''}>
    <span>${label}${hint ? `<small class="muted">（${hint}）</small>` : ''}</span>
  </label>`;
}

function renderList(id) {
  const l = state.lectureById.get(id);
  if (!l) return renderNotFound();
  render(`
    <nav class="crumbs"><a href="#/lecture/${enc(l.id)}">← ${esc(l.title)}</a></nav>
    <header class="page-head">
      <p class="eyebrow">問題と解答の一覧</p>
      <h1>${esc(l.title)}</h1>
    </header>
    <div class="btn-row"><button class="btn" data-action="toggle-all">すべての解答を開く</button></div>
    ${l.questions
      .map(
        (q, i) => `
      <article class="card q-item">
        <p class="q-num">問${i + 1} ${typeBadge(q)}</p>
        ${questionBody(q)}
        <details class="answer-toggle">
          <summary>解答・解説を見る</summary>
          ${answerBlock(q, defaultOrder(q))}
        </details>
      </article>`,
      )
      .join('')}`);
}

function typeBadge(q) {
  if (q.type === 'multiple') return `<span class="badge">${correctCount(q)}つ選ぶ</span>`;
  if (q.type === 'flash') return '<span class="badge">記述</span>';
  return '';
}

/** Stem + choices (static). With `highlight`, correct / wrong choices are marked. */
function questionBody(q, { order = defaultOrder(q), selected = [], highlight = false } = {}) {
  const choices =
    q.type === 'flash'
      ? ''
      : `<ol class="choice-static">${order
          .map((ci, k) => {
            const c = q.choices[ci];
            const cls = highlight
              ? [c.correct && 'is-correct', selected.includes(ci) && !c.correct && 'is-wrong'].filter(Boolean).join(' ')
              : '';
            return `<li class="${cls}"><span class="choice-label">${LETTERS[k]}</span><span class="md">${c.html}</span></li>`;
          })
          .join('')}</ol>`;
  return `<div class="md stem">${q.stemHtml}</div>${choices}`;
}

function answerBlock(q, order) {
  const line = q.type === 'flash' ? '' : `<p class="answer-line">正解：<b>${correctLetters(q, order)}</b></p>`;
  const body = q.explanationHtml ? `<div class="md">${q.explanationHtml}</div>` : '';
  return `<div class="answer">${line}${body}</div>`;
}

// ---------------------------------------------------------------------------
// Quiz session

function startSession({ title, ids, backHash }) {
  if (!ids.length) return;
  const order = state.options.shuffleQuestions ? shuffle(ids) : ids;
  state.session = {
    title,
    backHash,
    pos: 0,
    items: order.map((id) => {
      const { q } = state.questionById.get(id);
      const idx = defaultOrder(q);
      return {
        id,
        order: state.options.shuffleChoices ? shuffle(idx) : idx,
        selected: [],
        revealed: false,
        result: null, // true / false once answered
      };
    }),
  };
  navigate('#/quiz');
}

function startLecture(lectureId, mode) {
  const l = state.lectureById.get(lectureId);
  if (!l) return;
  let qs = l.questions;
  if (mode === 'unanswered') qs = qs.filter((q) => !state.progress[q.id]);
  if (mode === 'wrong') qs = qs.filter((q) => state.progress[q.id]?.last === 0);
  startSession({ title: l.title, ids: qs.map((q) => q.id), backHash: `#/lecture/${enc(l.id)}` });
}

function currentItem() {
  const s = state.session;
  if (!s) return null;
  const item = s.items[s.pos];
  return { s, item, ...state.questionById.get(item.id) };
}

function renderQuiz() {
  const cur = currentItem();
  if (!cur) return navigate('#/');
  const { s, item, q, lecture } = cur;
  const done = item.result !== null;
  const total = s.items.length;
  const isLast = s.pos === total - 1;
  const need = q.type === 'multiple' ? correctCount(q) : 1;

  let body = '';
  if (q.type === 'flash') {
    if (item.revealed) body = `<section class="answer reveal"><h3>解答・解説</h3><div class="md">${q.explanationHtml}</div></section>`;
  } else {
    body = `<div class="choices">${item.order
      .map((ci, k) => {
        const c = q.choices[ci];
        const selected = item.selected.includes(ci);
        const cls = [
          'choice',
          selected && 'is-selected',
          done && c.correct && 'is-correct',
          done && selected && !c.correct && 'is-wrong',
        ]
          .filter(Boolean)
          .join(' ');
        const mark = done ? (c.correct ? '○' : selected ? '×' : '') : '';
        return `<button class="${cls}" data-action="choose" data-choice="${ci}" aria-pressed="${selected}" ${done ? 'disabled' : ''}>
          <span class="choice-label">${LETTERS[k]}</span>
          <span class="choice-text md">${c.html}</span>
          <span class="choice-mark" aria-hidden="true">${mark}</span>
        </button>`;
      })
      .join('')}</div>`;
  }

  let feedback = '';
  if (done && q.type !== 'flash') {
    feedback = `
      <div class="verdict ${item.result ? 'ok' : 'ng'}" role="status">
        ${item.result ? '正解！' : `不正解　<span>正解は <b>${correctLetters(q, item.order)}</b></span>`}
      </div>
      ${q.explanationHtml ? `<section class="answer"><h3>解説</h3><div class="md">${q.explanationHtml}</div></section>` : ''}`;
  }

  let actions;
  if (done) {
    actions = `<button class="btn primary" data-action="next">${isLast ? '結果を見る' : '次の問題へ'}</button>`;
  } else if (q.type === 'flash') {
    actions = item.revealed
      ? `<p class="hint">答えられましたか？</p>
         <div class="self-grade">
           <button class="btn ok" data-action="self" data-ok="1">○ できた</button>
           <button class="btn ng" data-action="self" data-ok="0">× できなかった</button>
         </div>`
      : `<button class="btn primary" data-action="reveal">答えを見る</button>`;
  } else {
    const ready = item.selected.length === need;
    actions = `
      ${q.type === 'multiple' && !ready ? `<p class="hint">${need}つ選んでください</p>` : ''}
      <button class="btn primary" data-action="submit" ${ready ? '' : 'disabled'}>解答する</button>`;
  }

  render(`
    <div class="quiz-head">
      <button class="btn-link" data-action="quit">← 終了</button>
      <span class="counter">${s.pos + 1} / ${total}</span>
    </div>
    <div class="progress" aria-hidden="true"><span style="width:${((s.pos + (done ? 1 : 0)) / total) * 100}%"></span></div>
    <article class="card question">
      <p class="q-meta"><span>${esc(lecture.title)}</span>${typeBadge(q)}</p>
      <div class="md stem">${q.stemHtml}</div>
      ${body}
    </article>
    <div class="feedback">${feedback}</div>
    <div class="quiz-actions">${actions}</div>
    <p class="kbd-hint">キーボード：a〜e / 1〜5 で選択、Enter で解答・次へ</p>`);
}

function choose(ci) {
  const cur = currentItem();
  if (!cur || cur.item.result !== null) return;
  const { item, q } = cur;
  if (q.type === 'multiple') {
    item.selected = item.selected.includes(ci) ? item.selected.filter((x) => x !== ci) : [...item.selected, ci];
  } else {
    item.selected = [ci];
  }
  renderQuiz();
}

function submitAnswer() {
  const cur = currentItem();
  if (!cur || cur.item.result !== null) return;
  const { item, q } = cur;
  const correct = new Set(q.choices.map((c, i) => (c.correct ? i : -1)).filter((i) => i >= 0));
  const ok = item.selected.length === correct.size && item.selected.every((i) => correct.has(i));
  item.result = ok;
  record(item.id, ok);
  renderQuiz();
  app.querySelector('.verdict')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function next() {
  const s = state.session;
  if (!s) return;
  if (s.pos < s.items.length - 1) {
    s.pos++;
    renderQuiz();
    window.scrollTo(0, 0);
  } else {
    navigate('#/result');
  }
}

// ---------------------------------------------------------------------------
// Result

function renderResult() {
  const s = state.session;
  if (!s) return navigate('#/');
  const answered = s.items.filter((it) => it.result !== null);
  const ok = answered.filter((it) => it.result).length;
  const pct = answered.length ? Math.round((ok / answered.length) * 100) : 0;
  const wrong = answered.length - ok;
  render(`
    <header class="page-head">
      <p class="eyebrow">${esc(s.title)}</p>
      <h1>結果</h1>
    </header>
    <section class="card score">
      <div class="score-num">${ok}<small> / ${answered.length} 問正解</small></div>
      <div class="score-pct ${pct >= 80 ? 'good' : ''}">${pct}%</div>
    </section>
    <div class="btn-col">
      ${wrong ? `<button class="btn primary" data-action="retry-wrong">間違えた ${wrong} 問をもう一度</button>` : ''}
      <button class="btn ${wrong ? '' : 'primary'}" data-action="retry-all">もう一度すべて解く</button>
      <a class="btn ghost" href="${esc(s.backHash)}">戻る</a>
    </div>
    <h2 class="section-title">振り返り</h2>
    <ol class="review">${s.items
      .map((it, i) => {
        const { q } = state.questionById.get(it.id);
        const cls = it.result === null ? 'skip' : it.result ? 'ok' : 'ng';
        const mark = it.result === null ? '–' : it.result ? '○' : '×';
        return `<li class="review-item ${cls}">
          <details>
            <summary><span class="review-mark">${mark}</span><span class="review-text">問${i + 1}　${esc(excerpt(q.stemHtml))}</span></summary>
            <div class="review-body">
              ${questionBody(q, { order: it.order, selected: it.selected, highlight: true })}
              ${answerBlock(q, it.order)}
            </div>
          </details>
        </li>`;
      })
      .join('')}</ol>`);
}

// ---------------------------------------------------------------------------
// Editor

async function renderEditor() {
  if (!state.editor) {
    render('<nav class="crumbs"><a href="#/">← 講義一覧</a></nav><p class="loading">エディタを読み込み中…</p>', {
      wide: true,
    });
    const [{ parseLecture }, { Marked }] = await Promise.all([
      import('./parser.js'),
      import('./vendor/marked.esm.js'),
    ]);
    state.editor = { parseLecture, Marked };
    if (!location.hash.startsWith('#/editor')) return; // navigated away while loading
  }
  const repo = state.config.repository;
  render(
    `
    <nav class="crumbs"><a href="#/">← 講義一覧</a></nav>
    <header class="page-head">
      <h1>問題エディタ</h1>
      <p class="muted">左に問題を書くと、右にプレビューが表示されます。完成したら${
        repo ? '「GitHub に追加」を押してください。' : '内容をコピーして questions フォルダに保存してください。'
      }</p>
    </header>
    <div class="editor">
      <div class="editor-input">
        <label class="field">
          <span>ファイル名（questions フォルダ内。フォルダ名/ファイル名.md でカテゴリ分け）</span>
          <input id="ed-path" type="text" value="${esc(state.draft.path)}" autocomplete="off" spellcheck="false">
        </label>
        <textarea id="ed-text" spellcheck="false" aria-label="問題の Markdown">${esc(state.draft.text)}</textarea>
        <div class="btn-row">
          ${repo ? '<button class="btn primary" data-action="ed-github">GitHub に追加</button>' : ''}
          <button class="btn" data-action="ed-try">解いてみる</button>
          <button class="btn" data-action="ed-copy">コピー</button>
          <button class="btn ghost" data-action="ed-template">テンプレートに戻す</button>
        </div>
        <details class="guide" open>
          <summary>書き方</summary>
          <table>
            <tbody>
              <tr><th>講義名</th><td><code># 講義名</code>（ファイルの先頭に1回）</td></tr>
              <tr><th>問題文</th><td><code>## 問題文</code>（続きは次の行から書ける）</td></tr>
              <tr><th>選択肢</th><td><code>- [ ] 選択肢</code></td></tr>
              <tr><th>正解の選択肢</th><td><code>- [x] 選択肢</code>（2つ以上で「複数選択」）</td></tr>
              <tr><th>解説</th><td>選択肢の下に書く（<code>### 解説</code> は省略可）</td></tr>
              <tr><th>記述式</th><td>選択肢を書かずに <code>### 解答</code> の下に答え</td></tr>
              <tr><th>画像</th><td><code>![説明](images/図1.png)</code></td></tr>
            </tbody>
          </table>
          <p class="muted">a〜e の記号や「問1」などの番号は自動で付くので、書かなくて大丈夫です。</p>
        </details>
      </div>
      <div class="editor-preview" id="ed-preview" aria-live="polite"></div>
    </div>`,
    { wide: true },
  );

  const text = document.getElementById('ed-text');
  const pathInput = document.getElementById('ed-path');
  const save = debounce(() => {
    store.set('editorDraft', state.draft.text);
    store.set('editorPath', state.draft.path);
    updatePreview();
  }, 250);
  text.addEventListener('input', () => {
    state.draft.text = text.value;
    save();
  });
  pathInput.addEventListener('input', () => {
    state.draft.path = pathInput.value;
    save();
  });
  updatePreview();
}

function draftPath() {
  let p = state.draft.path.trim().replace(/^\/+/, '').replace(/^questions\//, '');
  if (!p) p = '新しい講義.md';
  if (!/\.md$/i.test(p)) p += '.md';
  return p;
}

function parseDraft() {
  const { parseLecture, Marked } = state.editor;
  const p = draftPath();
  const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
  return parseLecture(state.draft.text, { Marked, assetBase: `q/${dir}` });
}

function updatePreview() {
  const el = document.getElementById('ed-preview');
  if (!el) return;
  const r = parseDraft();
  const problems = [
    ...r.errors.map((p) => ({ ...p, level: 'error' })),
    ...r.warnings.map((p) => ({ ...p, level: 'warning' })),
  ].sort((a, b) => a.line - b.line);
  const ignored = draftPath()
    .split('/')
    .some((part) => part.startsWith('_') || part.startsWith('.'));

  el.innerHTML = `
    <div class="preview-status ${r.errors.length ? 'has-error' : 'ok'}">
      ${
        r.errors.length
          ? `エラーが ${r.errors.length} 件あります（直すまでサイトには公開されません）`
          : `OK：${r.questions.length} 問を読み込めました`
      }
    </div>
    ${ignored ? '<p class="problem-list warning">「_」や「.」で始まるファイル・フォルダはサイトに表示されません（下書き用）。</p>' : ''}
    ${
      problems.length
        ? `<ul class="problem-list">${problems
            .map(
              (p) => `<li class="${p.level}">
                <button class="btn-link" data-action="ed-goto" data-line="${p.line}">${p.line}行目</button>
                ${esc(p.message)}</li>`,
            )
            .join('')}</ul>`
        : ''
    }
    <h2 class="preview-title">${esc(r.title || '（講義名なし）')}</h2>
    ${r.descriptionHtml ? `<div class="md desc">${r.descriptionHtml}</div>` : ''}
    ${r.questions
      .map(
        (q, i) => `
      <article class="card q-item">
        <p class="q-num">問${i + 1} ${typeBadge(q)}</p>
        ${questionBody(q, { highlight: true })}
        ${answerBlock(q, defaultOrder(q))}
      </article>`,
      )
      .join('')}`;
  enhance(el);
}

function gotoLine(line) {
  const ta = document.getElementById('ed-text');
  if (!ta) return;
  const lines = ta.value.split('\n');
  const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
  const end = start + (lines[line - 1] ?? '').length;
  ta.focus();
  ta.setSelectionRange(start, end);
  const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  ta.scrollTop = Math.max(0, (line - 3) * lineHeight);
}

function tryDraft() {
  const r = parseDraft();
  if (!r.questions.length) {
    toast('解ける問題がありません。エラーを確認してください。');
    return;
  }
  // Replace the previous preview lecture, if any.
  for (const id of state.questionById.keys()) if (id.startsWith(PREVIEW_ID)) state.questionById.delete(id);
  const lecture = {
    id: PREVIEW_ID,
    title: `${r.title || '下書き'}（プレビュー）`,
    category: '',
    questions: r.questions.map(({ key, line, ...q }) => ({ id: `${PREVIEW_ID}#${key}`, ...q })),
  };
  registerLecture(lecture);
  startSession({ title: lecture.title, ids: lecture.questions.map((q) => q.id), backHash: '#/editor' });
}

async function addToGitHub() {
  const { repository, branch } = state.config;
  const p = draftPath();
  const base = `https://github.com/${repository}/new/${enc(branch)}?filename=${enc(`questions/${p}`)}`;
  const full = `${base}&value=${enc(state.draft.text)}`;
  if (parseDraft().errors.length && !confirm('エラーが残っています（このままだと公開時にエラーになります）。続けますか？')) {
    return;
  }
  if (full.length <= MAX_PREFILL_URL) {
    window.open(full, '_blank', 'noopener');
    return;
  }
  const copied = await copyText(state.draft.text);
  alert(
    copied
      ? '内容が長いため自動入力できません。内容をコピーしたので、開いた GitHub の画面の本文欄に貼り付けてください。'
      : '内容が長いため自動入力できません。「コピー」ボタンで内容をコピーし、GitHub の画面に貼り付けてください。',
  );
  window.open(base, '_blank', 'noopener');
}

// ---------------------------------------------------------------------------
// Event wiring

const actions = {
  login: () => state.auth.login(),
  logout: () => state.auth.logout(),
  start: (el) => startLecture(el.dataset.lecture, el.dataset.mode),
  weak: () =>
    startSession({
      title: '間違えた問題の復習',
      ids: allQuestions()
        .filter((q) => state.progress[q.id]?.last === 0)
        .map((q) => q.id),
      backHash: '#/',
    }),
  random: () =>
    startSession({
      title: 'ランダム出題',
      ids: shuffle(allQuestions().map((q) => q.id)).slice(0, RANDOM_SIZE),
      backHash: '#/',
    }),
  choose: (el) => choose(Number(el.dataset.choice)),
  submit: submitAnswer,
  reveal: () => {
    const cur = currentItem();
    if (!cur) return;
    cur.item.revealed = true;
    renderQuiz();
  },
  self: (el) => {
    const cur = currentItem();
    if (!cur || cur.item.result !== null) return;
    cur.item.result = el.dataset.ok === '1';
    record(cur.item.id, cur.item.result);
    next();
  },
  next,
  quit: () => {
    const s = state.session;
    if (!s) return navigate('#/');
    navigate(s.items.some((it) => it.result !== null) ? '#/result' : s.backHash);
  },
  'retry-wrong': () => {
    const s = state.session;
    startSession({ title: s.title, ids: s.items.filter((it) => it.result === false).map((it) => it.id), backHash: s.backHash });
  },
  'retry-all': () => {
    const s = state.session;
    startSession({ title: s.title, ids: s.items.map((it) => it.id), backHash: s.backHash });
  },
  'reset-progress': () => {
    if (!confirm('これまでの学習記録（正解・不正解の履歴）をすべて削除します。よろしいですか？')) return;
    state.progress = {};
    store.set('progress', {});
    renderHome();
    toast('学習記録をリセットしました');
  },
  'toggle-all': (el) => {
    const list = [...app.querySelectorAll('details.answer-toggle')];
    const open = !list.every((d) => d.open);
    for (const d of list) d.open = open;
    el.textContent = open ? 'すべての解答を閉じる' : 'すべての解答を開く';
  },
  'ed-github': addToGitHub,
  'ed-try': tryDraft,
  'ed-copy': async () => toast((await copyText(state.draft.text)) ? 'コピーしました' : 'コピーできませんでした'),
  'ed-template': () => {
    if (!confirm('今の内容を消して、テンプレートに戻しますか？')) return;
    state.draft.text = EDITOR_TEMPLATE;
    store.set('editorDraft', EDITOR_TEMPLATE);
    document.getElementById('ed-text').value = EDITOR_TEMPLATE;
    updatePreview();
  },
  'ed-goto': (el) => gotoLine(Number(el.dataset.line)),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  fn(el);
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-option]');
  if (!el) return;
  state.options[el.dataset.option] = el.checked;
  store.set('options', state.options);
});

document.addEventListener('keydown', (e) => {
  if (!location.hash.startsWith('#/quiz') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, textarea, select')) return;
  const cur = currentItem();
  if (!cur) return;
  const key = e.key.toLowerCase();
  if (cur.q.type !== 'flash' && cur.item.result === null) {
    let k = key.length === 1 ? LETTERS.indexOf(key) : -1;
    if (k < 0 && /^[1-9]$/.test(key)) k = Number(key) - 1;
    if (k >= 0 && k < cur.item.order.length) {
      e.preventDefault();
      choose(cur.item.order[k]);
      return;
    }
  }
  if (key === 'enter' && !e.target.closest('button, a, summary')) {
    const primary = app.querySelector('.quiz-actions .btn.primary:not([disabled])');
    if (primary) {
      e.preventDefault();
      primary.click();
    }
  }
});

boot();
