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
	console.log(`Error: failed to read "${verFilePath}"!`)
	return
}

const verFileDataLines = verFileData.split('\n')
if (verFileDataLines.length < 4) {
	console.log(`Error: failed to parse "${verFilePath}"!`)
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

var target = `v${majorVer}.${minorVer}.${buildNum}.${patchLv}-${plat}-${arch}`

const outDir = path.join(srcDir, 'out.mkv8', '.original', target)
const objDir = path.join(outDir, 'obj')

const distDir = path.join(srcDir, 'out.mkv8', target)
const libDir = path.join(distDir, 'lib')

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

var chFileC = 0

function copyDevFiles() {
	chFileC += copyIncDir(path.join(srcDir, 'include'), path.join(distDir, 'include'))
	chFileC += copyNewFile(path.join(srcDir, 'LICENSE'), path.join(distDir, 'LICENSE'))

	if (chFileC === 0) {
		console.log('Already up to date.')
	}
	console.log('')

	console.log('=> Done (' + path.relative(srcDir, distDir) + ')')
}

;(async () => {

console.log('=> Configuring')

var gn, libPrefix, libExt, ar
if (process.platform === 'win32') {
	process.env['DEPOT_TOOLS_WIN_TOOLCHAIN'] = '0'
	gn = 'gn.bat'
	libPrefix = ''
	libExt = '.lib'
	ar = path.join(path.dirname(__dirname), 'tools', 'ar')
} else {
	gn = 'gn'
	libPrefix = 'lib'
	libExt = '.a'
	ar = 'ar'
}

if (await exec(
	gn,
	[
		'gen',
		outDir,
		`--args=is_debug=false symbol_level=0 is_component_build=false v8_monolithic=true v8_use_external_startup_data=false treat_warnings_as_errors=false v8_enable_i18n_support=false target_cpu="${arch}" v8_target_cpu="${arch}"`
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

const thinLibPath = path.join(outDir, 'obj', 'v8_monolith') + libExt
const rawObjPaths = cp.execFileSync(ar, ['-t', thinLibPath], {maxBuffer: 8 * 1024 * 1024}).toString().split('\n')

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

const libPath = path.join(libDir, libPrefix + 'v8' + libExt)

if (
	!mkdir(libDir) &&
	fs.existsSync(libPath) &&
	fs.statSync(thinLibPath).mtimeMs <= fs.statSync(libPath).mtimeMs
) {
	copyDevFiles()
	return
}

var child = cp.spawn(ar, ['-M']);
child.on('exit', function(code) {
	if (code !== 0) {
		console.error('Error: failed to package obj files!')
		return
	}
	chFileC++
	console.log('ar:', path.relative(srcDir, thinLibPath), '->', path.relative(srcDir, libPath))
	copyDevFiles()
});

child.stdin.write('CREATE ' + libPath + '\n')
for (let i = 0; i < objPaths.length; i++) {
	child.stdin.write('ADDMOD ' + objPaths[i] + '"\n')
}
child.stdin.write('SAVE\n')
child.stdin.write('END\n')
child.stdin.end()

})()
