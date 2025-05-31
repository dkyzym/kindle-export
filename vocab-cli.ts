#!/usr/bin/env tsx
/* Kindle → Anki CLI
 * ─────────────────────────────────────────────────────────
 * 1)  ingest <words.json>       → data/cleaned-words.json
 * 2)  export --tier N [--batch K] → data/decks/deck_tN_??.tsv
 * – batch = 30 по умолчанию   (или --batch 50)
 * – синонимы и дефиниции берутся из WordNet (natural + wordnet-db)
 * ------------------------------------------------------- */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore compromise ships w/o full TS types
import nlp from 'compromise';
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

/* ─────────────── Types (Illustrative) ──────────────── */
interface RawWord {
  word: string;
  example?: string;
  count?: number; // How many times it was looked up/highlighted
}

interface CleanEntry extends RawWord {
  lemma: string;
  level: string; // CEFR level like A1, B2
  pos: string; // Part of speech: noun, verb, adj, adv
  zipf: number; // Zipf frequency score
  tier: 1 | 2 | 3;
}

interface WNResult {
  lemma: string;
  pos: string; // n, v, a, r, s
  synonyms: string[];
  def: string;
  meta?: {
    freqCnt?: number; // WordNet sense frequency count
  };
  // ... other WordNet fields
}

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
const SKIPPED_STOP_WORDS_FILE = path.join(DATA_DIR, 'skipped_stop_words.txt');
const SKIPPED_DUPLICATE_LEMMAS_FILE = path.join(
  DATA_DIR,
  'skipped_duplicate_lemmas.txt'
);

/* ────────────── Helpers ─────────────────────────────── */

// ── выбрали наиболее частотный sense, желательно нужной POS ─────────

/** Быстрая попытка угадать POS по примеру */
/** Определяем POS из примера: plural-noun и participle-adjective ловим вручную */
const posFromExample = (example: string, lemma: string): string => {
  if (!example) return '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc: any = nlp(example);

  // 1) примитивный plural-noun  (beads  ↔  bead)
  const pluralForm = lemma.endsWith('s') ? lemma + 'es' : lemma + 's'; // work → works, bead → beads
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termPlural: any = doc.match(pluralForm).terms().get(0);

  // 2) exact lemma
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termExact: any = doc.match(lemma).terms().get(0);

  // 3) fallback: первый токен с тем же текстом
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const term: any =
    termExact ||
    termPlural ||
    doc.termList().find((t: any) => t.text === lemma);

  if (!term) return '';

  if (term.tags?.Noun) return 'noun';
  if (term.tags?.Verb) {
    // причастие -ed, -ing → чаще всего adj
    if (lemma.endsWith('ed') || lemma.endsWith('ing')) return 'adjective';
    return 'verb';
  }
  if (term.tags?.Adjective) return 'adjective';
  if (term.tags?.Adverb) return 'adverb';
  return '';
};

function pickBestSense(results: WNResult[], desiredPos = ''): WNResult | null {
  if (!results?.length) return null;

  const samePos = desiredPos
    ? results.filter((r) => mapWordNetPosToStandard(r.pos) === desiredPos)
    : [];

  // сортируем по freqCnt (больше → чаще)
  const sorted = (samePos.length ? samePos : results).sort(
    (a, b) => (b.meta?.freqCnt ?? 0) - (a.meta?.freqCnt ?? 0)
  );

  let best = sorted[0] ?? null;

  /* NEW: если просили noun, а нашли adj-sense (boon), пробуем найти noun-sense */
  if (
    desiredPos === 'noun' &&
    best &&
    mapWordNetPosToStandard(best.pos) !== 'noun'
  ) {
    const nounSense = sorted.find(
      (r) => mapWordNetPosToStandard(r.pos) === 'noun'
    );
    if (nounSense) best = nounSense;
  }
  return best;
}

// Helper function to map WordNet POS tags to standard strings
const mapWordNetPosToStandard = (wnPosTag: string | undefined): string => {
  switch (wnPosTag?.toLowerCase()) {
    case 'n':
      return 'noun';
    case 'v':
      return 'verb';
    case 'a':
      return 'adjective'; // Adjective
    case 's':
      return 'adjective'; // Adjective satellite
    case 'r':
      return 'adverb';
    default:
      return ''; // Return empty if unknown or undefined
  }
};

const wnPosCache = new Map<string, string>();

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
  if (cached && Object.keys(cached).length) return cached;

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
  cefr: Record<string, { level: string; pos?: string }>,
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

/* WordNet instance and lookup function (globally available for ingest and export) */
const WordNet = (natural as any).WordNet;
const wn = new WordNet((wordnetDb as any).path);
const lookupAsync = (lemma: string): Promise<any[]> =>
  new Promise((resolve) =>
    wn.lookup(lemma, (results: any[]) => resolve(results ?? []))
  );

