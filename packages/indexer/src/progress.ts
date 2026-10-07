/** In-memory build events; never part of the saved index. */
export interface IndexProgress {
  phase: "Discovering" | "Reading" | "Extracting" | "Resolving" | "Provider" | "Finishing";
  completed?: number;
  total?: number;
  provider?: string;
}
