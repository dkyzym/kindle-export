#!/usr/bin/env tsx
/* Kindle → Anki CLI
 * ─────────────────────────────────────────────────────────
 * 1)  ingest <words.json>       → data/cleaned-words.json
 * 2)  export --tier N [--batch K] → data/decks/deck_tN_??.tsv
 * – batch = 30 по умолчанию   (или --batch 50)
 * – синонимы и дефиниции берутся из WordNet (natural + wordnet-db)
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
const SKIPPED_STOP_WORDS_FILE = path.join(DATA_DIR, 'skipped_stop_words.txt');
const SKIPPED_DUPLICATE_LEMMAS_FILE = path.join(
  DATA_DIR,
  'skipped_duplicate_lemmas.txt'
);

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
  if (cached && Object.keys(cached).length) return cached; // Check if cached is not null

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

/* ────────────── ingest <words.json> ─────────────────── */
const ingest = async (filePath: string) => {
  await fs.ensureDir(DATA_DIR); // Ensure data directory exists

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
  let skippedStop = 0, // Counter for stop words/lemmas
    skippedDup = 0; // Counter for duplicate lemmas

  const cleaned: CleanEntry[] = rawWords
    .map((r) => {
      // Skip if word is missing or effectively empty (e.g., only whitespace)
      if (!r.word || r.word.trim() === '') {
        // console.warn(`Skipping entry with missing or empty word: ${JSON.stringify(r)}`); // Optional: for debugging input
        return;
      }
      const wlower = r.word.toLowerCase();

      // Check if the lowercase word itself is a stop word
      if (stop.has(wlower)) {
        skippedStop++;
        loggedStopWords.push(wlower);
        return;
      }

      // Determine the lemma for the word
      const lemma = chooseLemma(wlower, cefr, zipf);

      // Check if the lemma is a stop word
      if (stop.has(lemma)) {
        skippedStop++;
        // Log both original word and its lemma if the lemma was the stop word
        loggedStopWords.push(`${wlower} (lemma: ${lemma})`);
        return;
      }

      // Check if the lemma has already been seen (duplicate)
      // This check is done before the 'known' check as per original logic.
      // If a word is a duplicate, it's logged as such.
      if (seen.has(lemma)) {
        skippedDup++;
        loggedDuplicateLemmas.push(lemma);
        return;
      }

      // Check if the lemma is in the list of known words
      // If known, skip without logging as duplicate or adding to 'seen' for further processing.
      if (known.has(lemma)) {
        return;
      }

      // If the lemma is not a stop word, not a duplicate, and not known, add it to 'seen'
      seen.add(lemma);

      // Get CEFR metadata and Zipf score
      const meta = cefr[lemma];
      const z = zipf[wlower] ?? zipf[lemma] ?? 3.5; // Fallback Zipf score

      // Create the clean entry object
      const entry: CleanEntry = {
        ...r, // Spread original raw word properties (includes original 'word' casing, 'example', 'count')
        lemma,
        level: meta?.level ?? 'B2', // Default CEFR level
        pos: meta?.pos ?? '', // Default Part of Speech
        zipf: z,
        tier: 3, // Default tier, will be updated by decideTier
      };
      entry.tier = decideTier(entry); // Determine the learning tier
      return entry;
    })
    .filter(Boolean) as CleanEntry[]; // Filter out any undefined entries from skipped words

  // Write logged stop words to a file
  if (loggedStopWords.length > 0) {
    await fs.writeFile(SKIPPED_STOP_WORDS_FILE, loggedStopWords.join('\n'));
    console.log(
      `ℹ ${loggedStopWords.length} stop words/lemmas written to ${path.basename(
        SKIPPED_STOP_WORDS_FILE
      )}`
    );
  }

  // Write logged duplicate lemmas to a file
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

  // Write the cleaned words to the main JSON output file
  await fs.writeJSON(CLEANED_JSON, cleaned, { spaces: 0 });

  // Calculate tier distributions for the console log
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
const WordNet = (natural as any).WordNet;
const wn = new WordNet((wordnetDb as any).path); // Initialize WordNet
const lookupAsync = (lemma: string): Promise<any[]> =>
  new Promise((resolve) =>
    wn.lookup(lemma, (results: any[]) => resolve(results ?? []))
  );

// Helper to pad numbers for filenames (e.g., 1 -> 01)
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

// Determines the next batch number for a given tier
const nextBatchId = async (tier: number): Promise<number> => {
  const deckDir = path.join(DATA_DIR, 'decks');
  await fs.ensureDir(deckDir); // Ensure the 'decks' directory exists
  const files = await fs.readdir(deckDir);
  const ids = files
    .filter((f) => f.startsWith(`deck_t${tier}_`) && f.endsWith('.tsv'))
    .map((f) => {
      const match = /_(\d+)\.tsv$/.exec(f); // Regex to extract batch number
      return match?.[1] ? Number(match[1]) : 0;
    })
    .filter((id) => id > 0); // Consider only valid positive batch numbers

  if (ids.length === 0) return 1; // If no batches exist, start with batch 1
  return Math.max(...ids) + 1; // Otherwise, increment the highest existing batch number
};

const exportTier = async (tier: 1 | 2 | 3, batchSize = 30) => {
  // Check if cleaned words data exists
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

  // Filter words for the specified tier and sort them by count (descending)
  const wordsForTier = allCleanedWords
    .filter((e) => e.tier === tier)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));

  // Determine the batch number for the current export operation
  const currentBatchNum = await nextBatchId(tier);

  // Calculate start and end indices for slicing the current batch
  const startIndex = (currentBatchNum - 1) * batchSize;
  const endIndex = currentBatchNum * batchSize;

  // Slice the sorted words to get the list for the current batch
  const currentBatchList = wordsForTier.slice(startIndex, endIndex);

  console.log(
    `Preparing batch #${currentBatchNum} for tier ${tier}. Aiming for ${batchSize} words.`
  );

  // If no words are found for the current batch, warn and exit
  if (!currentBatchList.length) {
    console.warn(
      `⚠ Tier ${tier} has no more words to export for batch #${currentBatchNum} (startIndex: ${startIndex}, total for tier: ${wordsForTier.length}).`
    );
    return;
  }
  console.log(
    `Selected ${
      currentBatchList.length
    } words for this batch (from index ${startIndex} to ${endIndex - 1}).`
  );

  // Cache for WordNet lookups to avoid redundant API calls
  const wnCache = new Map<string, { def: string; syn: string[] }>();
  const limit = pLimit(8); // Limit concurrent WordNet lookups for performance

  // Asynchronously fetch definitions and synonyms from WordNet for each word in the batch
  const tasks = currentBatchList.map((entry) =>
    limit(async () => {
      if (wnCache.has(entry.lemma)) return wnCache.get(entry.lemma)!; // Use cached result if available

      let definition = '';
      let synonyms: string[] = [];
      try {
        const results: any[] = await lookupAsync(entry.lemma);
        if (Array.isArray(results) && results.length) {
          // Take the first part of the definition
          definition = results[0].def.split(';')[0].trim();

          // Process synonyms: flatten, trim, lowercase, remove underscores, ensure uniqueness
          const rawSynonyms = results
            .flatMap((r) => r.synonyms)
            .map((s: string) => s.trim().toLowerCase().replace(/_/g, ' '));
          const uniqueSynonyms = [...new Set(rawSynonyms)];
          // Exclude the lemma itself from its synonyms
          const filteredSynonyms = uniqueSynonyms.filter(
            (s) => s !== entry.lemma.toLowerCase()
          );

          // Use filtered synonyms if available, otherwise fall back to unique ones (if lemma was the only synonym)
          // Limit to a maximum of 3 synonyms
          synonyms = (
            filteredSynonyms.length ? filteredSynonyms : uniqueSynonyms
          ).slice(0, 3);
        }
      } catch (err) {
        console.error(`Error looking up '${entry.lemma}' in WordNet:`, err);
      }

      const wordNetData = { def: definition, syn: synonyms };
      wnCache.set(entry.lemma, wordNetData); // Cache the result
      return wordNetData;
    })
  );

  const wordNetResults = await Promise.all(tasks); // Execute all WordNet lookup tasks

  // Prepare lines for the TSV (Tab-Separated Values) file
  const deckLines = currentBatchList.map(
    (entry, index) =>
      [
        `${entry.word} (${entry.pos || 'N/A'})`, // Field 1: Word (Part of Speech)
        '', // Field 2: Placeholder (e.g., for audio, images)
        wordNetResults[index].def, // Field 3: Definition
        (entry.example ?? '').slice(0, 120), // Field 4: Example sentence (truncated)
        wordNetResults[index].syn.join(', '), // Field 5: Synonyms (comma-separated)
        `Tier${tier}·${entry.level}·Zipf ${entry.zipf.toFixed(2)}`, // Field 6: Tags
      ].join('\t') // Join fields with a tab character
  );

  const deckDir = path.join(DATA_DIR, 'decks');
  await fs.ensureDir(deckDir); // Ensure 'decks' directory exists (redundant if nextBatchId was called, but safe)

  // Construct the filename for the deck
  const filename = path.join(
    deckDir,
    `deck_t${tier}_${pad(currentBatchNum)}.tsv`
  );

  // Write the deck lines to the TSV file
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
        // Should be caught by demandOption, but good practice
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
          choices: [1, 2, 3] as const, // Ensure choices are treated as literal types
          demandOption: 'Please specify a tier (1, 2, or 3).',
        })
        .option('batch', {
          describe: 'Maximum number of words per deck file.',
          type: 'number',
          default: 30,
        }),
    (argv) => {
      // Type assertion for tier as yargs choices might not fully narrow it down
      const tier = argv.tier as 1 | 2 | 3;
      const batchSize = argv.batch as number; // batch will have a default value
      exportTier(tier, batchSize);
    }
  )
  .demandCommand(
    1, // Require at least one command to be specified
    'You need to specify at least one command (ingest or export).'
  )
  .strict() // Catches unrecognized options or arguments
  .help('h')
  .alias('h', 'help')
  .alias('v', 'version')
  .epilog('For more information, visit the repository.')
  .parse();
