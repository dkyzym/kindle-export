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
