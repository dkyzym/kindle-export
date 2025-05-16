#!/usr/bin/env tsx
/* Kindle → Anki CLI
 * ─────────────────────────────────────────────────────────
 * 1)  ingest <words.json>          → data/cleaned-words.json
 * 2)  export --tier N [--batch K]  → data/decks/deck_tN_??.tsv
 *    – batch = 30 по умолчанию     (или --batch 50)
 *    – синонимы и дефиниции берутся из WordNet (natural + wordnet-db)
 * ------------------------------------------------------- */

import fs from 'fs-extra';
import pLimit from 'p-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';
import { hideBin } from 'yargs/helpers';
import yargs from 'yargs/yargs';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore wink-lemmatizer ships without types
import lemmatizer from 'wink-lemmatizer';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore natural is CJS
import natural from 'natural';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore wordnet-db exports { path: string }
import wordnetDb from 'wordnet-db';

/* ────────────── Paths ───────────────────────────────── */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, 'data');
const CLEANED_JSON = path.join(DATA_DIR, 'cleaned-words.json');
const STOP_TXT = path.join(DATA_DIR, 'stop_en.txt');
const KNOWN_TXT = path.join(DATA_DIR, 'known.txt');
const CEFR_JSON = path.join(DATA_DIR, 'cefr_map.json');
const ZIPF_JSON = path.join(DATA_DIR, 'subtlex_zipf.json');
const SUBTLEX_XLSX = path.join(DATA_DIR, 'SUBTLEX-US.xlsx');

/* ────────────── Types ───────────────────────────────── */
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

/* ────────────── Helpers ─────────────────────────────── */
const readJSON = async <T>(p: string): Promise<T> =>
  (await fs.readJSON(p, { throws: false })) as T;

const readLines = async (p: string): Promise<Set<string>> => {
  if (!(await fs.pathExists(p))) return new Set();
  return new Set(
    (await fs.readFile(p, 'utf8'))
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean)
  );
};

/* ───── Zipf map (build once, then cache as JSON) ────── */
const ensureZipfMap = async (): Promise<Record<string, number>> => {
  const cached = await readJSON<Record<string, number>>(ZIPF_JSON);
  if (Object.keys(cached).length) return cached;

  if (!(await fs.pathExists(SUBTLEX_XLSX))) {
    console.warn('⚠ SUBTLEX-US.xlsx missing – Zipf fallback 3.5');
    return {};
  }

  console.log('⧗ Building Zipf map from SUBTLEX-US.xlsx…');
  const wb = XLSX.read(await fs.readFile(SUBTLEX_XLSX));
  const sheet = wb.Sheets[wb.SheetNames[0]];
  type Row = {
    Word: string;
    Zipf?: number;
    ['Zipf-value']?: number;
    Lg10WF?: number;
  };
  const rows: Row[] = XLSX.utils.sheet_to_json(sheet);

  const map: Record<string, number> = {};
  rows.forEach((r) => {
    const w = r.Word?.toLowerCase();
    let z = r.Zipf ?? r['Zipf-value'];
    if (z === undefined && r.Lg10WF) z = r.Lg10WF - 1.707; // convert lg10 → Zipf
    if (w && typeof z === 'number') map[w] = z;
  });

  await fs.writeJSON(ZIPF_JSON, map);
  console.log(`✓ Zipf map cached (${Object.keys(map).length} words)`);
  return map;
};

/* ───── CEFR map ───── */
const ensureCefrMap = async (): Promise<
  Record<string, { level: string; pos?: string }>
> =>
  (await fs.pathExists(CEFR_JSON))
    ? readJSON<Record<string, { level: string; pos?: string }>>(CEFR_JSON)
    : (console.warn('⚠ cefr_map.json missing – default level=B2'), {});

/* ───── Lemma chooser ───── */
const chooseLemma = (
  w: string,
  cefr: Record<string, unknown>,
  zipf: Record<string, number>
): string => {
  const variants = [
    lemmatizer.noun(w),
    lemmatizer.verb(w),
    lemmatizer.adjective(w),
    w,
  ].filter((v) => v && v !== w) as string[];

  for (const v of variants) if (cefr[v] || zipf[v]) return v;
  return variants[0] ?? w;
};

/* ───── Tier logic ───── */
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

