// Repo path anchors, resolved once from the package.json `imports` map.
//
// Leaf module on purpose: it imports nothing local, so anyone can pull from it
// without joining a cycle. That matters here — config.js ↔ util.js already
// form one, and app-config.js sits on the sites.js → config.js side of it, so
// neither could reach these anchors through util.js.
//
// Anchoring on the aliases instead of each file's own depth means a file can
// move without silently repointing data/ at its new parent.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #rootDir targets package.json rather than the directory: a bare './' target
// matches by trailing slash, which Node deprecated (DEP0166) and warns about
// once per process — including every spawned scraper.
export const ROOT_DIR = path.dirname(fileURLToPath(import.meta.resolve('#rootDir')));
export const DATA_DIR = fileURLToPath(import.meta.resolve('#dataDir'));

// The join helpers live here, not in util.js, so a module on the config.js ↔
// util.js cycle can build a path in the same shape as everyone else —
// app-config.js is the case today. util.js re-exports both, so the ~12 existing
// call sites keep importing them from there.
export const dataDir = s => path.resolve(DATA_DIR, s);
// for root-level paths that aren't under data/ (package.json, assets/)
export const rootDir = s => path.resolve(ROOT_DIR, s);

// Individual files under data/ are not declared here. Everything above derives
// from an alias in package.json; a filename derives from whichever module owns
// the file — config.json is exported as CONFIG_FILE_PATH by app-config.js,
// watcher state by each watcher, the claim DBs by jsonDb(), all via dataDir().
// Declaring one here makes paths.js the catalog of every data/ filename, with
// no rule left for what stays out.

// Runner names double as filenames and reach shell commands, so they are held
// to the same charset CONTRIBUTING gives for a service id.
export const RUNNER_NAME_RE = /^[A-Za-z0-9-]+$/;

// No PLATFORMS_DIR constant: '#platforms/*' carries the star because it also
// serves static imports, and no specifier resolves to the bare directory —
// a trailing slash is what DEP0166 deprecates. Resolving per file keeps the
// alias as the single source for the location.
//
// The name goes inside a specifier, which is parsed as a URL, so it is
// charset-checked first: an unchecked '#' or '?' truncates the path silently
// ('a#b.js' would resolve to 'a').
export function platformFile(name) {
  if (!RUNNER_NAME_RE.test(name)) throw new Error(`paths: invalid runner name '${name}'`);
  return fileURLToPath(import.meta.resolve(`#platforms/${name}.js`));
}
