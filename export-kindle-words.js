import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── helper для __dirname ──────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── путь к базе ────────────────────────────────────────────────────────
// Можно передать как аргумент командной строки
// const dbPath = process.argv[2];
const dbPath = 'H:/system/vocabulary/vocab.db';

if (!dbPath) {
  console.error(
    '❌ Укажи путь к vocab.db: node export-kindle-words.mjs <path>'
  );
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const cyrillic = /[\u0400-\u04FF]/;

// ── SQL: получаем базовую форму слова (stem), предложение (usage), и книгу (title) ─────────────
// COUNT(*) — сколько раз слово встречалось
// MAX(l.usage) — одно из предложений (самое позднее по времени, как правило)
// MAX(b.title) — название книги
const rows = db
  .prepare(
    `
    SELECT 
      w.stem AS word,
      COUNT(*) AS count,
      MAX(l.usage) AS usage,
      MAX(b.title) AS title
    FROM LOOKUPS l
    JOIN WORDS w ON w.id = l.word_key
    LEFT JOIN BOOK_INFO b ON b.id = l.book_key
    WHERE w.stem IS NOT NULL
    GROUP BY w.stem
    HAVING LENGTH(w.stem) > 2
    ORDER BY LOWER(w.stem) ASC, count DESC
  `
  )
  .all();

// ── Преобразуем результат в читаемый формат, фильтруем кириллицу ────────────────
const filtered = rows
  .map(({ word, count, usage, title }) => ({
    word: word.trim().toLowerCase(),
    count,
    example: usage?.trim() || '',
    book: title?.trim().split(':')[0] || '',
  }))
  .filter(({ word }) => word && !cyrillic.test(word))
  .sort((a, b) => {
    const cmp = a.word.localeCompare(b.word, 'en', { sensitivity: 'base' });
    return cmp !== 0 ? cmp : b.count - a.count;
  });

// ── Читаемый .txt файл ────────────────────────────────────────────────
const humanOutput = filtered
  .map(
    ({ word, count, example, book }) =>
      `${word} — ${count}\n  📘 ${book}\n  📄 ${example}`
  )
  .join('\n\n');

// ── JSON: формат пригодный для AI или Anki ─────────────────────────────
const structuredJson = JSON.stringify(filtered, null, 2);

// ── Сохраняем оба файла ───────────────────────────────────────────────
const humanFile = path.join(__dirname, 'words.txt');
fs.writeFileSync(humanFile, humanOutput, 'utf8');

const jsonFile = path.join(__dirname, 'words_detailed.json');
fs.writeFileSync(jsonFile, structuredJson, 'utf8');

// ── Готово ─────────────────────────────────────────────────────────────
console.log(
  `✅ Готово! ${filtered.length} слов сохранено в:\n` +
    ` - ${humanFile} (читаемый формат)\n` +
    ` - ${jsonFile} (JSON с примерами и книгой)`
);
