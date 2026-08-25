import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const valueFor = (name, fallback) => {
  const argument = args.find((item) => item.startsWith(`--${name}=`))
  return argument ? argument.slice(name.length + 3) : fallback
}
const profileId = valueFor('profile', 'btc-all')
const target = valueFor('target', 'dir')
const skipChecks = args.includes('--skip-checks')
if (!/^[a-z0-9][a-z0-9_-]*$/i.test(profileId)) throw new Error(`非法 Profile 名称：${profileId}`)
if (!['dir', 'mac', 'win'].includes(target)) throw new Error(`不支持的打包目标：${target}`)

const profilePath = join(root, 'config', 'market-profiles', `${profileId}.json`)
const profile = JSON.parse(await readFile(profilePath, 'utf8'))
const knownVenues = new Set(['MEXC', 'POLYMARKET', 'LIMITLESS', 'PREDICT_FUN', 'GATE', 'KALSHI'])
if (!profile || typeof profile !== 'object' || profile.id !== profileId) throw new Error(`Profile id 与文件名不一致：${profileId}`)
if (!Array.isArray(profile.subjects) || profile.subjects.length === 0) throw new Error('Profile subjects 不能为空')
if (!Array.isArray(profile.intervals) || profile.intervals.length === 0 || profile.intervals.some((item) => !/^\d+(m|h|d)$/i.test(item))) throw new Error('Profile intervals 无效')
if (!Array.isArray(profile.venues) || profile.venues.length === 0 || profile.venues.some((item) => !knownVenues.has(String(item).toUpperCase()))) throw new Error('Profile venues 无效')
if (!Array.isArray(profile.routes) || profile.routes.length === 0) throw new Error('Profile routes 不能为空')

const buildDirectory = join(root, '.build')
const profileResourcePath = join(buildDirectory, 'market-profile.json')
const builderConfigPath = join(buildDirectory, `electron-builder-${profileId}.json`)
await mkdir(buildDirectory, { recursive: true })
await writeFile(profileResourcePath, JSON.stringify(profile, null, 2), 'utf8')

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const releaseRoot = resolve(root, 'release')
const outputDirectory = resolve(releaseRoot, profileId)
if (!outputDirectory.startsWith(`${releaseRoot}${sep}`)) throw new Error('打包输出目录校验失败')
await rm(outputDirectory, { recursive: true, force: true })
const builderConfig = {
  ...packageJson.build,
  artifactName: `ArbDesk-${profileId}-Setup-\${version}.\${ext}`,
  directories: { ...packageJson.build.directories, output: outputDirectory },
  extraResources: [{ from: profileResourcePath, to: 'market-profile.json' }]
}
await writeFile(builderConfigPath, JSON.stringify(builderConfig, null, 2), 'utf8')

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} 失败（${result.status ?? 'unknown'}）`)
}

console.log(`Building market profile: ${profileId}`)
if (!skipChecks) {
  run(npm, ['run', 'test'])
  run(npm, ['run', 'build'])
}
const electronBuilderArgs = ['--config', builderConfigPath, target === 'dir' ? '--dir' : `--${target}`, '--publish', 'never']
run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-builder', ...electronBuilderArgs])
console.log(`Package written to ${outputDirectory}`)
