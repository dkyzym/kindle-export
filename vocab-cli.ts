// vocab-cli.ts – resilient CLI (ESM/CJS) for Kindle → Anki
// -----------------------------------------------------------------------------
// npm install natural wink-lemmatizer fs-extra yargs
// npm i -D tsx typescript @types/node @types/natural @types/yargs
// -----------------------------------------------------------------------------
// tsconfig.json (Node 18+)
// {
//   "compilerOptions": {
//     "target": "ES2020",
//     "module": "NodeNext",
//     "moduleResolution": "NodeNext",
//     "esModuleInterop": true,
//     "forceConsistentCasingInFileNames": true,
//     "strict": true,
//     "skipLibCheck": true
//   }
// }
// -----------------------------------------------------------------------------
// Usage:
//   npx tsx vocab-cli.ts ingest words.json
//   npx tsx vocab-cli.ts export --tier 1 --batch 30
// -----------------------------------------------------------------------------

import fs, { mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { hideBin } from 'yargs/helpers';
import yargs from 'yargs/yargs';

const naturalMod: any = await import('natural');
const { WordNet, PorterStemmer } = (naturalMod.default ??
  naturalMod) as typeof import('natural');
// @ts-ignore wink‑lemmatizer has no types
import lemmatizer from 'wink-lemmatizer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, 'data');
const DATA = (p: string) => path.join(DATA_PATH, p);

async function safeJsonRead<T>(file: string, fallback: T): Promise<T> {
  try {
    const txt = await fs.readFile(file, 'utf8');
    return JSON.parse(txt) as T;
  } catch {
    console.warn(`[warn] cannot load ${path.basename(file)} – using fallback`);
    return fallback;
  }
}
async function loadStop(): Promise<Set<string>> {
  try {
    const txt = await fs.readFile(DATA('stop_en.txt'), 'utf8');
    return new Set(txt.split(/\r?\n/).filter(Boolean));
  } catch {
    console.warn('[warn] stop_en.txt missing – no stop‑words applied');
    return new Set<string>();
  }
}
const loadCefr = () =>
  safeJsonRead<Record<string, { level: string; pos?: string }>>(
    DATA('cefr_map.json'),
    {}
  );
const loadZipf = () =>
  safeJsonRead<Record<string, number>>(DATA('subtlex_zipf.json'), {});

const wn = new WordNet();
function lookup(
  word: string
): Promise<{ def: string; syns: string[]; pos: string }> {
  return new Promise((res) => {
    wn.lookup(word, (result) => {
      if (!result?.length) return res({ def: '', syns: [], pos: 'n' });
      const first = result[0];
      res({
        def: first.def.split(';')[0],
        syns: Array.from(new Set(result.flatMap((x) => x.synonyms))).slice(
          0,
          3
        ),
        pos: first.pos,
      });
    });
  });
}

interface KindleWord {
  word: string;
  count?: number;
  example?: string;
  book?: string;
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

async function ingest(file: string) {
  await mkdir(DATA_PATH, { recursive: true });
  const stop = await loadStop();
  const cefr = await loadCefr();
  const zipfAll = await loadZipf();
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as KindleWord[];
  const seen = new Set<string>();
  const out: TierWord[] = [];
  for (const { word, example } of raw) {
    if (!word) continue;
    const w = word.toLowerCase();
    if (seen.has(w) || stop.has(w)) continue;
    seen.add(w);
    const lemma = (lemmatizer as any).lemmatize
      ? (lemmatizer as any).lemmatize(w)
      : PorterStemmer.stem(w);
    const ce = cefr[lemma] as { level: string; pos?: string } | undefined;
    const level = ce?.level ?? 'B2';
    const pos = ce?.pos ?? '';
    const zipf = zipfAll[lemma] ?? 3.5;
    const lvlRank = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].indexOf(level);
    const tier: 1 | 2 | 3 = lvlRank >= 3 && zipf < 4 ? 1 : zipf < 5 ? 2 : 3;
    out.push({ word: w, lemma, level, zipf, tier, pos, example });
  }
  await fs.writeFile('cleaned-words.json', JSON.stringify(out, null, 2));
  const stat = { 1: 0, 2: 0, 3: 0 } as Record<1 | 2 | 3, number>;
  out.forEach((x) => stat[x.tier]++);
  console.log(
    `Cleaned ${raw.length} → ${out.length} | T1 ${stat[1]} T2 ${stat[2]} T3 ${stat[3]}`
  );
}

async function exportBatch(tier: number, batch: number) {
  let arr: TierWord[] = [];
  try {
    arr = JSON.parse(await fs.readFile('cleaned-words.json', 'utf8'));
  } catch {
    console.error('cleaned-words.json not found. Run "ingest" first.');
    process.exit(1);
  }
  const slice = arr.filter((x) => x.tier === tier).slice(0, batch);
  if (!slice.length) {
    console.error(`No words found for Tier ${tier}.`);
    return;
  }
  const rows: string[] = [];
  for (const w of slice) {
    const { def, syns, pos } = await lookup(w.word);
    const finalPos = w.pos || pos;
    const example = (w.example ?? '').slice(0, 120);
    rows.push(
      [
        `${w.word} (${finalPos})`,
        '',
        def,
        example,
        syns.join(', '),
        `Tier${w.tier}·${w.level}·Zipf ${w.zipf.toFixed(1)}`,
      ]
        .map((s) => s.replace(/\t/g, ' '))
        .join('\t')
    );
  }
  const name = `deck_t${tier}_${Date.now()}.tsv`;
  await fs.writeFile(name, rows.join('\n'));
  console.log(`Saved ${rows.length} cards → ${name}`);
}

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

(async () => {
  if (argv._[0] === 'ingest') await ingest(argv.file as string);
  else if (argv._[0] === 'export')
    await exportBatch(argv.tier as number, argv.batch as number);
})();
