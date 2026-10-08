/**
 * Static consistency checks for this repository, run by `npm run check` and CI.
 *
 * Why this exists: the plugin's tool definitions are hand-written JSON Schema, and the
 * DSH tool registry validates them at *load* time. A single stray `required: true` inside
 * a property (the `defineTool` authoring style, which DSH rejects) is invisible to
 * `node --check` and to unit tests that never build the real registry — it only shows up
 * when a user mounts the plugin. This script catches that class of bug without needing
 * DSH installed.
 *
 * Checks performed:
 *   1. `package.json` parses and its `dsh.bundle.patch` file exists.
 *   2. `cordis.patch.yml` inserts exactly one row, whose id is our plugin name.
 *   3. Every tool definition the plugin registers has a model-valid JSON Schema:
 *      top-level `required` arrays, no per-property `required`, `additionalProperties`
 *      declared on every object, and no unsupported keywords.
 *   4. The plugin module exposes the function-plugin shape (`name` / `inject` / `apply`,
 *      no default export) — DSH drops `inject` when both shapes are present.
 *   5. No private project identifiers leaked into tracked files.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []
const notes = []

/**
 * Every file that would be published, as repository-relative paths.
 *
 * Prefers `git ls-files` (that is the authoritative "what ships" answer). Falls back to
 * walking the tree when git is unavailable — for instance inside a tarball or a CI
 * checkout without `.git` — while skipping the same directories `.gitignore` excludes.
 * @returns repository-relative file paths.
 */
function trackedFiles() {
  try {
    const output = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    return output.split('\0').filter(entry => entry !== '')
  } catch {
    const skipped = new Set(['.git', 'node_modules', '.private'])
    const found = []
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (skipped.has(entry.name)) continue
        const absolute = join(directory, entry.name)
        if (entry.isDirectory()) walk(absolute)
        else found.push(relative(root, absolute))
      }
    }
    walk(root)
    return found
  }
}

/** Record a failed check (collected, not thrown, so one run reports everything). */
function fail(message) {
  failures.push(message)
}

/** Record a passing check for the summary. */
function pass(message) {
  notes.push(message)
}

/* ---------------------------------------------------------------- 1. package.json */

const pkgPath = join(root, 'package.json')
let pkg
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pass('package.json parses')
} catch (error) {
  fail(`package.json does not parse: ${error.message}`)
}

if (pkg !== undefined) {
  if (typeof pkg.name !== 'string' || pkg.name === '') fail('package.json needs a non-empty name')
  if (pkg.type !== 'module') fail('package.json must declare "type": "module"')
  if (pkg.license === undefined) fail('package.json should declare a license')
  if (typeof pkg.main !== 'string' || !pkg.main.endsWith('.mjs')) {
    fail('package.json "main" should point at session-relay.mjs')
  }
  if (!Array.isArray(pkg.files) || !pkg.files.includes('session-relay.mjs')) {
    fail('package.json "files" must include session-relay.mjs so npm publishes it')
  }
  const declaredPatch = pkg.dsh?.bundle?.patch
  if (declaredPatch === undefined) {
    fail('package.json is missing "dsh.bundle.patch" (that is what makes `dsh plugin add` work)')
  } else if (!existsSync(join(root, declaredPatch))) {
    fail(`dsh.bundle.patch points at a missing file: ${declaredPatch}`)
  } else {
    pass(`dsh.bundle.patch -> ${declaredPatch}`)
  }
}

/* ------------------------------------------------------------ 2. cordis.patch.yml */

