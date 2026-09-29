import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { remoteBaseName } from "../src/repo-name.js";
import { git, indexedFixture, makeTempDir, readJson, writeFile, xpl, xplJson } from "./helpers.js";

/** A directory with one source file, indexed, plus whatever `files` adds. */
async function repoWith(files: Record<string, string>, prefix = "xpl-repo-"): Promise<string> {
  const dir = makeTempDir(prefix);
  writeFile(dir, "src/main.ts", "export const x = 1;\n");
  for (const [path, text] of Object.entries(files)) writeFile(dir, path, text);
  const indexed = await xpl(dir, "index", "--precise", "off");
  expect(indexed.code, indexed.err).toBe(0);
  return dir;
}

async function repoOf(dir: string, ...args: string[]) {
  const made = await xplJson<any>(dir, "new", "demo", ...args);
  expect(made.code, made.out + made.err).toBe(0);
  return { json: made.json, explainer: readJson(dir, ".explainer/demo.explainer.json").repo };
}

describe("xpl new: the repository name", () => {
  it("--repo and --url are recorded, and win over detection", async () => {
    const dir = await repoWith({ "package.json": '{"name": "from-package"}' });
    const { json, explainer } = await repoOf(
      dir,
      "--repo",
      "acme/widgets",
      "--url",
      "https://example.com/acme/widgets",
    );
    expect(explainer).toMatchObject({
      name: "acme/widgets",
      url: "https://example.com/acme/widgets",
    });
    expect(json.repo).toEqual({
      name: "acme/widgets",
      source: "--repo",
      url: "https://example.com/acme/widgets",
    });
    const text = await xpl(await repoWith({}), "new", "t", "--repo", "r", "--url", "u");
    expect(text.out).toContain("repo: r (--repo), u");
  });

  it("without --url there is no url; empty values are usage errors", async () => {
    const dir = await repoWith({});
    const { explainer } = await repoOf(dir, "--repo", "widgets");
    expect("url" in explainer).toBe(false);
    for (const flags of [
      ["--repo", ""],
      ["--repo", "  "],
      ["--url", ""],
    ]) {
      const bad = await xpl(dir, "new", "other", ...flags);
      expect(bad.code, flags.join(" ")).toBe(2);
    }
  });

  it("package.json name comes first", async () => {
    const dir = await repoWith({
      "package.json": '{"name": "from-package", "version": "1.0.0"}',
      "go.mod": "module example.com/from-go\n\ngo 1.22\n",
      "pyproject.toml": '[project]\nname = "from-py"\n',
    });
    const { json, explainer } = await repoOf(dir);
    expect(explainer.name).toBe("from-package");
    expect(json.repo).toMatchObject({ name: "from-package", source: "package.json" });
    const text = await xpl(dir, "new", "again");
    expect(text.out).toContain("repo: from-package (package.json)");
  });

  it("then the last element of the go.mod module, without a major-version suffix", async () => {
    const plain = await repoWith({ "go.mod": "module example.com/acme/jobrunner\n\ngo 1.22\n" });
    expect((await repoOf(plain)).explainer.name).toBe("jobrunner");
    const versioned = await repoWith({ "go.mod": "// header\nmodule github.com/acme/tools/v3\n" });
    expect((await repoOf(versioned)).explainer.name).toBe("tools");
    const quoted = await repoWith({ "go.mod": 'module "example.com/quoted"\n' });
    expect((await repoOf(quoted)).explainer.name).toBe("quoted");
    const bare = await repoWith({ "go.mod": "module standalone\n" });
    expect((await repoOf(bare)).explainer.name).toBe("standalone");
  });

  it("then [project] name of pyproject.toml, not other tables", async () => {
    const dir = await repoWith({
      "pyproject.toml": [
        "[build-system]",
        'name = "not-this"',
        "",
        "[project.urls]",
        'name = "nor-this"',
        "",
        "[project]  # the real one",
        'version = "0.1.0"',
        "name = 'py-thing'",
        "",
        "[tool.other]",
        'name = "nor-that"',
      ].join("\n"),
    });
    const { json, explainer } = await repoOf(dir);
    expect(explainer.name).toBe("py-thing");
    expect(json.repo.source).toBe("pyproject.toml");
  });

  it("skips what does not give a name: bad JSON, no name, empty name", async () => {
    const dir = await repoWith({
      "package.json": "{ not json",
      "go.mod": "go 1.22\n",
      "pyproject.toml": '[project]\nname = ""\n',
    });
    const { json } = await repoOf(dir);
    expect(json.repo.source).toBe("directory name");
    const nameless = await repoWith({ "package.json": '{"version": "1"}' });
    expect((await repoOf(nameless)).json.repo.source).toBe("directory name");
  });

  it("then the base name of the git remote (origin first), never its URL", async () => {
    const dir = await repoWith({});
    git(dir, "init", "-q", "-b", "main");
    git(dir, "remote", "add", "backup", "https://example.com/somebody/other.git");
    git(dir, "remote", "add", "origin", "git@github.com:acme/widgets.git");
    const { json, explainer } = await repoOf(dir);
    expect(explainer).toEqual(expect.objectContaining({ name: "widgets" }));
    expect("url" in explainer).toBe(false);
    expect(json.repo).toMatchObject({ name: "widgets", source: "git remote" });

    const noOrigin = await repoWith({});
    git(noOrigin, "init", "-q", "-b", "main");
    git(noOrigin, "remote", "add", "upstream", "https://example.com/team/engine");
    expect((await repoOf(noOrigin)).explainer.name).toBe("engine");
  });

  it("finally the name of the directory", async () => {
    const dir = await repoWith({});
    const { json, explainer } = await repoOf(dir);
    expect(explainer.name).toBe(basename(dir));
    expect(json.repo).toMatchObject({ source: "directory name" });
  });

  it("the fixtures: package.json, go.mod and pyproject.toml of the three languages", async () => {
    expect((await repoOf(await indexedFixture("ts-jobrunner"))).explainer.name).toBe(
      "ts-jobrunner",
    );
    expect((await repoOf(await indexedFixture("go-jobrunner"))).explainer.name).toBe("jobrunner");
    expect((await repoOf(await indexedFixture("py-jobrunner"))).explainer.name).toBe(
      "py-jobrunner",
    );
  });
});

describe("remoteBaseName", () => {
  it("handles https, ssh, scp-like and local paths, with and without .git", () => {
    expect(remoteBaseName("https://github.com/acme/widgets.git")).toBe("widgets");
    expect(remoteBaseName("https://github.com/acme/widgets")).toBe("widgets");
    expect(remoteBaseName("https://github.com/acme/widgets/")).toBe("widgets");
    expect(remoteBaseName("ssh://git@host:2222/srv/git/widgets.git")).toBe("widgets");
    expect(remoteBaseName("git@github.com:acme/widgets.git")).toBe("widgets");
    expect(remoteBaseName("/srv/git/widgets.git")).toBe("widgets");
    expect(remoteBaseName("C:\\repos\\widgets")).toBe("widgets");
    expect(remoteBaseName("")).toBeUndefined();
    expect(remoteBaseName("/")).toBeUndefined();
  });
});
