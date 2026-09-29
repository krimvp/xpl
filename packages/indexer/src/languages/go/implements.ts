/**
 * Implicit interface satisfaction: Go's `LanguagePack.inferRefs`.
 *
 * A Go type implements an interface without saying so, so no site in the code expresses the relation. This
 * pass derives it from the symbols: a named type T (struct, or any other non-interface type) implements an
 * interface I declared anywhere in the repository when T's method set has every method of I.
 *
 * - T's method set is every method declared on T or *T in any file of T's package directory, plus what T
 *   promotes from its embedded fields (struct or interface types resolved in the repository, transitively).
 *   Pointer and value receivers are not told apart: the question is whether `T` or `*T` satisfies I.
 * - I's method set is its own methods plus those of its embedded interfaces, flattened. Empty interfaces are
 *   skipped, and so are interfaces with an embedded element that cannot be resolved (`io.Reader`): their
 *   method set is unknown, and a guess would only produce false edges. `error` is known. Constraint
 *   interfaces (`interface{ ~int | ~string; String() string }`, or embedding one) can only be used as type
 *   constraints and are skipped too.
 * - A method matches by name and, when both signatures are known, by a coarse signature (parameter and result
 *   counts and the shape of their types, see ./signature.ts): `Get(key string) int` is not `Get() error`.
 *   Without the signature check unrelated types that merely share a method name would all be reported.
 * - Unexported method names only count within one package (directory): `interface{ close() }` cannot be
 *   satisfied from another package.
 *
 * The ref goes from T's symbol to I's symbol; its site is T's declaration name (a type symbol's range starts
 * at its name, see ./extract.ts). Embedded fields and interface elements are the `extends` sites the
 * resolver already turned into `extends` refs, which is how they are resolved here.
 */
import type { SymbolId } from "@xpl/core";
import type { SymbolEntry } from "../../symbols.js";
import type { InferRefsInput, InferredRef } from "../types.js";
import { isGoFileData, signaturesCompatible } from "./signature.js";
import type { GoFileData, Signature } from "./signature.js";

/** A method of a method set: `scope` is the package directory of an unexported name, `""` for exported ones. */
interface MethodInfo {
  scope: string;
  sig?: Signature;
}

type Embed =
  | { kind: "type"; target: TypeNode }
  | { kind: "error" }
  | { kind: "ignored" }
  | { kind: "unknown" };

