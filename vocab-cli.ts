// vocab-cli.ts – Kindle words → Anki TSV
// -----------------------------------------------------------------------------
// npm i natural wink-lemmatizer fs-extra yargs xlsx
// npm i -D tsx typescript @types/node @types/natural @types/yargs @types/xlsx
// -----------------------------------------------------------------------------
// tsx vocab-cli.ts ingest words.json
// tsx vocab-cli.ts export --tier 1 --batch 30
// -----------------------------------------------------------------------------
// tsconfig – moduleResolution: "NodeNext", skipLibCheck: true (см. прежние шаги)

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { hideBin } from 'yargs/helpers';
import yargs from 'yargs/yargs';

// --- natural (CJS) через dynamic-import
const naturalMod: any = await import('natural');
const { WordNet, PorterStemmer } = (naturalMod.default ??
  naturalMod) as typeof import('natural');

// @ts-ignore – wink-lemmatizer без d.ts
import lemmatizer from 'wink-lemmatizer';
import xlsx from 'xlsx';

// ──────────────────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const D = (f: string) => path.join(DATA_DIR, f);

// ---------- helpers
async function safeJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function loadStop(): Promise<Set<string>> {
  try {
    return new Set(
      (await fs.readFile(D('stop_en.txt'), 'utf8'))
        .split(/\r?\n/)
        .filter(Boolean)
    );
  } catch {
    console.warn('[warn] stop_en.txt missing');
    return new Set();
  }
}
const loadCefr = () =>
  safeJson<Record<string, { level: string; pos?: string }>>(
    D('cefr_map.json'),
    {}
  );

async function loadZipf(): Promise<Record<string, number>> {
  const json = D('subtlex_zipf.json');
  const cache = await safeJson<Record<string, number>>(json, {});
  if (Object.keys(cache).length) return cache;

  const xlsxPath = D('SUBTLEX-US.xlsx');
  try {
    await fs.access(xlsxPath);
  } catch {
    console.warn('[warn] SUBTLEX-US.xlsx not found – Zipf fallback 3.5');
    return {};
  }

  const wb = xlsx.read(await fs.readFile(xlsxPath));
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json<Record<string, string>>(ws, {
    raw: false,
  });

  const map: Record<string, number> = {};
  let ok = 0;
  for (const r of rows) {
    // возможные заголовки
    const word = (r.Word ?? r.word ?? r['WORD'] ?? '').toLowerCase();
    const zipfStr =
      r.Zipf ?? r['Zipf-value'] ?? r.ZIPF ?? r.zipf ?? r['Zipf_value'];
    const zipf = parseFloat(zipfStr as string);
    if (word && !Number.isNaN(zipf)) {
      map[word] = zipf;
      ok++;
    }
  }
  if (!ok) console.warn('[warn] 0 rows parsed – проверь названия колонок');
  else {
    await fs.writeFile(json, JSON.stringify(map));
    console.log(`[info] built Zipf map: ${ok} rows`);
  }
  return map;
}

// ---------- WordNet
const wn = new WordNet();
function lookup(
  word: string
): Promise<{ def: string; syn: string[]; pos: string }> {
  return new Promise((res) => {
    wn.lookup(word, (arr) => {
      if (!arr?.length) return res({ def: '', syn: [], pos: 'n' });
      const f = arr[0];
      res({
        def: f.def.split(';')[0],
        syn: [...new Set(arr.flatMap((x) => x.synonyms))].slice(0, 3),
        pos: f.pos,
      });
    });
  });
}

// ---------- types
interface KindleWord {
  word: string;
  count?: number;
  example?: string;
}
interface TierWord {
  word: string;
  lemma: string;
  level: string;
  zipf: number;
  tier: 1 | 2 | 3;
  pos: string;
  example?: string;
}

// ---------- ingest
async function ingest(file: string) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const stop = await loadStop();
  const cefr = await loadCefr();
  const zipfDb = await loadZipf();

  const raw: KindleWord[] = JSON.parse(await fs.readFile(file, 'utf8'));
  const seen = new Set<string>();
  const out: TierWord[] = [];
  const levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

  for (const { word, example } of raw) {
    if (!word) continue;
    const w = word.toLowerCase();
    if (seen.has(w) || stop.has(w)) continue;
    seen.add(w);

    const lemma = (lemmatizer as any).lemmatize
      ? (lemmatizer as any).lemmatize(w)
      : PorterStemmer.stem(w);

    const c = cefr[lemma];
    const level = c?.level ?? 'B2';
    const posTag = c?.pos ?? '';
    const zipf = zipfDb[w] ?? zipfDb[lemma] ?? 3.5;
    const lvlIdx = levels.indexOf(level);
    const tier: 1 | 2 | 3 = lvlIdx >= 3 && zipf < 4 ? 1 : zipf < 5 ? 2 : 3;

    out.push({ word: w, lemma, level, zipf, tier, pos: posTag, example });
  }
  await fs.writeFile('cleaned-words.json', JSON.stringify(out, null, 2));
  const t1 = out.filter((x) => x.tier === 1).length,
    t2 = out.filter((x) => x.tier === 2).length,
    t3 = out.filter((x) => x.tier === 3).length;
  console.log(
    `Cleaned ${raw.length} → ${out.length} | T1 ${t1} T2 ${t2} T3 ${t3}`
  );
}

// ---------- export
async function exportBatch(t: number, batch: number) {
  let words: TierWord[];
  try {
    words = JSON.parse(await fs.readFile('cleaned-words.json', 'utf8'));
  } catch {
    console.error('run ingest first');
    return;
  }

  const sel = words.filter((x) => x.tier === t).slice(0, batch);
  if (!sel.length) {
    console.error('no words for tier');
    return;
  }

  const rows: string[] = [];
  for (const w of sel) {
    const { def, syn, pos } = await lookup(w.word);
    const p = w.pos || pos;
    const ex = (w.example ?? '').slice(0, 120);
    rows.push(
      [
        `${w.word} (${p})`,
        '',
        def,
        ex,
        syn.join(', '),
        `Tier${w.tier}·${w.level}·Zipf ${w.zipf.toFixed(1)}`,
      ]
        .map((s) => s.replace(/\t/g, ' '))
        .join('\t')
    );
  }
  const name = `deck_t${t}_${Date.now()}.tsv`;
  await fs.writeFile(name, rows.join('\n'));
  console.log(`Saved ${rows.length} cards → ${name}`);
}

// ---------- CLI
const argv = yargs(hideBin(process.argv))
  .command('ingest <file>', 'clean + tier', (y) =>
    y.positional('file', { type: 'string' })
  )
  .command('export', 'export TSV', (y) =>
    y
      .option('tier', { type: 'number', demandOption: true })
      .option('batch', { type: 'number', default: 30 })
  )
  .demandCommand(1)
  .strict()
  .help()
  .parseSync();

if (argv._[0] === 'ingest') ingest(argv.file as string);
else if (argv._[0] === 'export')
  exportBatch(argv.tier as number, argv.batch as number);