/* ────────────── ingest <words.json> ─────────────────── */
const ingest = async (filePath: string) => {
  await fs.ensureDir(DATA_DIR);

  const [cefr, zipf, stop, known] = await Promise.all([
    ensureCefrMap(),
    ensureZipfMap(),
    readLines(STOP_TXT),
    readLines(KNOWN_TXT),
  ]);
  const rawWords: RawWord[] = await fs.readJSON(filePath);

  const seen = new Set<string>();
  const loggedStopWords: string[] = [];
  const loggedDuplicateLemmas: string[] = [];
  let skippedStop = 0,
    skippedDup = 0;

  // Limit for concurrent WordNet lookups during ingest
  const wnLookupLimit = pLimit(8);

  // Process words, making the map callback async to use await for WordNet lookup
  const cleanedPromises = rawWords.map((r) =>
    wnLookupLimit(async () => {
      // Apply pLimit to the async operation
      if (!r.word || r.word.trim() === '') {
        return undefined; // Explicitly return undefined for later filtering
      }
      const wlower = r.word.toLowerCase();

      if (stop.has(wlower)) {
        skippedStop++;
        loggedStopWords.push(wlower);
        return undefined;
      }

      const lemma = chooseLemma(wlower, cefr, zipf);

      if (stop.has(lemma)) {
        skippedStop++;
        loggedStopWords.push(`${wlower} (lemma: ${lemma})`);
        return undefined;
      }

      if (seen.has(lemma)) {
        skippedDup++;
        loggedDuplicateLemmas.push(lemma);
        return undefined;
      }

      if (known.has(lemma)) {
        return undefined;
      }

      seen.add(lemma);

      const cefrDataForLemma = cefr[lemma];
      const z = zipf[wlower] ?? zipf[lemma] ?? 3.5;

      // 1️⃣   ——— часть речи: WordNet → heur → CEFR ———
      let finalPos = '';

      // (а) сначала WordNet с кэшем
      if (wnPosCache.has(lemma)) {
        finalPos = wnPosCache.get(lemma)!;
      } else {
        try {
          const wnResults = await lookupAsync(lemma);
          if (wnResults?.length) {
            finalPos = mapWordNetPosToStandard(wnResults[0].pos);
          }
          wnPosCache.set(lemma, finalPos); // кэшируем даже '', чтобы не дёргать повторно
        } catch (err) {
          console.error(`WordNet error for '${lemma}':`, err);
        }
      }

      // (б) лёгкая эвристика (совсем редкие случаи)
      if (!finalPos) {
        if (lemma.endsWith('ly')) finalPos = 'adverb';
        else if (lemma.endsWith('ing') || lemma.endsWith('ed'))
          finalPos = 'verb';
        else if (lemma.endsWith('ness') || lemma.endsWith('tion'))
          finalPos = 'noun';
        else if (
          lemma.endsWith('ous') ||
          lemma.endsWith('ive') ||
          lemma.endsWith('ful')
        )
          finalPos = 'adjective';
      }

      // (в) fallback → CEFR
      const cefrPos = cefrDataForLemma?.pos ?? '';
      if (!finalPos && cefrPos) finalPos = cefrPos;

      // (г) логировать расхождения (необязательно, но полезно)
      if (finalPos && cefrPos && finalPos !== cefrPos) {
        fs.appendFile(
          path.join(DATA_DIR, 'cefr_pos_mismatches.log'),
          `${lemma}\tWN:${finalPos}\tCEFR:${cefrPos}\n`
        ).catch(() => {}); // не тормозим ingest
      }

      // (д) если у слова есть пример — сверяем с контекстом
      if (r.example) {
        const ctxPos = posFromExample(r.example, lemma);
        if (ctxPos && ctxPos !== finalPos) finalPos = ctxPos;
      }

      const entry: CleanEntry = {
        ...r,
        lemma,
        level: cefrDataForLemma?.level ?? 'B2',
        pos: finalPos, // Use the potentially WordNet-enhanced POS
        zipf: z,
        tier: 3, // Default tier, will be updated by decideTier
      };
      entry.tier = decideTier(entry);
      return entry;
    })
  );

  // Wait for all promises to resolve and filter out undefined entries
  const processedEntries = await Promise.all(cleanedPromises);
  const cleaned: CleanEntry[] = processedEntries.filter(
    Boolean
  ) as CleanEntry[];

  if (loggedStopWords.length > 0) {
    await fs.writeFile(SKIPPED_STOP_WORDS_FILE, loggedStopWords.join('\n'));
    console.log(
      `ℹ ${loggedStopWords.length} stop words/lemmas written to ${path.basename(
        SKIPPED_STOP_WORDS_FILE
      )}`
    );
  }

  if (loggedDuplicateLemmas.length > 0) {
    await fs.writeFile(
      SKIPPED_DUPLICATE_LEMMAS_FILE,
      loggedDuplicateLemmas.join('\n')
    );
    console.log(
      `ℹ ${
        loggedDuplicateLemmas.length
      } duplicate lemmas written to ${path.basename(
        SKIPPED_DUPLICATE_LEMMAS_FILE
      )}`
    );
  }

  await fs.writeJSON(CLEANED_JSON, cleaned, { spaces: 0 });

  const t1 = cleaned.filter((e) => e.tier === 1).length;
  const t2 = cleaned.filter((e) => e.tier === 2).length;
  console.log(
    `✓ ${cleaned.length} words saved to ${path.basename(
      CLEANED_JSON
    )} | Skipped: stop ${skippedStop}, duplicates ${skippedDup}` +
      ` | Tiers: T1 ${t1}, T2 ${t2}, T3 ${cleaned.length - t1 - t2}`
  );
};