/* ────────────── ingest <words.json> ─────────────────── */
const ingest = async (filePath: string) => {
  const [cefr, zipf, stop, known] = await Promise.all([
    ensureCefrMap(),
    ensureZipfMap(),
    readLines(STOP_TXT),
    readLines(KNOWN_TXT),
  ]);
  const raw: RawWord[] = await fs.readJSON(filePath);

  const seen = new Set<string>();
  let skippedStop = 0,
    skippedDup = 0;

  const cleaned: CleanEntry[] = raw
    .map((r) => {
      const wlower = r.word.toLowerCase();
      if (stop.has(wlower)) {
        skippedStop++;
        return;
      }

      const lemma = chooseLemma(wlower, cefr, zipf);
      if (stop.has(lemma)) {
        skippedStop++;
        return;
      }
      if (seen.has(lemma)) {
        skippedDup++;
        return;
      }
      if (known.has(lemma)) return;
      seen.add(lemma);

      const meta = cefr[lemma];
      const z = zipf[wlower] ?? zipf[lemma] ?? 3.5;

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
    `✓ ${cleaned.length} saved | stop ${skippedStop} dup ${skippedDup}` +
      ` | T1 ${t1} T2 ${t2} T3 ${cleaned.length - t1 - t2}`
  );
};

/* ────────────── export --tier N [--batch K] ─────────── */
const WordNet = (natural as any).WordNet;
const wn = new WordNet((wordnetDb as any).path);
const lookupAsync = (lemma: string): Promise<any[]> =>
  new Promise((resolve) =>
    wn.lookup(lemma, (results: any[]) => resolve(results ?? []))
  );

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

const nextBatchId = async (tier: number) => {
  const deckDir = path.join(DATA_DIR, 'decks');
  await fs.ensureDir(deckDir);
  const ids = (await fs.readdir(deckDir))
    .filter((f) => f.startsWith(`deck_t${tier}_`) && f.endsWith('.tsv'))
    .map((f) => Number(/_(\d+)\.tsv$/.exec(f)?.[1] ?? 0));
  return Math.max(0, ...ids) + 1;
};

const exportTier = async (tier: 1 | 2 | 3, batchSize = 30) => {
  if (!(await fs.pathExists(CLEANED_JSON))) {
    console.warn('⚠ Run ingest first.');
    return;
  }
  const all: CleanEntry[] = await readJSON(CLEANED_JSON);
  const list = all
    .filter((e) => e.tier === tier)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .slice(0, batchSize);

  console.log('Batch size', list.length);

  if (!list.length) {
    console.warn(`⚠ Tier ${tier} empty`);
    return;
  }

  const wnCache = new Map<string, { def: string; syn: string[] }>();
  const limit = pLimit(8);

  const tasks = list.map((e) =>
    limit(async () => {
      if (wnCache.has(e.lemma)) return wnCache.get(e.lemma)!;

      let def = '',
        syn: string[] = [];
      try {
        const res: any[] = await lookupAsync(e.lemma);
        if (Array.isArray(res) && res.length) {
          def = res[0].def.split(';')[0];

          const raw = res
            .flatMap((r) => r.synonyms)
            .map((s) => s.trim().toLowerCase()); // ← trim+lc
          const uniq = [...new Set(raw)]; // ← убрать дубли
          const filtered = uniq.filter((s) => s !== e.lemma); // e.lemma уже lc

          syn = (filtered.length ? filtered : uniq).slice(0, 3);
        }
      } catch (err) {
        console.error('WordNet error', e.lemma, err);
      }

      const out = { def, syn }; // всегда формируем объект
      wnCache.set(e.lemma, out);

      return out; // ← гарантированный return
    })
  );

  const defs = await Promise.all(tasks);

  const deckLines = list.map((e, i) =>
    [
      `${e.word} (${e.pos})`,
      '',
      defs[i].def,
      (e.example ?? '').slice(0, 120),
      defs[i].syn.join(', '),
      `Tier${tier}·${e.level}·Zipf ${e.zipf.toFixed(2)}`,
    ].join('\t')
  );

  const deckDir = path.join(DATA_DIR, 'decks');
  await fs.ensureDir(deckDir);
  const fname = path.join(
    deckDir,
    `deck_t${tier}_${pad(await nextBatchId(tier))}.tsv`
  );
  await fs.writeFile(fname, deckLines.join('\n'));
  console.log(`✓ deck ${path.basename(fname)} created (${deckLines.length})`);
};

/* ────────────── CLI ─────────────────────────────────── */
yargs(hideBin(process.argv))
  .command(
    'ingest <file>',
    'Parse Kindle words',
    (y) => y.positional('file', { type: 'string' }),
    (a) => ingest(path.resolve(String(a.file)))
  )
  .command(
    'export',
    'Create Anki deck',
    (y) =>
      y
        .option('tier', {
          type: 'number',
          choices: [1, 2, 3],
          demandOption: true,
        })
        .option('batch', {
          type: 'number',
          describe: 'how many words',
          default: 30,
        }),
    (a) => exportTier(a.tier as 1 | 2 | 3, a.batch as number)
  )
  .demandCommand(1)
  .strict()
  .help()
  .parse();
