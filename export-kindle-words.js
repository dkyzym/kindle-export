import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── helper ──────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Путь к базе данных Kindle ───────────────────────────────────────────
const dbPath = 'H:/system/vocabulary/vocab.db';
if (!dbPath) {
  console.error(
    '❌ Укажи путь к vocab.db: node export-kindle-words.mjs <path>'
  );
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const cyrillic = /[\u0400-\u04FF]/;

// ── SQL: выборка слова, частоты, предложения и книги ────────────────────
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

// ── Обработка и фильтрация ─────────────────────────────────────────────
const filtered = rows
  .map(({ word, count, usage, title }) => ({
    word: word.trim().toLowerCase(),
    count,
    example: usage?.trim() || '',
    book:
      title
        ?.trim()
        .split(' ')
        .slice(0, 3)
        .join(' ')
        .replace(/[^a-zA-Zа-яА-ЯёЁ0-9]+$/g, '') || '',
  }))
  .filter(({ word }) => word && !cyrillic.test(word))
  .sort((a, b) => {
    const cmp = a.word.localeCompare(b.word, 'en', { sensitivity: 'base' });
    return cmp !== 0 ? cmp : b.count - a.count;
  });

// ── Читаемый вывод ──────────────────────────────────────────────────────
const humanOutput = filtered
  .map(
    ({ word, count, example, book }) =>
      `${word} — ${count}\n  📘 ${book}\n  📄 ${example}`
  )
  .join('\n\n');

const structuredJson = JSON.stringify(filtered, null, 2);

// ── Создаём папку вывода, если не существует ───────────────────────────
const outputDir = path.join(__dirname, 'output');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// ── Сохраняем результаты ────────────────────────────────────────────────
const humanFile = path.join(outputDir, 'words.txt');
fs.writeFileSync(humanFile, humanOutput, 'utf8');

const jsonFile = path.join(outputDir, 'words_detailed.json');
fs.writeFileSync(jsonFile, structuredJson, 'utf8');

// ── Финальный вывод ─────────────────────────────────────────────────────
console.log(
  `✅ Готово! ${filtered.length} слов сохранено в:\n` +
    ` - ${humanFile} (читаемый формат)\n` +
    ` - ${jsonFile} (JSON с примерами и книгой)`
);
