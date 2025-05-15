declare module 'subtlex-word-frequencies' {
  interface SubtlexEntry {
    word: string;
    count: number;
  }

  const entries: SubtlexEntry[];
  export = entries;
}
