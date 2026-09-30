#!/usr/bin/env node
/**
 * Link the harness-provided peer packages into this directory's node_modules.
 *
 * When a DSH bundle is installed from npm or GitHub, DSH puts it inside the
 * profile's node_modules, so Node finds `@deepseek-ai/dsh-tools` by walking up
 * to the harness installation and nothing extra is needed.
 *
 * A bundle installed as a `link:` to a directory outside the harness tree — the
 * usual development setup — has no such path. Node resolves from the real path
 * of the linked directory, walks up through the developer's home, never reaches
 * the harness installation, and the plugin fails to load its imports.
 *
 * This creates the missing symlinks. It is a development convenience only: the
 * packages are peer dependencies, so nothing is vendored or version-pinned here.
 *
 * Usage:
 *   node tools/dev-links.mjs [harness-install-dir]
 *
 * The harness directory defaults to $DSH_INSTALL_DIR, then /opt/dsh, and is
 * validated before anything is written.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Peer packages this plugin declares; every one must resolve from here. */
const PEERS = ['cordis', 'dsh', 'dsh-tools', 'schemastery']

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = resolve(process.argv[2] ?? process.env.DSH_INSTALL_DIR ?? '/opt/dsh')

if (!existsSync(join(harness, 'node_modules', '@deepseek-ai', 'dsh'))) {
	console.error(`Not a harness installation: ${harness}`)
	console.error('Expected to find node_modules/@deepseek-ai/dsh there.')
	console.error('Pass the directory that contains the `dsh` command, e.g.:')
	console.error('  node tools/dev-links.mjs /path/to/dsh')
	process.exit(1)
}

const target = join(here, 'node_modules', '@deepseek-ai')
mkdirSync(target, { recursive: true })

let created = 0
let present = 0
for (const peer of PEERS) {
	const source = join(harness, 'node_modules', '@deepseek-ai', peer)
	if (!existsSync(source)) {
		console.error(`Missing in the harness, skipping: @deepseek-ai/${peer}`)
		continue
	}
	const link = join(target, peer)
	// lstat, not existsSync: a broken symlink must still be replaced.
	if (lstatSync(link, { throwIfNoEntry: false }) !== undefined) {
		try {
			rmSync(link, { recursive: true, force: true })
		} catch (error) {
			console.error(`Could not replace ${link}: ${String(error)}`)
			process.exit(1)
		}
	}
	symlinkSync(source, link, 'dir')
	console.log(`linked  @deepseek-ai/${peer} -> ${source}`)
	if (existsSync(link)) present += 1
	created += 1
}

console.log(`\n${created} link(s) written, ${present} resolvable from ${here}`)
if (present !== PEERS.length) {
	console.error('Not every peer resolves; the plugin will fail to import.')
	process.exit(1)
}