/* ────────────── export --tier N [--batch K] ─────────── */
// WordNet instance and lookupAsync are already defined globally

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

const nextBatchId = async (tier: number): Promise<number> => {
  const deckDir = path.join(DATA_DIR, 'decks');
  await fs.ensureDir(deckDir);
  const files = await fs.readdir(deckDir);
  const ids = files
    .filter((f) => f.startsWith(`deck_t${tier}_`) && f.endsWith('.tsv'))
    .map((f) => {
      const match = /_(\d+)\.tsv$/.exec(f);
      return match?.[1] ? Number(match[1]) : 0;
    })
    .filter((id) => id > 0);

  if (ids.length === 0) return 1;
  return Math.max(...ids) + 1;
};

const exportTier = async (tier: 1 | 2 | 3, batchSize = 30) => {
  if (!(await fs.pathExists(CLEANED_JSON))) {
    console.warn('⚠ Run ingest first. Cleaned words JSON not found.');
    return;
  }
  const allCleanedWords: CleanEntry[] = await readJSON(CLEANED_JSON);
  if (
    !allCleanedWords ||
    !Array.isArray(allCleanedWords) ||
    allCleanedWords.length === 0
  ) {
    console.warn('⚠ Cleaned words data is invalid or empty.');
    return;
  }

  /* ──────────────────────────────────────────────────────────────── */
  /* 0. Собираем леммы, которые уже оказались в готовых колодах      */
  /* deck_t{tier}_XX.tsv считаются «источником правды»            */
  /* ──────────────────────────────────────────────────────────────── */

  const deckDir = path.join(DATA_DIR, 'decks'); // единое имя в функции
  await fs.ensureDir(deckDir);

  const exported = new Set<string>();
  const deckFiles = (await fs.readdir(deckDir)).filter(
    (f) => f.startsWith(`deck_t${tier}_`) && f.endsWith('.tsv')
  );

  for (const f of deckFiles) {
    const lines = (await fs.readFile(path.join(deckDir, f), 'utf8')).split(
      /\r?\n/
    );
    for (const line of lines) {
      const [firstCol] = line.split('\t'); // Now this will be just "word" for new files, or "word (pos)" for old files
      if (!firstCol) continue;
      // This logic should still work: if "word (pos)", it takes "word". If just "word", it takes "word".
      const lemma = firstCol.split(' ')[0].toLowerCase();
      exported.add(lemma);
    }
  }

  /**
   * Сортируем слова сначала по частоте выделения, затем по числу Zipf в порядке убывания
   */
  const wordsForTier = allCleanedWords
    .filter((e) => e.tier === tier && !exported.has(e.lemma))
    .sort((a, b) => {
      const diff = (b.count ?? 0) - (a.count ?? 0); // ① выделения
      if (diff !== 0) return diff;
      return (b.zipf ?? 0) - (a.zipf ?? 0); // ② Zipf: выше → раньше
    });

  const currentBatchNum = await nextBatchId(tier);
  // Corrected startIndex calculation: if currentBatchNum is 1, startIndex should be 0.
  // The nextBatchId logic returns 1 for the first batch.
  // So, if we want batches of 30:
  // Batch 1: words 0-29
  // Batch 2: words 30-59
  // This means startIndex should be (currentBatchNum - 1) * batchSize
  const startIndex = (currentBatchNum - 1) * batchSize;
  // endIndex is exclusive, so it's fine as currentBatchNum * batchSize
  const endIndex = startIndex + batchSize; // Corrected: endIndex should be relative to startIndex

  const currentBatchList = wordsForTier.slice(startIndex, endIndex);

  console.log(
    `Preparing batch #${currentBatchNum} for tier ${tier}. Aiming for ${batchSize} words.`
  );

  if (!currentBatchList.length) {
    // Check if there are any words available for this tier at all
    const totalWordsInTierNotExported = wordsForTier.length;
    if (totalWordsInTierNotExported === 0) {
      console.warn(`⚠ Tier ${tier} has no words left to export.`);
    } else {
      console.warn(
        `⚠ Tier ${tier} has no more words to export for batch #${currentBatchNum} (startIndex: ${startIndex}, total available for tier: ${totalWordsInTierNotExported}). All words might have been exported in previous batches.`
      );
    }
    return;
  }

  console.log(
    `Selected ${
      currentBatchList.length
    } words for this batch (from index ${startIndex} to ${endIndex - 1}).`
  );

  const wnCache = new Map<string, { def: string; syn: string[] }>();
  const limit = pLimit(8); // Limit for WordNet lookups in export

  const tasks = currentBatchList.map((entry) =>
    limit(async () => {
      if (wnCache.has(entry.lemma)) return wnCache.get(entry.lemma)!;

      let definition = '';
      let synonyms: string[] = [];

      try {
        const results: any[] = await lookupAsync(entry.lemma);

        const best = pickBestSense(
          results as WNResult[],
          entry.pos // ← noun/verb/…
        );

        if (best) {
          definition = best.def.split(';')[0].trim();

          // берём только синонимы той же POS
          const synSetPos = mapWordNetPosToStandard(best.pos);
          const raw = (results as WNResult[])
            .filter((r) => mapWordNetPosToStandard(r.pos) === synSetPos)
            .flatMap((r) => r.synonyms);

          const uniq = [
            ...new Set(
              raw.map((s) => s.replace(/_/g, ' ').trim().toLowerCase())
            ),
          ];

          synonyms = uniq
            .filter((s) => s && s !== entry.lemma.toLowerCase())
            .slice(0, 3); // макс. 3 шт.
        }
      } catch (err) {
        console.error(`Error looking up '${entry.lemma}' in WordNet:`, err);
      }

      const wordNetData = { def: definition, syn: synonyms };
      wnCache.set(entry.lemma, wordNetData);
      return wordNetData;
    })
  );

  const wordNetResults = await Promise.all(tasks);

  // MODIFIED PART: Constructing deckLines with separate POS field
  const deckLines = currentBatchList.map((entry, index) =>
    [
      entry.word, // Field 1: Word
      entry.pos || 'N/A', // Field 2: Part of Speech (NEW)
      '', // Field 3: (empty, for audio/image placeholder)
      wordNetResults[index].def, // Field 4: Definition
      (entry.example ?? '').slice(0, 120), // Field 5: Example
      wordNetResults[index].syn.join(', '), // Field 6: Synonyms
      `Tier${tier}·${entry.level}·Zipf ${entry.zipf.toFixed(2)}`, // Field 7: Tags/Metadata
    ].join('\t')
  );

  const filename = path.join(
    deckDir,
    `deck_t${tier}_${pad(currentBatchNum)}.tsv`
  );

  await fs.writeFile(filename, deckLines.join('\n'));
  console.log(
    `✓ Deck created: ${path.basename(filename)} (${deckLines.length} words)`
  );
};

