#!/usr/bin/env node

const process = require('process')
const fs = require('fs')
const cp = require('child_process')
const path = require('path')
const flags = require('commander');

flags
	.version('0.1.0')
	.option('-s, --src <PATH>', 'Source PATH')
	.option('-a, --arch <ARCH>', 'Tartget ARCH')
	.option('-g, --gnu', 'Make GNU archive library on Windows')
	.option('-j, --jobs <N>', 'Allow N jobs at once')
	.parse(process.argv)

function mkdir(dir) {
	if (fs.existsSync(dir)) {
		return false
	}
	mkdir(path.dirname(dir))
	fs.mkdirSync(dir)
	return true
}

async function exec(cmd, args) {
	return await new Promise((resolve) => {
		var child = cp.spawn(cmd, args);
		child.stdout.pipe(process.stdout);
		child.stderr.pipe(process.stderr);
		child.on('exit', function(code) {
			resolve(code)
		});
	})
}

///////////////////////////////////////////////////////////////

var plat, arch

plat = process.platform
arch = flags.arch && flags.arch !== 'native' ? flags.arch : process.arch

const archMap = {
	'ia32': 'x86',
	'x86': 'x86',
	'i386': 'x86',
	'i686': 'x86',
	'x86_64': 'x64',
	'amd64': 'x64',
	'x64': 'x64',
	'arm': 'arm',
	'arm64': 'arm64'
}
if (arch in archMap) {
	arch = archMap[arch]
}

///////////////////////////////////////////////////////////////

if (flags.src) {
	process.chdir(path.resolve(flags.src))
}
const srcDir = process.cwd()

const verFilePath = path.join(srcDir, 'include', 'v8-version.h')

const verFileData = fs.readFileSync(verFilePath).toString()
if (verFileData === '') {
	console.error(`Error: failed to read "${verFilePath}"!`)
	return
}

const verFileDataLines = verFileData.split('\n')
if (verFileDataLines.length < 4) {
	console.error(`Error: failed to parse "${verFilePath}"!`)
	return
}

var majorVer = 0
var minorVer = 0
var buildNum = 0
var patchLv = 0

for (let i = 0; i < verFileDataLines.length; i++) {
	const nodes = verFileDataLines[i].trim().split(' ');
	if (nodes[0].trim() !== '#define') {
		continue
	}
	switch (nodes[1].trim()) {
		case 'V8_MAJOR_VERSION':
			majorVer = nodes[2].trim()
			break;
		case 'V8_MINOR_VERSION':
			minorVer = nodes[2].trim()
			break;
		case 'V8_BUILD_NUMBER':
			buildNum = nodes[2].trim()
			break;
		case 'V8_PATCH_LEVEL':
			patchLv = nodes[2].trim()
	}
}

function copyNewFile(src, dest) {
	if (
		!fs.existsSync(src) ||
		(
			fs.existsSync(dest) &&
			fs.statSync(src).mtimeMs <= fs.statSync(dest).mtimeMs
		)
	) {
		return false
	}
	fs.copyFileSync(src, dest)
	console.log('copy:', path.relative(srcDir, src), '->', path.relative(srcDir, dest))
	return true
}

function copyIncDir(src, dest) {
	var c = 0
	const names = fs.readdirSync(src)
	mkdir(dest)
	for (let i = 0; i < names.length; i++) {
		const name = names[i]
		const srcItemPath = path.join(src, name)

		if (fs.statSync(srcItemPath).isDirectory()) {
			c += copyIncDir(srcItemPath, path.join(dest, name))
			continue
		}

		const ext = path.extname(name)
		if (ext.length < 2 || ext.substr(0, 2) !== '.h') {
			continue
		}

		if (copyNewFile(srcItemPath, path.join(dest, name))) {
			c++
		}
	}
	return c
}

