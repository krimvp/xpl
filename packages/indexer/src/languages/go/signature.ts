/**
 * Coarse method signatures, the pack-private data (`FileFacts.data`) that lets `inferRefs` tell methods of the
 * same name apart.
 *
 * A method satisfies an interface method only with an identical signature. Full type identity needs a type
 * checker; what can be compared syntactically is the number of parameters and results and the shape of each
 * type, with package qualifiers and pointers'/generics' arguments left out or made lenient so that the same
 * type spelled `*queue.Job` in one package and `*Job` in another still matches. A type that cannot be told
 * (a type parameter, a locally declared alias) is a wildcard `?` that matches anything.
 */

export interface Signature {
  /** Normalised parameter types; a variadic one starts with `...`. */
  params: string[];
  /** Normalised result types. */
  results: string[];
}

/** What the Go extractor puts in `FileFacts.data`. */
export interface GoFileData {
  /** Signatures of the methods of the file (receiver methods and interface methods), by symbol path. */
  signatures: Record<string, Signature>;
  /** Paths of the interfaces that declare a type set (`~int | string`): they are constraints, not interfaces. */
  constraints: string[];
}

export function isGoFileData(data: unknown): data is GoFileData {
  return (
    typeof data === "object" &&
    data !== null &&
    "signatures" in data &&
    "constraints" in data &&
    Array.isArray((data as GoFileData).constraints)
  );
}

/** Same spelling, or one of them is not known precisely (contains a wildcard). */
function typesCompatible(a: string, b: string): boolean {
  return a === b || a.includes("?") || b.includes("?");
}

/** Could a method with signature `have` satisfy an interface method with signature `required`? */
export function signaturesCompatible(required: Signature, have: Signature): boolean {
  if (required.params.length !== have.params.length) return false;
  if (required.results.length !== have.results.length) return false;
  return (
    required.params.every((p, i) => typesCompatible(p, have.params[i]!)) &&
    required.results.every((r, i) => typesCompatible(r, have.results[i]!))
  );
}