const patchPath = join(root, 'cordis.patch.yml')
if (!existsSync(patchPath)) {
  fail('cordis.patch.yml is missing')
} else {
  const text = readFileSync(patchPath, 'utf8')
  const ids = [...text.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map(match => match[1])
  if (ids.length !== 1) {
    fail(`cordis.patch.yml should insert exactly one row, found ${ids.length}: ${ids.join(', ')}`)
  } else if (ids[0] !== 'session-relay') {
    fail(`cordis.patch.yml inserts id "${ids[0]}", expected "session-relay"`)
  } else {
    pass('cordis.patch.yml inserts the session-relay row')
  }
}

/* ------------------------------------------- 3/4. load the plugin and inspect tools */

/**
 * Keywords the DSH registry's `assertSupportedJsonSchema` accepts. Kept deliberately
 * small: anything outside this list is a sign the schema drifted from what DSH supports.
 * `description`/`title`/`default`/`examples` are the annotation keywords.
 */
const ALLOWED_KEYWORDS = new Set([
  'type', 'properties', 'required', 'items', 'additionalProperties', 'enum', 'const',
  'oneOf', 'anyOf', 'allOf', 'description', 'title', 'default', 'examples',
  'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern',
  'format', 'nullable', 'deprecated',
])

/**
 * Fully validate one schema node the way DSH would.
 * @param node - candidate schema node.
 * @param path - dotted path, for error messages.
 */
function checkSchema(node, path) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    fail(`${path}: schema node must be an object, got ${Array.isArray(node) ? 'array' : typeof node}`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      fail(`${path}: unsupported JSON Schema keyword "${key}" (DSH would reject this tool)`)
    }
  }
  // The exact trap this script exists for: `required` must be a top-level array of
  // property names, never a boolean sitting inside a property.
  if (node.required !== undefined && !Array.isArray(node.required)) {
    fail(`${path}.required must be an array of property names, got ${typeof node.required}`
      + (node.required === true ? ' — that is defineTool\'s authoring style, which DSH rejects' : ''))
  }
  if (node.type === 'object' && node.properties !== undefined) {
    if (node.additionalProperties === undefined) {
      fail(`${path}: object schemas must declare additionalProperties explicitly`)
    }
    for (const [name, child] of Object.entries(node.properties)) {
      checkSchema(child, `${path}.properties.${name}`)
    }
  }  if (node.type === 'array' && node.items !== undefined) {
    checkSchema(node.items, `${path}.items`)
  }
  for (const branch of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(node[branch])) {
      node[branch].forEach((child, index) => checkSchema(child, `${path}.${branch}[${index}]`))
    }
  }
}

let plugin
try {
  plugin = await import(join(root, 'session-relay.mjs'))
  pass('session-relay.mjs imports without dependencies')
} catch (error) {
  fail(`session-relay.mjs failed to import: ${error.message}`)
}

