// Markdown -> question set parser.
//
// Shared by the build script (Node.js) and the in-browser editor, so this
// module must not import anything. The caller passes in the `Marked` class.
//
// File format (see questions/README.md for the author-facing guide):
//
//   # Lecture title
//   Optional description...
//
//   ## Question stem (first line)
//   More stem lines...
//
//   - [ ] wrong choice
//   - [x] correct choice
//
//   ### 解説            <- optional heading
//   Explanation...
//
// A question without choices becomes a flash card; its answer goes under
// "### 解答" (or 解説 / 答え).

const TITLE_RE = /^[#＃](?![#＃])[ \t　]*(.*)$/;
const QUESTION_RE = /^[#＃]{2}(?![#＃])[ \t　]*(.*)$/;
const ANSWER_HEADING_RE =
  /^[#＃]{3}(?![#＃])[ \t　]*(解説|解答|答え|こたえ|正解|answer|explanation)/i;
// Accepts half/full-width brackets contents and a few "correct" marks that
// Japanese IMEs tend to produce.
const CHOICE_RE = /^[ \t]*[-*+・－][ \t　]*[[［]([ 　]?|[xXｘＸ○◯✓✔])[\]］][ \t　]*(.*)$/;
const CORRECT_MARK_RE = /[xXｘＸ○◯✓✔]/;
const CONTINUATION_RE = /^[ \t]{2,}\S/;
const FENCE_RE = /^[ \t]*(```|~~~)/;
// Labels such as "a. ", "b) ", "①" are added automatically by the app,
// so strip them if the author typed them anyway.
const CHOICE_LABEL_RE =
  /^(?:[a-hA-Hａ-ｈＡ-Ｈ1-9１-９][.．)）][ \t　]+|[a-hａ-ｈ][)）][ \t　]*|[①-⑳][ \t　]*)/;
// Numbering such as "問1", "Q2." is added automatically as well.
const QUESTION_NUMBER_RE = /^(?:問題?|設問|Q)[ \t　]*[0-9０-９]+[ \t　]*[.．:：、)）]?[ \t　]*/i;

export const CHOICE_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Parse one lecture file.
 * @param {string} source Markdown text
 * @param {object} options
 * @param {Function} options.Marked The `Marked` class from the "marked" package
 * @param {string} [options.assetBase] URL prefix for relative image/link paths
 */
export function parseLecture(source, { Marked, assetBase = '' } = {}) {
  const md = createRenderer(Marked, assetBase);
  const errors = [];
  const warnings = [];
  const error = (line, message) => errors.push({ line, message });
  const warn = (line, message) => warnings.push({ line, message });

  const text = String(source ?? '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    // Drop HTML comments but keep their line breaks so line numbers stay right.
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
  const lines = text.split('\n');

  let title = null;
  const intro = [];
  const blocks = [];
  let cur = null;
  let inFence = false;

  const pushContent = (line) => {
    if (!cur) {
      intro.push(line);
      return;
    }
    if (cur.section === 'choices') {
      if (line.trim() === '') return;
      cur.section = 'explanation';
    }
    cur[cur.section].push(line);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const isFence = FENCE_RE.test(line);
    if (isFence) inFence = !inFence;
    if (isFence || inFence) {
      pushContent(line);
      continue;
    }

    let m;
    if ((m = QUESTION_RE.exec(line))) {
      cur = {
        line: lineNo,
        heading: m[1].trim().replace(QUESTION_NUMBER_RE, ''),
        stem: [],
        choices: [],
        explanation: [],
        section: 'stem',
        hasAnswerHeading: false,
        warnedStrayChoice: false,
      };
      blocks.push(cur);
      continue;
    }

    if ((m = TITLE_RE.exec(line)) && m[1].trim()) {
      if (!cur && title === null) {
        title = m[1].trim();
        continue;
      }
      warn(lineNo, '「# 」で始まる行は講義名として1回だけ使えます。問題には「## 」を使ってください。');
    }

    if (cur) {
      if (ANSWER_HEADING_RE.test(line)) {
        cur.section = 'explanation';
        cur.hasAnswerHeading = true;
        continue;
      }
      const c = CHOICE_RE.exec(line);
      if (c) {
        if (cur.section !== 'explanation') {
          cur.section = 'choices';
          cur.choices.push({ line: lineNo, correct: CORRECT_MARK_RE.test(c[1]), text: c[2].trim() });
          continue;
        }
        if (!cur.warnedStrayChoice) {
          cur.warnedStrayChoice = true;
          warn(lineNo, '解説の中に選択肢の行があります。選択肢は間に文章を挟まず、続けて書いてください。');
        }
      } else if (cur.section === 'choices' && CONTINUATION_RE.test(line)) {
        const last = cur.choices[cur.choices.length - 1];
        last.text = `${last.text} ${line.trim()}`.trim();
        continue;
      }
    }
    pushContent(line);
  }

  if (blocks.length === 0) {
    error(1, '問題がありません。「## 」で始まる行から問題を書いてください。');
  }
  if (title === null) {
    warn(1, '講義名（「# 講義名」の行）がありません。ファイル名を講義名として使います。');
  }

  const questions = [];
  const usedKeys = new Set();
  for (const b of blocks) {
    const before = errors.length;
    const stemMd = [b.heading, b.stem.join('\n').trim()].filter(Boolean).join('\n\n');
    const explanationMd = b.explanation.join('\n').trim();
    const correctCount = b.choices.filter((c) => c.correct).length;

    if (!stemMd) {
      error(b.line, '問題文がありません。「## 」の後ろに問題文を書いてください。');
    }
    let type;
    if (b.choices.length === 0) {
      type = 'flash';
      if (!b.hasAnswerHeading || !explanationMd) {
        error(
          b.line,
          '選択肢（「- [ ] 」「- [x] 」の行）がありません。記述式の問題にする場合は「### 解答」の下に答えを書いてください。',
        );
      }
    } else {
      type = correctCount > 1 ? 'multiple' : 'single';
      if (b.choices.length === 1) {
        error(b.choices[0].line, '選択肢が1つしかありません。2つ以上書いてください。');
      }
      if (correctCount === 0) {
        error(b.line, '正解の選択肢がありません。正解の行を「- [x] 」にしてください。');
      }
      for (const c of b.choices) {
        if (!c.text.replace(CHOICE_LABEL_RE, '').trim()) error(c.line, '選択肢の文章が空です。');
      }
    }
    if (errors.length > before) continue;

    let key = hash(stemMd.replace(/\s+/g, ' '));
    if (usedKeys.has(key)) {
      warn(b.line, '同じ問題文の問題がすでにあります。');
      let n = 2;
      while (usedKeys.has(`${key}-${n}`)) n++;
      key = `${key}-${n}`;
    }
    usedKeys.add(key);

    questions.push({
      key,
      line: b.line,
      type,
      stemHtml: md.block(stemMd),
      choices: b.choices.map((c) => ({
        html: md.inline(c.text.replace(CHOICE_LABEL_RE, '')),
        correct: c.correct,
      })),
      explanationHtml: explanationMd ? md.block(explanationMd) : '',
    });
  }

  return {
    title,
    descriptionHtml: md.block(intro.join('\n').trim()),
    questions,
    errors,
    warnings,
  };
}

function createRenderer(Marked, assetBase) {
  if (typeof Marked !== 'function') throw new TypeError('parseLecture: options.Marked is required');
  const marked = new Marked({ gfm: true, breaks: true });
  marked.use({
    walkTokens(token) {
      if ((token.type === 'image' || token.type === 'link') && token.href) {
        token.href = resolveAsset(token.href, assetBase);
      }
    },
  });
  return {
    block: (src) => (src ? marked.parse(src) : ''),
    inline: (src) => (src ? marked.parseInline(src) : ''),
  };
}

/** Resolve a relative path written in a lecture file against its folder. */
export function resolveAsset(href, base) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(href)) return href;
  const url = new URL(href, `https://x.invalid/${base}`);
  return url.pathname.slice(1) + url.search + url.hash;
}

/** FNV-1a 32-bit, base36. Used for stable per-question ids. */
export function hash(str) {
  let h = 0x811c9dc5;
  for (const ch of str) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