;(async () => {

console.log('=> Configuring')

var gn = 'gn'
var gnArgs = {
	'is_debug': false,
	'symbol_level': 0,
	'is_component_build': false,
	'v8_static_library': true,
	'v8_monolithic': true,
	'use_custom_libcxx': false,
	'use_custom_libcxx_for_host': false,
	'v8_use_external_startup_data': false,
	'treat_warnings_as_errors': false,
	'target_cpu': `"${arch}"`
}

var origlibExt
var distLibPrefix
var distLibExt

var ar = 'ar'
var ranlib = 'ranlib'

if (process.platform === 'win32') {
	process.env['DEPOT_TOOLS_WIN_TOOLCHAIN'] = '0'
	gn += '.bat'
	origlibExt = '.lib'
	if (flags.gnu) {
		console.error(`Error: "-g, --gnu" is not completed yet!`)
		return

		plat += '-gnu'
		distLibPrefix = 'lib'
		distLibExt = '.a'
		ar = path.join(__dirname, 'tools', ar)
		ranlib = path.join(__dirname, 'tools', ranlib)
	} else {
		gnArgs['is_clang'] = false
		distLibPrefix = ''
		distLibExt = '.lib'
	}
} else {
	origlibExt = '.a'
	distLibPrefix = 'lib'
	distLibExt = '.a'
}

const target = `v${majorVer}.${minorVer}.${buildNum}.${patchLv}-${plat}-${arch}`
const outDir = path.join(srcDir, 'out.mkv8', '.original', target)

var gnArgsStr = '--args='
for (const key in gnArgs) {
	gnArgsStr += ` ${key}=${gnArgs[key]}`
}

if (await exec(
	gn,
	[
		'gen',
		outDir,
		gnArgsStr
	]
) !== 0) {
	return
}

console.log('')

//////////////////////////////////////////////////////////////

console.log('=> Building')

var ninjaArgs = ['-C', outDir, 'v8_monolith'];
if (flags.jobs) {
	ninjaArgs.push('-j' + flags.jobs)
}
if (await exec('ninja', ninjaArgs) !== 0) {
	return
}

console.log('')

//////////////////////////////////////////////////////////////

console.log('=> Distributing')

const distDir = path.join(srcDir, 'out.mkv8', target)
const distLibDir = path.join(distDir, 'lib')

const origLibPath = path.join(outDir, 'obj', 'v8_monolith' + origlibExt)
const distLibPath = path.join(distLibDir, distLibPrefix + 'v8' + distLibExt)

var chFileC = 0

function copyDevFiles() {
	chFileC += copyIncDir(path.join(srcDir, 'include'), path.join(distDir, 'include'))

	if (copyNewFile(path.join(srcDir, 'LICENSE'), path.join(distDir, 'LICENSE'))) {
		chFileC++
	}

	if (chFileC === 0) {
		console.log('Already up to date.')
	}
	console.log('')

	console.log('=> Done (' + path.relative(srcDir, distDir) + ')')
}

if (
	!mkdir(distLibDir) &&
	fs.existsSync(distLibPath) &&
	fs.statSync(origLibPath).mtimeMs <= fs.statSync(distLibPath).mtimeMs
) {
	copyDevFiles()
	return
}

if (process.platform === 'win32' && !flags.gnu) {
	if (copyNewFile(origLibPath, distLibPath)) {
		chFileC++
	}
	copyDevFiles()
	return
}

const rawObjPaths = cp.execFileSync(ar, ['-t', origLibPath], {maxBuffer: 8 * 1024 * 1024}).toString().split('\n')

var objPaths = []
for (let i = 0; i < rawObjPaths.length - 1; i++) {
	const objPath = rawObjPaths[i].trim();
	if (objPath === '') {
		continue
	}
	objPaths.push(objPath)
}

if (objPaths.length <= 0) {
	console.error('Error: failed to read v8_monolith!')
	return
}

var child = cp.spawn(ar, ['-M']);
child.on('exit', async function(code) {
	if (code !== 0) {
		console.error('Error: failed to package obj files!')
		return
	}
	chFileC++

	const distLibPathSht = path.relative(srcDir, distLibPath)
	console.log('ar (thin to fat):', path.relative(srcDir, origLibPath), '->', distLibPathSht)

	await exec(ranlib, [distLibPath])
	console.log('ranlib:', distLibPathSht)

	copyDevFiles()
});

async function write(data) {
	await new Promise((resolve) => {
		child.stdin.write(data, () => {
			resolve()
		})
	})
}

await write('CREATE ' + distLibPath + '\n')
for (let i = 0; i < objPaths.length; i++) {
	await write('ADDMOD ' + objPaths[i] + '"\n')
}
await write('SAVE\n')
await write('END\n')
child.stdin.end()

})()
