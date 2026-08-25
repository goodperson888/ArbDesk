import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Windows package workflow', () => {
  it('允许手动选择专用或全量 Profile，并生成不冲突的安装包名', async () => {
    const workflow = await readFile(resolve(process.cwd(), '.github/workflows/build-windows.yml'), 'utf8')
    const packageScript = await readFile(resolve(process.cwd(), 'scripts/package-profile.mjs'), 'utf8')

    expect(workflow).toContain('market_profile:')
    expect(workflow).toContain('type: choice')
    expect(workflow).toContain('- btc-gate-kalshi')
    expect(workflow).toContain('- btc-all')
    expect(workflow).toContain('MARKET_PROFILE: ${{ inputs.market_profile }}')
    expect(workflow).not.toContain('path: release/btc-gate-kalshi/*.exe')
    expect(packageScript).toContain('ArbDesk-${profileId}-Setup-\\${version}.\\${ext}')
  })
})
