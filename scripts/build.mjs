// Build the static site into dist/.
//
//   questions/**/*.md  -> dist/data/questions.json (validated)
//   questions/** (other files, e.g. images) -> dist/q/**
//   src/**             -> dist/**
//   site.config.json   -> dist/config.json
//
// Exits with code 1 when any lecture file has errors (so CI blocks the deploy).

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Marked } from 'marked';
import { parseLecture } from '../src/parser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUESTIONS_DIR = path.join(ROOT, 'questions');
const SRC_DIR = path.join(ROOT, 'src');
const DIST_DIR = path.join(ROOT, 'dist');
const VENDOR_FILES = {
  'marked.esm.js': 'node_modules/marked/lib/marked.esm.js',
  'msal-browser.min.js': 'node_modules/@azure/msal-browser/lib/msal-browser.min.js',
};

export async function build({ dev = false, quiet = false } = {}) {
  const config = JSON.parse(await readFile(path.join(ROOT, 'site.config.json'), 'utf8'));
  const files = (await walk(QUESTIONS_DIR)).sort(comparePaths);
  const lectureFiles = files.filter(isLectureFile);
  const assetFiles = files.filter((f) => !/\.md$/i.test(f));

  const problems = [];
  const lectures = [];
  for (const file of lectureFiles) {
    const source = await readFile(path.join(QUESTIONS_DIR, file), 'utf8');
    const dir = path.posix.dirname(file);
    const parsed = parseLecture(source, {
      Marked,
      assetBase: `q/${dir === '.' ? '' : `${dir}/`}`,
    });
    for (const p of parsed.errors) problems.push({ file, level: 'error', ...p });
    for (const p of parsed.warnings) problems.push({ file, level: 'warning', ...p });

    const id = file.replace(/\.md$/i, '').normalize('NFC');
    lectures.push({
      id,
      path: file,
      category: dir === '.' ? '' : dir.split('/').map(displayName).join(' / '),
      title: parsed.title || displayName(path.posix.basename(id)),
      descriptionHtml: parsed.descriptionHtml,
      questions: parsed.questions.map(({ key, line, ...q }) => ({ id: `${id}#${key}`, ...q })),
    });
  }

  await rm(DIST_DIR, { recursive: true, force: true });
  await cp(SRC_DIR, DIST_DIR, { recursive: true });
  const version = Date.now().toString(36);
  const indexPath = path.join(DIST_DIR, 'index.html');
  await writeFile(indexPath, (await readFile(indexPath, 'utf8')).replaceAll('__VERSION__', version));

  await mkdir(path.join(DIST_DIR, 'vendor'), { recursive: true });
  for (const [name, from] of Object.entries(VENDOR_FILES)) {
    await cp(path.join(ROOT, from), path.join(DIST_DIR, 'vendor', name));
  }
  for (const file of assetFiles) {
    await cp(path.join(QUESTIONS_DIR, file), path.join(DIST_DIR, 'q', file));
  }

  const publicConfig = {
    title: config.title || '練習問題',
    description: config.description || '',
    repository: config.repository || process.env.GITHUB_REPOSITORY || '',
    branch: config.branch || 'main',
    auth: {
      enabled: Boolean(config.auth?.enabled),
      clientId: config.auth?.clientId || '',
      tenantId: config.auth?.tenantId || '',
      allowedDomains: config.auth?.allowedDomains || [],
    },
  };
  await writeFile(path.join(DIST_DIR, 'config.json'), JSON.stringify(publicConfig, null, 2));

  await mkdir(path.join(DIST_DIR, 'data'), { recursive: true });
  const data = { builtAt: new Date().toISOString(), lectures, problems: dev ? problems : [] };
  await writeFile(path.join(DIST_DIR, 'data', 'questions.json'), JSON.stringify(data));

  const errorCount = problems.filter((p) => p.level === 'error').length;
  const warningCount = problems.length - errorCount;
  const questionCount = lectures.reduce((n, l) => n + l.questions.length, 0);
  if (!quiet || problems.length) report(problems);
  if (!quiet) {
    console.log(
      `Built ${lectures.length} lectures / ${questionCount} questions ` +
        `(${errorCount} errors, ${warningCount} warnings) -> dist/`,
    );
  }
  return { errorCount, warningCount, lectureCount: lectures.length, questionCount };
}

function report(problems) {
  const inActions = Boolean(process.env.GITHUB_ACTIONS);
  for (const p of problems) {
    const file = `questions/${p.file}`;
    if (inActions) {
      // Shown as annotations on the commit / pull request in GitHub.
      console.log(`::${p.level} file=${file},line=${p.line}::${p.message}`);
    } else {
      console.log(`${p.level === 'error' ? 'ERROR' : 'WARN '} ${file}:${p.line}  ${p.message}`);
    }
  }
}

async function walk(dir, rel = '') {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const ent of entries) {
    // "_draft.md", "_old/" and dotfiles are ignored.
    if (ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
    const relPath = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...(await walk(path.join(dir, ent.name), relPath)));
    else if (ent.isFile()) out.push(relPath);
  }
  return out;
}

function isLectureFile(file) {
  return /\.md$/i.test(file) && path.posix.basename(file).toLowerCase() !== 'readme.md';
}

function comparePaths(a, b) {
  return a.localeCompare(b, 'ja', { numeric: true });
}

/** "01_産科" -> "産科" (numeric prefixes are only for ordering). */
function displayName(name) {
  return name.replace(/^\d+[\s._-]*/, '') || name;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await build();
  if (result.errorCount > 0) {
    console.error('問題ファイルにエラーがあるため、ビルドを中止しました。上のメッセージを確認してください。');
    process.exit(1);
  }
}
