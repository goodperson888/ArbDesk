import { join } from 'node:path'

export function packageProfileCommands({
  root,
  builderConfigPath,
  target,
  skipChecks,
  nodeExecutable = process.execPath
}) {
  const localCli = (...parts) => join(root, 'node_modules', ...parts)
  const commands = []
  if (!skipChecks) {
    commands.push(
      { command: nodeExecutable, args: [localCli('vitest', 'vitest.mjs'), 'run'] },
      { command: nodeExecutable, args: [localCli('typescript', 'bin', 'tsc'), '--noEmit'] },
      { command: nodeExecutable, args: [localCli('electron-vite', 'bin', 'electron-vite.js'), 'build'] }
    )
  }
  commands.push({
    command: nodeExecutable,
    args: [
      localCli('electron-builder', 'cli.js'),
      '--config',
      builderConfigPath,
      target === 'dir' ? '--dir' : `--${target}`,
      '--publish',
      'never'
    ]
  })
  return commands
}