/* ────────────── CLI ─────────────────────────────────── */
yargs(hideBin(process.argv))
  .command(
    'ingest <file>',
    'Parse Kindle words from JSON and prepare them.',
    (y) =>
      y.positional('file', {
        describe: 'Path to the JSON file containing words (e.g., vocab.json)',
        type: 'string',
        demandOption: 'Please provide the path to the words JSON file.',
      }),
    (argv) => {
      if (!argv.file) {
        console.error(
          'Error: Missing required argument <file> for ingest command.'
        );
        process.exit(1);
      }
      ingest(path.resolve(String(argv.file)));
    }
  )
  .command(
    'export',
    'Create Anki deck (TSV file) from processed words.',
    (y) =>
      y
        .option('tier', {
          describe: 'The learning tier to export words from.',
          type: 'number',
          choices: [1, 2, 3] as const,
          demandOption: 'Please specify a tier (1, 2, or 3).',
        })
        .option('batch', {
          describe: 'Maximum number of words per deck file.',
          type: 'number',
          default: 30,
        }),
    (argv) => {
      const tier = argv.tier as 1 | 2 | 3;
      const batchSize = argv.batch as number; // yargs ensures this is a number
      exportTier(tier, batchSize);
    }
  )
  .demandCommand(
    1,
    'You need to specify at least one command (ingest or export).'
  )
  .strict()
  .help('h')
  .alias('h', 'help')
  .alias('v', 'version')
  .epilog('For more information, visit the repository.')
  .parse();