interface TypeNode {
  entry: SymbolEntry;
  id: SymbolId;
  dir: string;
  name: string;
  isInterface: boolean;
  /** The interface lists types (`~int | string`): a constraint, not an interface. */
  typeSet: boolean;
  /** The methods declared on the type (interface: its own methods), with their signatures. */
  own: Map<string, Signature | undefined>;
  embeds: Embed[];
  /** Flattened method set. */
  methods?: Map<string, MethodInfo>;
  /** Some embedded element could not be resolved, so `methods` may be missing names. */
  incomplete: boolean;
  /** Memoised `isConstraint` (interfaces only). */
  constraint?: boolean;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

const isExported = (name: string): boolean => /^\p{Lu}/u.test(name);

/** What `error` requires: `Error() string`. */
const ERROR_METHOD: MethodInfo = { scope: "", sig: { params: [], results: ["string"] } };

function siteKey(
  from: SymbolId,
  site: { startLine: number; startCol?: number; endLine: number; endCol?: number },
): string {
  return `${from}\0${site.startLine}:${site.startCol ?? 0}:${site.endLine}:${site.endCol ?? 0}`;
}

/** The method set of `node`, promoted methods included (cycle-safe: a cycle adds nothing). */
function flatten(node: TypeNode): Map<string, MethodInfo> {
  if (node.methods) return node.methods;
  const methods = new Map<string, MethodInfo>();
  node.methods = methods;
  for (const [name, sig] of node.own) {
    const info: MethodInfo = { scope: isExported(name) ? "" : node.dir };
    if (sig) info.sig = sig;
    methods.set(name, info);
  }
  for (const embed of node.embeds) {
    switch (embed.kind) {
      case "type":
        for (const [name, info] of flatten(embed.target))
          if (!methods.has(name)) methods.set(name, info);
        if (embed.target.incomplete) node.incomplete = true;
        break;
      case "error":
        if (!methods.has("Error")) methods.set("Error", ERROR_METHOD);
        break;
      case "unknown":
        node.incomplete = true;
        break;
      default:
        break;
    }
  }
  return methods;
}

/** Does the interface declare a type set, itself or through an embedded element? */
function isConstraint(node: TypeNode): boolean {
  if (node.constraint !== undefined) return node.constraint;
  node.constraint = false; // cycle guard
  node.constraint =
    node.typeSet ||
    // an interface can only embed interfaces and type sets: a struct or defined type in there is a type set
    node.embeds.some((e) => e.kind === "type" && (!e.target.isInterface || isConstraint(e.target)));
  return node.constraint;
}

/** Span of the declaration name of a type symbol (whose range starts at the name). */
function nameSite(node: TypeNode): InferredRef["site"] {
  const { startLine, startCol } = node.entry.span;
  return { startLine, startCol, endLine: startLine, endCol: startCol + node.name.length - 1 };
}

export function inferGoImplements(input: InferRefsInput): InferredRef[] {
  const goFiles = new Set(input.files.map((f) => f.path));
  const dataOf = new Map<string, GoFileData>();
  for (const file of input.files) if (isGoFileData(file.data)) dataOf.set(file.path, file.data);
  const typeSetPaths = new Map<string, Set<string>>();
  for (const [path, data] of dataOf) typeSetPaths.set(path, new Set(data.constraints));

  // 1. Named types and the methods declared on them, per package directory.
  const types = new Map<SymbolId, TypeNode>();
  const methodsOf = new Map<string, Map<string, Signature | undefined>>();
  for (const entry of input.entries) {
    const symbol = entry.symbol;
    if (!goFiles.has(symbol.file)) continue;
    const dir = dirOf(symbol.file);
    const dot = entry.basePath.indexOf(".");
    if (dot < 0) {
      if (symbol.kind !== "interface" && symbol.kind !== "class" && symbol.kind !== "type")
        continue;
      types.set(symbol.id, {
        entry,
        id: symbol.id,
        dir,
        name: entry.basePath,
        isInterface: symbol.kind === "interface",
        typeSet: typeSetPaths.get(symbol.file)?.has(entry.basePath) ?? false,
        own: new Map(),
        embeds: [],
        incomplete: false,
      });
    } else if (symbol.kind === "method" && entry.basePath.indexOf(".", dot + 1) < 0) {
      const key = `${dir}\0${entry.basePath.slice(0, dot)}`;
      const name = entry.basePath.slice(dot + 1);
      const sig = dataOf.get(symbol.file)?.signatures[entry.basePath];
      const methods = methodsOf.get(key);
      if (!methods) methodsOf.set(key, new Map([[name, sig]]));
      else if (!methods.get(name)) methods.set(name, sig);
    }
  }
  for (const node of types.values()) {
    for (const [name, sig] of methodsOf.get(`${node.dir}\0${node.name}`) ?? [])
      node.own.set(name, sig);
  }

  // 2. Embedded fields / interface elements: the `extends` sites, resolved through the refs the resolver made.
  const extendsRefs = new Map<string, SymbolId>();
  for (const ref of input.refs) {
    if (ref.kind === "extends") extendsRefs.set(siteKey(ref.from, ref.site), ref.to);
  }
  for (const file of input.files) {
    for (const site of file.sites) {
      if (site.kind !== "extends") continue;
      const owner = input.lookup.innermostEntry(file.path, site.site.startLine, site.site.startCol);
      const node = owner ? types.get(owner.symbol.id) : undefined;
      if (!node) continue;
      const to = extendsRefs.get(siteKey(node.id, site.site));
      const target = to !== undefined ? types.get(to) : undefined;
      if (target) node.embeds.push({ kind: "type", target });
      else if (site.qualifier.length === 0 && site.name === "error")
        node.embeds.push({ kind: "error" });
      else if (site.qualifier.length === 0 && site.name === "any")
        node.embeds.push({ kind: "ignored" });
      else node.embeds.push({ kind: "unknown" });
    }
  }

  // 3. Which concrete type has which method names.
  const byMethod = new Map<string, TypeNode[]>();
  for (const node of types.values()) {
    if (node.isInterface) continue;
    for (const name of flatten(node).keys()) {
      const list = byMethod.get(name);
      if (list) list.push(node);
      else byMethod.set(name, [node]);
    }
  }

  // 4. Every interface with a known, non-empty method set against the types that have its rarest method.
  const out: InferredRef[] = [];
  const interfaces = [...types.values()]
    .filter((node) => node.isInterface)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const iface of interfaces) {
    const required = flatten(iface);
    if (required.size === 0 || iface.incomplete || isConstraint(iface)) continue;
    let rarest: string | undefined;
    let rarestCount = Infinity;
    for (const name of required.keys()) {
      const count = byMethod.get(name)?.length ?? 0;
      if (count < rarestCount) {
        rarest = name;
        rarestCount = count;
      }
    }
    for (const candidate of rarest === undefined ? [] : (byMethod.get(rarest) ?? [])) {
      const have = flatten(candidate);
      let satisfied = true;
      for (const [name, want] of required) {
        const found = have.get(name);
        if (
          found === undefined ||
          (want.scope !== "" && found.scope !== want.scope) ||
          (want.sig && found.sig && !signaturesCompatible(want.sig, found.sig))
        ) {
          satisfied = false;
          break;
        }
      }
      if (satisfied)
        out.push({
          from: candidate.id,
          to: iface.id,
          kind: "implements",
          site: nameSite(candidate),
        });
    }
  }
  return out.sort((a, b) =>
    a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
  );
}
