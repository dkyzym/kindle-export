#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore wink-lemmatizer has no types
import lemmatizer from 'wink-lemmatizer';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore natural is CJS
import natural from 'natural';
import util from 'util';
import * as XLSX from 'xlsx';

/* --------------------------------------------------
 * Paths & constants
 * -------------------------------------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, 'data');
const CLEANED_JSON = path.resolve(DATA_DIR, 'cleaned-words.json');
const KNOWN_TXT = path.resolve(DATA_DIR, 'known.txt');
const STOP_TXT = path.resolve(DATA_DIR, 'stop_en.txt');
const CEFR_JSON = path.resolve(DATA_DIR, 'cefr_map.json');
const ZIPF_JSON = path.resolve(DATA_DIR, 'subtlex_zipf.json');
const SUBTLEX_XLSX = path.resolve(DATA_DIR, 'SUBTLEX-US.xlsx');

/* --------------------------------------------------
 * Types
 * -------------------------------------------------- */
interface RawWord {
  word: string;
  stem?: string;
  example?: string;
  count?: number;
}
interface CleanEntry extends RawWord {
  lemma: string;
  level: string;
  pos: string;
  zipf: number;
  tier: 1 | 2 | 3;
}

/* --------------------------------------------------
 * Generic helpers
 * -------------------------------------------------- */
const readJSON = async <T>(p: string): Promise<T> =>
  (await fs.readJSON(p, { throws: false })) as T;
const readLines = async (p: string): Promise<Set<string>> => {
  if (!(await fs.pathExists(p))) return new Set();
  const txt = await fs.readFile(p, 'utf8');
  return new Set(
    txt
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean)
  );
};

/* --------------------------------------------------
 * Zipf map (lazy build)
 * -------------------------------------------------- */
const ensureZipfMap = async (): Promise<Record<string, number>> => {
  if (await fs.pathExists(ZIPF_JSON)) {
    return readJSON(ZIPF_JSON);
  }
  if (!(await fs.pathExists(SUBTLEX_XLSX))) {
    console.warn('⚠ SUBTLEX-US.xlsx not found → all Zipf fallback to 3.5');
    return {};
  }
  console.log('⧗ Building Zipf map from SUBTLEX-US.xlsx …');
  const wb = XLSX.read(await fs.readFile(SUBTLEX_XLSX));
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: { Word: string; Zipf?: number; ['Zipf-value']?: number }[] =
    XLSX.utils.sheet_to_json(sheet);
  const map: Record<string, number> = {};
  rows.forEach((r) => {
    const z = (r.Zipf ?? r['Zipf-value']) as number | undefined;
    if (typeof z === 'number') map[r.Word.toLowerCase()] = z;
  });
  await fs.writeJSON(ZIPF_JSON, map);
  console.log(`✓ Zipf map cached (${Object.keys(map).length} entries)`);
  return map;
};

/* --------------------------------------------------
 * CEFR map loader
 * -------------------------------------------------- */
const ensureCefrMap = async (): Promise<
  Record<string, { level: string; pos?: string }>
> => {
  if (!(await fs.pathExists(CEFR_JSON))) {
    console.warn('⚠ cefr_map.json missing — all words default to level B2');
    return {};
  }
  return readJSON(CEFR_JSON);
};

/* --------------------------------------------------
 * Lemmatization helper
 * -------------------------------------------------- */
const chooseLemma = (
  word: string,
  cefr: Record<string, any>,
  zipf: Record<string, number>
): string => {
  const w = word.toLowerCase();
  const variants = [
    w,
    lemmatizer.noun(w),
    lemmatizer.verb(w),
    lemmatizer.adjective(w),
  ].filter(Boolean) as string[];
  for (const v of variants) if (cefr[v] || zipf[v]) return v;
  return variants[1] ?? w; // at least lemma candidate
};

/* --------------------------------------------------
 * Tier logic
 * -------------------------------------------------- */
const levelRank: Record<string, number> = {
  A1: 0,
  A2: 1,
  B1: 2,
  B2: 3,
  C1: 4,
  C2: 5,
};
const decideTier = (
  e: Pick<CleanEntry, 'level' | 'zipf' | 'count'>
): 1 | 2 | 3 => {
  const cnt = e.count ?? 0;
  if ((levelRank[e.level] >= levelRank.B2 && e.zipf < 4) || cnt >= 5) return 1;
  if (e.zipf < 5) return 2;
  return 3;
};

/* --------------------------------------------------
 * ingest command
 * -------------------------------------------------- */
