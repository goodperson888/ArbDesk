import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { packageProfileCommands } from './package-profile-commands.mjs'

describe('package profile child processes', () => {
  it('runs every local CLI through Node instead of Windows cmd shims', () => {
    const root = 'workspace-root'
    const builderConfigPath = join(root, '.build', 'electron-builder.json')
    const commands = packageProfileCommands({
      root,
      builderConfigPath,
      target: 'win',
      skipChecks: false,
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe'
    })

    expect(commands).toHaveLength(4)
    expect(commands.every((command) => command.command === 'C:\\Program Files\\nodejs\\node.exe')).toBe(true)
    expect(commands.map((command) => command.args[0])).toEqual([
      join(root, 'node_modules', 'vitest', 'vitest.mjs'),
      join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
      join(root, 'node_modules', 'electron-builder', 'cli.js')
    ])
    expect(JSON.stringify(commands)).not.toMatch(/npm\.cmd|npx\.cmd/)
    expect(commands.at(-1)?.args).toEqual([
      join(root, 'node_modules', 'electron-builder', 'cli.js'),
      '--config',
      builderConfigPath,
      '--win',
      '--publish',
      'never'
    ])
  })

  it('skips duplicate checks in CI and keeps directory packaging cross-platform', () => {
    const root = 'workspace-root'
    const builderConfigPath = join(root, '.build', 'electron-builder.json')
    const commands = packageProfileCommands({
      root,
      builderConfigPath,
      target: 'dir',
      skipChecks: true,
      nodeExecutable: '/usr/local/bin/node'
    })

    expect(commands).toEqual([{
      command: '/usr/local/bin/node',
      args: [
        join(root, 'node_modules', 'electron-builder', 'cli.js'),
        '--config',
        builderConfigPath,
        '--dir',
        '--publish',
        'never'
      ]
    }])
  })
})
