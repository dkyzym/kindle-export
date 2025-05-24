declare module 'subtlex-word-frequencies' {
  interface SubtlexEntry {
    word: string;
    count: number;
  }

  const entries: SubtlexEntry[];
  export = entries;
}

interface WNResult {
  pos: string;
  def: string;
  synonyms: string[];
  meta?: { freqCnt?: number }; // есть в wordnet-db
}

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