const ingest = async (filePath: string): Promise<void> => {
  const [cefr, zipf, known, stop] = await Promise.all([
    ensureCefrMap(),
    ensureZipfMap(),
    readLines(KNOWN_TXT),
    readLines(STOP_TXT),
  ]);

  const raw: RawWord[] = await fs.readJSON(filePath);
  const seen = new Set<string>();

  let skippedStop = 0;
  let skippedDup = 0;

  const cleaned: CleanEntry[] = raw
    .map((r) => {
      const lemma = chooseLemma(r.word, cefr, zipf);
      if (stop.has(lemma)) {
        skippedStop++;
        return undefined;
      }
      if (seen.has(lemma)) {
        skippedDup++;
        return undefined;
      }
      seen.add(lemma);
      if (known.has(lemma)) return undefined;
      const meta = cefr[lemma];
      const z = zipf[r.word.toLowerCase()] ?? zipf[lemma] ?? 3.5;
      const entry: CleanEntry = {
        ...r,
        lemma,
        level: meta?.level ?? 'B2',
        pos: meta?.pos ?? '',
        zipf: z,
        tier: 3,
      };
      entry.tier = decideTier(entry);
      return entry;
    })
    .filter(Boolean) as CleanEntry[];

  await fs.writeJSON(CLEANED_JSON, cleaned, { spaces: 0 });

  const t1 = cleaned.filter((e) => e.tier === 1).length;
  const t2 = cleaned.filter((e) => e.tier === 2).length;
  console.log(
    `✓ ${
      cleaned.length
    } saved | stop ${skippedStop} dup ${skippedDup} | T1 ${t1} T2 ${t2} T3 ${
      cleaned.length - t1 - t2
    }`
  );
};

/* --------------------------------------------------
 * export command
 * -------------------------------------------------- */
const WordNet = (natural as any).WordNet;
const wn = new WordNet();
const lookupAsync = util.promisify(wn.lookup.bind(wn));

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

const nextBatchId = async (tier: number): Promise<number> => {
  const deckDir = path.resolve(DATA_DIR, 'decks');
  await fs.ensureDir(deckDir);
  const files = await fs.readdir(deckDir);
  const ids = files
    .filter((f) => f.startsWith(`deck_t${tier}_`) && f.endsWith('.tsv'))
    .map((f) => Number(/_(\d+)\.tsv$/.exec(f)?.[1] ?? 0));
  return Math.max(0, ...ids) + 1;
};

const exportTier = async (tier: 1 | 2 | 3, batch?: number): Promise<void> => {
  if (!(await fs.pathExists(CLEANED_JSON))) {
    console.warn('⚠ cleaned-words.json not found. Run ingest first.');
    return;
  }
  const cleaned: CleanEntry[] = await readJSON(CLEANED_JSON);
  const list = cleaned
    .filter((e) => e.tier === tier)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));

  const deckLines: string[] = [];
  for (const e of list) {
    const res: any[] = await lookupAsync(e.lemma).catch(() => []);
    const defs = Array.isArray(res)
      ? res.map((r) => r.def).filter(Boolean)
      : [];
    const syns = Array.isArray(res)
      ? res.flatMap((r) => r.synonyms).filter((s: string) => s !== e.lemma)
      : [];

    deckLines.push(
      [
        `${e.word} (${e.pos})`,
        '',
        defs[0] ?? '',
        (e.example ?? '').slice(0, 120),
        syns.slice(0, 3).join(', '),
        `Tier${tier}·${e.level}·Zipf ${e.zipf}`,
      ].join('\t')
    );
  }

  const batchId = batch ?? (await nextBatchId(tier));
  const deckDir = path.resolve(DATA_DIR, 'decks');
  await fs.ensureDir(deckDir);
  const fname = path.resolve(deckDir, `deck_t${tier}_${pad(batchId)}.tsv`);
  await fs.writeFile(fname, deckLines.join('\n'), 'utf8');
  console.log(`✓ deck ${path.basename(fname)} created (${deckLines.length})`);
};

/* --------------------------------------------------
 * CLI
 * -------------------------------------------------- */
yargs(hideBin(process.argv))
  .command(
    'ingest <file>',
    'Parse Kindle words.json',
    (y) => y.positional('file', { type: 'string' }),
    (argv) => ingest(path.resolve(String((argv as any).file)))
  )
  .command(
    'export',
    'Create Anki deck',
    (y) =>
      y
        .option('tier', {
          type: 'number',
          choices: [1, 2, 3] as const,
          demandOption: true,
        })
        .option('batch', { type: 'number' }),
    (argv) =>
      exportTier(argv.tier as 1 | 2 | 3, argv.batch as number | undefined)
  )
  .demandCommand(1)
  .strict()
  .help()
  .parse();