if (plugin !== undefined) {
  if (typeof plugin.name !== 'string' || plugin.name === '') fail('plugin must export a string `name`')
  // The plugin id, npm name and tool names must stay ASCII: they travel through npm, YAML
  // config, model requests and JSON Schema. The Chinese display name lives in docs only.
  if (typeof plugin.name === 'string' && !/^[\x20-\x7e]+$/.test(plugin.name)) {
    fail(`plugin id "${plugin.name}" must be ASCII (the Chinese display name belongs in docs)`)
  }
  if (!Array.isArray(plugin.inject)) fail('plugin must export an `inject` array')
  if (typeof plugin.apply !== 'function') fail('plugin must export an `apply` function')
  // DSH's Loader discards a function plugin's `inject` when the module also default-exports.
  if ('default' in plugin) fail('plugin must not default-export alongside named exports (DSH drops `inject`)')
  if (!failures.some(message => message.includes('plugin must'))) pass('plugin exposes the function-plugin shape')

  const tools = new Map()
  const fakeCtx = {
    get: () => undefined,
    effect: factory => {
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    logger: { warn() {}, info() {}, error() {} },
    tools: {
      register(definition) {
        if (tools.has(definition.name)) fail(`tool "${definition.name}" registered twice`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    on: () => () => {},
    emit() {},
  }
  try {
    plugin.apply(fakeCtx)
    pass(`registers ${tools.size} tools: ${[...tools.keys()].join(', ')}`)
  } catch (error) {
    fail(`apply() threw: ${error.message}`)
  }

  const EXPECTED_TOOLS = [
    'dispatch_card',
    'list_workspace_sessions',
    'register_session_role',
    'send_session_message',
  ]
  for (const name of EXPECTED_TOOLS) {
    if (!tools.has(name)) fail(`expected tool "${name}" is not registered`)
  }
  for (const name of tools.keys()) {
    if (!EXPECTED_TOOLS.includes(name)) fail(`unexpected tool "${name}" registered`)
  }

  for (const [name, definition] of tools) {
    if (typeof definition.description !== 'string' || definition.description.length < 20) {
      fail(`tool "${name}" needs a meaningful description (the model reads it)`)
    }
    if (typeof definition.execute !== 'function') fail(`tool "${name}" has no execute function`)
    if (typeof definition.output?.render !== 'function') fail(`tool "${name}" has no output.render`)
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      fail(`tool name "${name}" must be lower-case ASCII snake_case (it reaches model requests and the session log)`)
    }
    checkSchema(definition.parameters, `${name}.parameters`)
    checkSchema(definition.output?.schema, `${name}.output.schema`)

    // Every required name must exist as a property, and vice versa is not required.
    const required = definition.parameters?.required ?? []
    for (const key of required) {
      if (definition.parameters?.properties?.[key] === undefined) {
        fail(`tool "${name}" requires "${key}" but declares no such property`)
      }
      if (definition.parameters?.properties?.[key]?.required !== undefined) {
        fail(`tool "${name}" property "${key}" still carries a per-property required flag`)
      }
    }
  }
}

/* ------------------------------------------------------ 5. no private identifiers */

const PRIVATE_PATTERNS = [
  [/\/home\/[a-z][\w.-]*\//i, 'absolute home path (do not publish one machine\'s layout)'],
  [/\/Users\/[a-z][\w.-]*\//i, 'absolute macOS home path'],
  [/192\.168\.\d+\.\d+/, 'private LAN address'],
  [/\b10\.\d+\.\d+\.\d+\b/, 'private LAN address'],
  [/(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]{6,}/i, 'hard-coded credential'],
]

/**
 * Optional, **local-only** additional denylist.
 *
 * A team's real project names and internal paths should not be written into this tracked
 * script (that would leak the very strings we want to catch). So they are read from a
 * gitignored file instead: one literal substring per line, `#` starts a comment.
 *
 * Kept deliberately simple (plain substring match, not regex) so a name with regex
 * metacharacters in it behaves as a maintainer expects.
 */
const LOCAL_DENYLIST = join(root, '.private', 'denylist.txt')
if (existsSync(LOCAL_DENYLIST)) {
  const entries = readFileSync(LOCAL_DENYLIST, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
  PRIVATE_PATTERNS.push(...entries.map(entry => [
    // Escape regex metacharacters: the entry is a literal substring.
    new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    `locally denylisted identifier`,
  ]))
  notes.push(`loaded ${entries.length} local denylist entr${entries.length === 1 ? 'y' : 'ies'}`)
}

/**
 * Scan every tracked text file.
 *
 * A hand-maintained list would silently stop covering a file the moment someone adds one
 * (a new doc, a new test fixture) — exactly when a leaked path is most likely. So the list
 * comes from git, and `.private/` is excluded because it is *supposed* to hold real names.
 */
const TEXT_EXTENSIONS = ['.mjs', '.js', '.ts', '.json', '.yml', '.yaml', '.md', '.py', '.txt', '.html', '.css']
let scanned = 0
for (const relative of trackedFiles()) {
  if (relative.startsWith('.private/')) continue
  if (relative === 'LICENSE') continue
  if (!TEXT_EXTENSIONS.some(extension => relative.endsWith(extension))) continue
  const absolute = join(root, relative)
  if (!existsSync(absolute)) continue
  const text = readFileSync(absolute, 'utf8')
  scanned += 1
  for (const [pattern, label] of PRIVATE_PATTERNS) {
    const match = text.match(pattern)
    if (match !== null) fail(`${relative}: looks like a ${label}: ${JSON.stringify(match[0])}`)
  }
}
pass(`no private identifiers in ${scanned} tracked text files`)

/* ---------------------------------------------------------------------- report */

for (const note of notes) console.log(`  ok   ${note}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`)
  for (const message of failures) console.error(`  FAIL ${message}`)
  process.exit(1)
}
console.log(`\nall ${notes.length} checks passed`)
